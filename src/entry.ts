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
import { extractStructuredOutput } from "./structured-output.js";
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

  const isPrint = opts.printMode || opts.printPrompt !== undefined;
  const isStreamJson = opts.outputFormat === "stream-json";
  const isJson = opts.outputFormat === "json";

  // Banner precedence mirrors dispatch: json > stream-json > print. A bare
  // `-p` sets printMode, so json must win when both are present (t3code's
  // `claude -p --output-format json` text-gen path).
  if (isJson) {
    logStartupBanner(opts, "json");
  } else if (isStreamJson) {
    logStartupBanner(opts, "stream-json");
  } else if (isPrint) {
    logStartupBanner(opts, "print");
  } else {
    logStartupBanner(opts, "unsupported");
    process.stderr.write(
      "pi-claude-shim: local (TTY) mode is not supported. Use --print <prompt> or --output-format stream-json --input-format stream-json.\n",
    );
    return 1;
  }

  const cwd = resolveCwd();

  if (isJson) return runJsonMode(opts, cwd);
  if (isPrint) return runPrintMode(opts, cwd);
  return runStreamJson(opts, cwd);
}

// =====================================================================
// --output-format json mode: one-shot single-JSON-object output.
//
// Used by t3code's text generation (`claude -p --output-format json
// --json-schema <schema>`), where the prompt arrives on stdin and stdout
// must be a single JSON document. With `--json-schema`, we emit
// `{"structured_output": <value>}` (Shape A of t3code's parser). Without a
// schema we emit a Claude `result` message for callers that read `result`.
// =====================================================================

/** Read the entire stdin as UTF-8 text. */
async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function runJsonMode(opts: ClaudeShimOptions, cwd: string): Promise<number> {
  // Prompt: inline `--print` value if present, otherwise read stdin
  // (t3code's text-gen sends the prompt on stdin with a bare `-p`).
  const prompt = (opts.printPrompt ?? (await readStdinText())).trim();

  if (prompt.length === 0) {
    process.stderr.write("pi-claude-shim: empty prompt for --output-format json\n");
    return 1;
  }

  const wireSessionId = opts.sessionId ?? randomUUID();
  const buildResult = await buildPiSession(opts, cwd, "builtin", wireSessionId);
  if (!buildResult.ok) return writeBuildError(buildResult.error);

  const { session } = buildResult.value;
  let finalText = "";
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta;
    }
  });

  let exitCode = 0;
  try {
    await session.prompt(prompt);
    await waitForAgentSettle(session);
  } catch (e) {
    process.stderr.write(`pi-claude-shim: session failed: ${(e as Error).message}\n`);
    exitCode = 1;
  }

  const sessionId = session.sessionId;
  const startedAtMs = Date.now();

  if (opts.jsonSchema !== undefined) {
    const structured = extractStructuredOutput(finalText, opts.jsonSchema);
    process.stdout.write(JSON.stringify({ structured_output: structured }) + "\n");
  } else {
    // Plain json: a single Claude `result` message (the shape the CLI's
    // non-streaming `--output-format json` produces).
    const result = {
      type: "result",
      subtype: "success",
      result: finalText,
      session_id: sessionId,
      num_turns: 1,
      is_error: exitCode !== 0,
      duration_ms: Date.now() - startedAtMs,
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  }

  session.dispose();
  return exitCode;
}

// =====================================================================
// --print <prompt> mode: one-shot text output
// =====================================================================

async function runPrintMode(opts: ClaudeShimOptions, cwd: string): Promise<number> {
  const wireSessionId = opts.sessionId ?? randomUUID();
  const buildResult = await buildPiSession(opts, cwd, undefined, wireSessionId);
  if (!buildResult.ok) return writeBuildError(buildResult.error);

  const { session } = buildResult.value;
  let finalText = "";
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  // Bare `-p` (no inline value) delivers the prompt on stdin.
  const prompt = opts.printPrompt ?? (await readStdinText());
  await session.prompt(prompt.trim());
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
  // The wire-level session id. Precedence:
  //   1. `opts.resume` — on resume the host re-sends the previous wire id and
  //      (with no `--session-id`), so the wire id MUST stay equal to the id of
  //      the on-disk pi session we're about to open. Otherwise the resume
  //      reports a fresh id and the *next* resume misses.
  //   2. `opts.sessionId` — the host asked for a specific id (fresh session).
  //   3. mint one. We no longer depend on the (lazily-built) pi session's own
  //      id for the wire — that lets us emit `system/init` immediately without
  //      waiting ~30s for the pi runtime. The pi session is created with this
  //      exact id (see buildPiSession) so resume lookups match.
  const wireSessionId = opts.resume ?? opts.sessionId ?? randomUUID();

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
  let sessionStartMs = 0;
  let sessionBuilt = false;
  /**
   * True while a pi agent run (turn) is in flight — between `agent_start`
   * and a final `agent_end` (not a retry). Used as the exit gate: the process
   * stays alive while a turn is running, even after stdin closes, so a long
   * subagent turn isn't killed mid-flight.
   */
  let agentActive = false;
  /** Counts per-turn `result` messages emitted; a zero means no completed run. */
  let turnResultsEmitted = 0;
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
    // Emit a Claude `result` message for a completed run (turn). pi fires
    // `agent_start`…`agent_end` per run, and drains any queued follow-ups
    // (e.g. background-subagent completion notifications) before `agent_end`,
    // so one non-retry `agent_end` corresponds to one full Claude turn. We
    // synthesize usage from pi's cumulative session stats.
    const emitTurnResult = (): void => {
      const stats =
        typeof s.getSessionStats === "function" ? s.getSessionStats() : undefined;
      const synthesis = synthesizeUsageAndCost(stats, sessionStartMs, sessionModelId);
      emitResult(state, synthesis, wireSessionId, runErrored, false);
      turnResultsEmitted += 1;
    };

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

      if (event.type === "agent_start") {
        agentActive = true;
        return;
      }
      if (event.type === "agent_end") {
        // A retry (`willRetry`) keeps the same run going — do not treat it as a
        // turn boundary. A final `agent_end` closes the run; emit the result.
        if (!event.willRetry) {
          agentActive = false;
          emitTurnResult();
        }
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
        const buildResult = await buildPiSession(opts, cwd, undefined, wireSessionId);
        if (!buildResult.ok) throw new Error(buildResult.error);
        const s = buildResult.value.session;
        session = s;
        sessionModelId = describeModelId(s);
        sessionStartMs = Date.now();
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
              // A failed prompt may never fire `agent_end`; close the run and
              // emit an error result so the turn isn't silently dropped.
              agentActive = false;
              const stats =
                session && typeof session.getSessionStats === "function"
                  ? session.getSessionStats()
                  : undefined;
              const synthesis = synthesizeUsageAndCost(stats, sessionStartMs, sessionModelId);
              emitResult(state, synthesis, wireSessionId, true, false);
              turnResultsEmitted += 1; // count it so the trailing result isn't duplicated
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

  // 6. Keep the process alive until T3 closes stdin AND no turn is running.
  //    There is deliberately NO arbitrary lifetime cap: a real Claude Code
  //    process lives as long as its stdin is open, and a single turn can run
  //    far past 90s when it drives background subagents (which arrive as
  //    follow-up runs). T3 tears the session down by closing stdin.
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (stdinClosed && (!sessionBuilt || !agentActive)) {
        clearInterval(interval);
        resolve();
      }
    }, 25);
    // Resolve immediately if stdin is already closed and nothing to do.
    if (stdinClosed && !sessionBuilt) {
      clearInterval(interval);
      resolve();
    }
  });

  // 7. Final `result`. Every completed turn already emitted its own result
  //    (step 4), so only fill the gap: a probe (session never built) or a run
  //    that reached stdin-close without a completed `agent_end`.
  const sRef = session as AgentSession | null;
  const stats =
    sRef && typeof sRef.getSessionStats === "function"
      ? sRef.getSessionStats()
      : undefined;
  if (turnResultsEmitted === 0) {
    const synthesis = synthesizeUsageAndCost(stats, state.emitter.startedAtMs, sessionModelId);
    emitResult(state, synthesis, wireSessionId, runErrored, false);
  }

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
  noTools: "all" | "builtin" | undefined,
  wireSessionId: string,
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
  // T3 / headless path: pi only fires `session_start` from `bindExtensions`,
  // which the shim never calls (it builds the session via `createAgentSession`
  // directly). So the picc-permission-modes extension's `onSessionStart`
  // (where it would learn the permission mode from a flag) never runs, and its
  // gate would stay on "default" — auto-rejecting every non-allow tool call
  // even when the host selected "Full access". The extension's register
  // function DOES run during `loader.reload()` below, so we hand it the mode
  // through an env var that it reads at register time.
  if (opts.permissionMode) {
    process.env.PICC_PERMISSION_MODE = opts.permissionMode;
  }
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();

  // The wire session id (what the host reported in `init.session_id`) MUST
  // equal pi's on-disk session id, or `--resume <wireId>` can never find the
  // session the host remembers. pi mints its own uuid otherwise, so we pass
  // the wire id through as the session id whenever we create one.
  const newSessionOptions = { id: wireSessionId };

  const sessionManager = await (async () => {
    if (opts.resume) {
      // Resolve the specific session id to its file, then open it. The host
      // passes the wire id as `--resume`, which now matches pi's id. Fall
      // back to a fresh session (with the wire id) if the id is not found.
      try {
        const infos = await SessionManager.list(cwd);
        const match = infos.find((info) => info.id === opts.resume);
        if (match) return SessionManager.open(match.path, undefined, cwd);
      } catch {
        // fall through to a fresh session
      }
      return SessionManager.create(cwd, undefined, newSessionOptions);
    }
    if (opts.continueConversation) {
      try {
        return SessionManager.continueRecent(cwd);
      } catch {
        return SessionManager.create(cwd, undefined, newSessionOptions);
      }
    }
    return SessionManager.create(cwd, undefined, newSessionOptions);
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
    if (noTools) createOpts.noTools = noTools;
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
