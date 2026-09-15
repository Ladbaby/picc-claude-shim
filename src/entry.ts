/**
 * Orchestrator for the Claude-shim entry point.
 *
 * Modes:
 *
 *   - `--print <prompt>`: one-shot. Spins up a fresh pi session, prints
 *     the assistant's final text, exits 0. No stream-json I/O.
 *
 *   - `--output-format stream-json --input-format stream-json`: the
 *     hapi integration target. Speaks the Claude Code SDK protocol;
 *     bridges stdin/stdout to a running pi session.
 *
 *   - Default: detect missing JSON flags. Local (TTY) mode is not
 *     supported and produces an explicit error.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  effortToThinkingLevel,
  parseClaudeArgs,
  printClaudeShapedHelp,
  type ClaudePermissionMode,
  type ClaudeShimOptions,
} from "./args.js";
import {
  appendSessionEntry,
  ensureHapiCompatibleSessionFile,
  type SessionFileState,
} from "./session-jsonl.js";
import {
  type PendingPermission,
  type TranslatorState,
  createTranslatorState,
  emitControlRequest,
  emitResult,
  emitSystemInit,
  handleAgentEvent as translateAgentEvent,
  handleClaudeInput,
  respondControlRequest,
  type SDKMessageOut,
} from "./translator.js";
import { fromClaudeToolName } from "./tool-names.js";
import { synthesizeUsageAndCost } from "./cost.js";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CLAUDE_CODE_VERSION_LINE } from "./version.js";

const PI_VERSION = CLAUDE_CODE_VERSION_LINE;

function logStartupBanner(opts: ClaudeShimOptions, mode: string): void {
  process.stderr.write(`pi-claude-shim ${PI_VERSION} mode=${mode}\n`);
  if (opts.unrecognized.length > 0) {
    process.stderr.write(
      `pi-claude-shim: ignoring unrecognized flags: ${opts.unrecognized.join(" ")}\n`,
    );
  }
}

/**
 * Decide whether the permission gate is open — i.e. whether the shim emits
 * `control_request` for tool calls and waits for a `control_response`.
 *
 * The Claude Agent SDK drives permissions through an in-process `canUseTool`
 * callback (not `--permission-prompt-tool stdio`), so the gate is open for
 * any permission mode that is *not* `bypassPermissions`. `bypassPermissions`
 * (the SDK's full-access mode, set via `--dangerously-skip-permissions`) skips
 * the round-trip entirely. Exported as a pure function so it can be unit-tested
 * without spinning up a session.
 */
export function computeGateOpen(
  permissionPromptTool: "stdio" | undefined,
  permissionMode: ClaudePermissionMode | undefined,
): boolean {
  return permissionMode !== "bypassPermissions";
}

function resolveCwd(): string {
  return process.env.CLAUDE_SHIM_CWD ?? process.cwd();
}

export async function runClaudeShim(argv: readonly string[]): Promise<number> {
  const opts = parseClaudeArgs(argv);
  if (opts.help) {
    printClaudeShapedHelp();
    return 0;
  }
  if (opts.version) {
    process.stdout.write(PI_VERSION + "\n");
    return 0;
  }

  const isPrint = opts.printPrompt !== undefined;
  const isStreamJson = opts.outputFormat === "stream-json";
  const isJson = opts.outputFormat === "json";

  if (isPrint) {
    logStartupBanner(opts, "print");
  } else if (isStreamJson) {
    logStartupBanner(opts, "stream-json");
  } else if (isJson) {
    logStartupBanner(opts, "json");
  } else {
    logStartupBanner(opts, "unsupported");
    process.stderr.write(
      "pi-claude-shim: local (TTY) mode is not supported. Use --print <prompt> or --output-format stream-json --input-format stream-json.\n",
    );
    return 1;
  }

  const cwd = resolveCwd();

  if (isPrint) return runPrintMode(opts, cwd);
  return runStreamJson(opts, cwd);
}

// =====================================================================
// --print <prompt> mode: one-shot text output
// =====================================================================

async function runPrintMode(opts: ClaudeShimOptions, cwd: string): Promise<number> {
  const buildResult = await buildPiSession(opts, cwd);
  if (!buildResult.ok) return writeBuildError(buildResult.error);

  const { session } = buildResult.value;
  let finalText = "";
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await session.prompt(opts.printPrompt ?? "");
  await waitForAgentSettle(session);
  process.stdout.write("\n");
  session.dispose();
  void finalText;
  return 0;
}

// =====================================================================
// stream-json mode: bidirectional NDJSON with pi
// =====================================================================

async function runStreamJson(opts: ClaudeShimOptions, cwd: string): Promise<number> {
  // The wire-level session id. If the SDK asked us to use a specific
  // session id (`--session-id`, from the `sessionId` query option), echo
  // that exact value in `init.session_id` and every message so t3code can
  // correlate it. Otherwise mint one up front. We no longer depend on the
  // (lazily-built) pi session's own id for the wire — that lets us emit
  // `system/init` immediately without waiting ~30s for the pi runtime.
  const wireSessionId = opts.sessionId ?? randomUUID();

  // Model name surfaced in `system/init` before the session exists. Per
  // assistant messages carry their real `model` from the pi event, so this
  // only needs to be plausible at init time.
  const initModelId = opts.model ?? "claude-sonnet";

  // 1. Permission gate: open for any non-bypass mode (the SDK drives
  //    permissions via an in-process canUseTool callback).
  const gateOpen = computeGateOpen(opts.permissionPromptTool, opts.permissionMode);

  // 2. Translator state (stdout emitter + buffers). Eager — needed to emit
  //    init and to answer control_requests as they arrive.
  const state: TranslatorState = createTranslatorState({
    cwd,
    modelId: initModelId,
    toolsAvailable: () => [],
    slashCommandsAvailable: () => [],
    permissionMode: opts.permissionMode ?? "default",
    includePartialMessages: opts.includePartialMessages ?? false,
  });

  // 3. Emit system/init NOW. This is the single most latency-sensitive
  //    message: T3 Code's capabilities probe awaits `initializationResult()`
  //    with a 25s budget and never sends a prompt. Building the pi session
  //    takes ~30s, so it MUST be deferred (below) or the probe times out.
  emitSystemInit(state, wireSessionId, {
    cwd,
    modelId: initModelId,
    toolsAvailable: () => [],
    slashCommandsAvailable: () => [],
    permissionMode: opts.permissionMode ?? "default",
  });

  // 4. Lazy pi session. Built only when a user message actually arrives.
  let session: AgentSession | null = null;
  let sessionModelId = initModelId;
  let sessionFile: SessionFileState | null = null;
  let sessionBuilt = false;
  let agentEnded = false;
  let buildPromise: Promise<void> | null = null;
  let runErrored = false;
  let firstMessage = true;

  const pending = new Map<string, PendingPermission>();

  const permissionAsk = async (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > => {
    if (!gateOpen) return { behavior: "allow" };
    const requestId = emitControlRequest(state, toolName, input, toolCallId);
    return new Promise((resolve) => {
      pending.set(requestId, {
        requestId,
        toolName,
        toolCallId,
        input,
        resolve: (result) => {
          resolve(result);
          pending.delete(requestId);
        },
      });
    });
  };

  // Subscribe the (just-built) session to pi events and translate them.
  const wireSessionEvents = (s: AgentSession): void => {
    s.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "error") {
        runErrored = true;
      }
      translateAgentEvent(state, event, {
        cwd,
        modelId: sessionModelId,
        toolsAvailable: () => listActiveToolsLowercase(s),
        slashCommandsAvailable: () => [],
        permissionMode: opts.permissionMode ?? "default",
      }, gateOpen ? permissionAsk : undefined);

      if (event.type === "agent_end") {
        agentEnded = true;
        if (sessionFile) {
          appendSessionEntry(sessionFile, {
            kind: "system",
            message: { role: "system", content: "agent_end" },
            sessionId: s.sessionId,
            cwd,
          });
        }
        return;
      }
      if (event.type === "message_end" && sessionFile) {
        const message = event.message;
        appendSessionEntry(sessionFile, {
          kind: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
          message: {
            role: message.role,
            content: (message as { content?: unknown }).content,
          },
          sessionId: s.sessionId,
          cwd,
        });
      }
    });
  };

  // Build the pi session exactly once; concurrent user messages share it.
  const ensureSession = (): Promise<void> => {
    if (!buildPromise) {
      buildPromise = (async () => {
        const buildResult = await buildPiSession(opts, cwd);
        if (!buildResult.ok) throw new Error(buildResult.error);
        const s = buildResult.value.session;
        session = s;
        sessionModelId = describeModelId(s);
        sessionFile = ensureHapiCompatibleSessionFile({
          cwd,
          sessionId: s.sessionId,
          modelId: sessionModelId,
        });
        wireSessionEvents(s);
        sessionBuilt = true;
      })();
    }
    return buildPromise;
  };

  // 5. Read NDJSON from stdin.
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      handleClaudeInput(line, {
        pendingPermissions: pending,
        respondControlRequest: (requestId: string, request: { subtype: string; [k: string]: unknown }) => {
          try {
            respondControlRequest(state, requestId, request);
          } catch (e) {
            process.stderr.write(
              `pi-claude-shim: control_request ${request.subtype} failed: ${(e as Error).message}\n`,
            );
          }
        },
        onUserMessage: (text: string) => {
          // Kick off the (one-time) pi session build, then prompt. The probe
          // never reaches here, so this ~30s cost is paid only for real runs.
          void (async () => {
            try {
              await ensureSession();
              if (!session || !sessionFile) return;
              appendSessionEntry(sessionFile, {
                kind: "user",
                message: { role: "user", content: text },
                sessionId: session.sessionId,
                cwd,
              });
              const streamBehavior = firstMessage ? undefined : ("followUp" as const);
              firstMessage = false;
              await session.prompt(text, streamBehavior ? { streamingBehavior: streamBehavior } : {});
            } catch (e) {
              runErrored = true;
              agentEnded = true; // unblock the wait; final result reports the error
              process.stderr.write(`pi-claude-shim: session failed: ${(e as Error).message}\n`);
            }
          })();
        },
      });
    } catch (e) {
      process.stderr.write(`pi-claude-shim: stdin handler error: ${(e as Error).message}\n`);
    }
  });

  let stdinClosed = false;
  rl.on("close", () => {
    stdinClosed = true;
  });

  // 6. Wait for BOTH stdin close AND (no session built, or agent finished).
  //    A probe sends no user message, so sessionBuilt stays false and we
  //    resolve as soon as stdin closes — no 90s stall.
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (stdinClosed && (!sessionBuilt || agentEnded)) {
        clearInterval(interval);
        resolve();
      }
    }, 25);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 90_000);
    void timer;
    // Resolve immediately if stdin is already closed and nothing to do.
    if (stdinClosed && !sessionBuilt) {
      clearInterval(interval);
      resolve();
    }
  });

  // 7. Synthesis + final `result` (zeros if no session was ever built).
  //    Cast to sidestep TS narrowing the closure-mutated `session` to `never`.
  const sRef = session as AgentSession | null;
  const stats =
    sRef && typeof sRef.getSessionStats === "function"
      ? sRef.getSessionStats()
      : undefined;
  const synthesis = synthesizeUsageAndCost(stats, state.emitter.startedAtMs, sessionModelId);
  emitResult(state, synthesis, wireSessionId, runErrored, false);

  // 8. Cleanup.
  rl.close();
  if (sRef) sRef.dispose();
  void state;
  return 0;
}

function writeBuildError(msg: string): number {
  process.stderr.write(`pi-claude-shim: ${msg}\n`);
  return 1;
}

/**
 * Wait for both stdin to close AND the agent to be idle. We exit after
 * whichever happens later — in practice, hapi closes stdin to signal
 * "no more messages", and we wait for any in-flight turn to finish.
 */
async function waitForStreamJsonCompletion(session: AgentSession): Promise<void> {
  // Naïve loop: poll isStreaming. The Claude SDK agent terminates when
  // the parent writes a close, so we also accept stdin EOF as a finish
  // trigger via the rl.on("close") above; the agent may still be busy
  // running the last prompt. We bridge the two with a single waiter.
  await waitForAgentSettle(session);
}

async function waitForAgentSettle(session: AgentSession): Promise<void> {
  let safety = 0;
  while (session.isStreaming) {
    await new Promise((r) => setTimeout(r, 25));
    safety += 1;
    if (safety > 60_000_000 / 25) break; // ~1 minute cap
  }
}

// =====================================================================
// Pi session construction
// =====================================================================

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface SessionRuntime {
  session: AgentSession;
}

async function buildPiSession(
  opts: ClaudeShimOptions,
  cwd: string,
): Promise<Result<SessionRuntime>> {
  let settingsManager;
  try {
    settingsManager = SettingsManager.create(cwd);
  } catch (e) {
    return {
      ok: false,
      error: `failed to load settings: ${(e as Error).message}`,
    };
  }

  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
  };
  if (opts.systemPrompt !== undefined) {
    const sp = opts.systemPrompt;
    loaderOptions.systemPromptOverride = () => sp;
  }
  if (opts.appendSystemPrompt !== undefined) {
    const ap = opts.appendSystemPrompt;
    loaderOptions.appendSystemPromptOverride = (base) => [...base, ap];
  }
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();

  const sessionManager = await (async () => {
    if (opts.resume) {
      // Resolve the specific session id to its file, then open it. Fall
      // back to a fresh session if the id is not found.
      try {
        const infos = await SessionManager.list(cwd);
        const match = infos.find((info) => info.id === opts.resume);
        if (match) return SessionManager.open(match.path, undefined, cwd);
      } catch {
        // fall through to a fresh session
      }
      return SessionManager.create(cwd);
    }
    if (opts.continueConversation) {
      try {
        return SessionManager.continueRecent(cwd);
      } catch {
        return SessionManager.create(cwd);
      }
    }
    return SessionManager.create(cwd);
  })();

  const allowed = opts.allowedTools
    .map((t) => fromClaudeToolName(t) ?? t.toLowerCase())
    .filter((t) => t.length > 0);
  const disallowed = opts.disallowedTools
    .map((t) => fromClaudeToolName(t) ?? t.toLowerCase())
    .filter((t) => t.length > 0);

  void opts.model;
  void opts.maxTurns;
  void effortToThinkingLevel(opts.effort);

  try {
    const modelRuntime = await ModelRuntime.create();
    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
      modelRuntime,
      thinkingLevel: effortToThinkingLevel(opts.effort),
    };
    if (allowed.length > 0) createOpts.tools = allowed;
    if (disallowed.length > 0) createOpts.excludeTools = disallowed;

    const { session } = await createAgentSession(createOpts);
    return { ok: true, value: { session } };
  } catch (e) {
    return {
      ok: false,
      error: `failed to create pi session: ${(e as Error).message}`,
    };
  }
}

function describeModelId(session: AgentSession): string {
  const m = session.model;
  if (!m) return "unknown";
  return `${(m as { provider?: string }).provider ?? "unknown"}/${(m as { id?: string }).id ?? "unknown"}`;
}

function listActiveToolsLowercase(session: AgentSession): string[] {
  const tools = (session.agent.state.tools ?? []) as Array<{ name?: string }>;
  return tools.map((t) => t.name ?? "unknown");
}

// Re-export to keep the SDK surface covered for unit tests.
export type { SDKMessageOut } from "./translator.js";
