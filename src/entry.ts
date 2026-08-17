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
  type SDKMessageOut,
} from "./translator.js";
import { fromClaudeToolName } from "./tool-names.js";
import { createInterface } from "node:readline";

const PI_VERSION = "0.0.1-pi-claude-shim";

function logStartupBanner(opts: ClaudeShimOptions, mode: string): void {
  process.stderr.write(`pi-claude-shim ${PI_VERSION} mode=${mode}\n`);
  if (opts.unrecognized.length > 0) {
    process.stderr.write(
      `pi-claude-shim: ignoring unrecognized flags: ${opts.unrecognized.join(" ")}\n`,
    );
  }
}

/**
 * Translate Claude's permission modes onto a wire-gate boolean:
 *   - `bypassPermissions` → gate closed (do not ask)
 *   - everything else      → gate open
 */
function gateIsOpen(mode: ClaudePermissionMode | undefined): boolean {
  return mode !== "bypassPermissions";
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
  const buildResult = await buildPiSession(opts, cwd);
  if (!buildResult.ok) return writeBuildError(buildResult.error);

  const { session } = buildResult.value;
  const modelId = describeModelId(session);

  // 1. The hapi-compatible session JSONL must exist before any
  //    `system/init` line is emitted.
  const sessionFile = ensureHapiCompatibleSessionFile({
    cwd,
    sessionId: session.sessionId,
    modelId,
  });

  // 2. Permission gate wiring: skip when bypassPermissions, otherwise
  //    block in `handleAgentEvent` permission flow via control_request.
  const gateOpen = gateIsOpen(opts.permissionMode);

  // 3. Build a stdio writer + translator state.
  const state: TranslatorState = createTranslatorState({
    cwd,
    modelId,
    toolsAvailable: () => listActiveToolsLowercase(session),
    slashCommandsAvailable: () => [],
    permissionMode: opts.permissionMode ?? "default",
  });

  // 4. Pending permissions map shared between stdin reader and the
  //    permission-ask callback. When the parent replies with
  //    `control_response`, we resolve the pending promise and unblock
  //    the agent loop.
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
          // If the parent passes `updatedInput`, the translator (via
          // the entry's tool_call handler) will mutate the live input
          // object. Here we just relay.
          resolve(result);
          pending.delete(requestId);
        },
      });
    });
  };

  // 5. Subscribe to pi events.
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    translateAgentEvent(state, event, {
      cwd,
      modelId,
      toolsAvailable: () => listActiveToolsLowercase(session),
      slashCommandsAvailable: () => [],
      permissionMode: opts.permissionMode ?? "default",
    }, gateOpen ? permissionAsk : undefined);

    // Mirror completed messages into the hapi session JSONL.
    if (event.type === "message_end") {
      const message = event.message;
      appendSessionEntry(sessionFile, {
        kind: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
        message: {
          role: message.role,
          content: (message as { content?: unknown }).content,
        },
        sessionId: session.sessionId,
        cwd,
      });
    } else if (event.type === "agent_end") {
      appendSessionEntry(sessionFile, {
        kind: "system",
        message: { role: "system", content: "agent_end" },
        sessionId: session.sessionId,
        cwd,
      });
    }
  });

  // 6. Emit system/init now that we have the session id.
  emitSystemInit(state, session.sessionId, {
    cwd,
    modelId,
    toolsAvailable: () => listActiveToolsLowercase(session),
    slashCommandsAvailable: () => [],
    permissionMode: opts.permissionMode ?? "default",
  });

  // 7. Read NDJSON from stdin.
  const rl = createInterface({ input: process.stdin });
  let firstMessage = true;
  const stdinPromise = new Promise<void>((resolveStdin) => {
    let stdinClosed = false;
    rl.on("line", (line) => {
      if (line.trim().length === 0) return;
      try {
        handleClaudeInput(line, {
          pendingPermissions: pending,
          onUserMessage: (text: string) => {
            appendSessionEntry(sessionFile, {
              kind: "user",
              message: { role: "user", content: text },
              sessionId: session.sessionId,
              cwd,
            });
            // The first message drives the initial agent run.
            // Subsequent messages use followUp so they queue behind
            // an in-flight turn. hapi always sends `prompt` only once
            // per session in remote mode and uses control_request for
            // tool permissions — but it's safe to accept multiple user
            // messages here.
            const streamBehavior = firstMessage
              ? undefined
              : ("followUp" as const);
            firstMessage = false;
            void session
              .prompt(text, streamBehavior ? { streamingBehavior: streamBehavior } : {})
              .catch((e: unknown) => {
                process.stderr.write(
                  `pi-claude-shim: prompt failed: ${(e as Error).message}\n`,
                );
              });
          },
        });
      } catch (e) {
        process.stderr.write(
          `pi-claude-shim: stdin handler error: ${(e as Error).message}\n`,
        );
      }
    });
    rl.on("close", () => {
      stdinClosed = true;
      resolveStdin();
    });
    void stdinClosed;
  });
  void stdinPromise;

  // 8. Wait for BOTH stdin close AND agent_end before synthesizing the
  //    final `result`. The race: hapi closes stdin first to signal
  //    "no more inputs"; the agent may still have a turn running.
  let stdinClosed = false;
  let agentEnded = false;
  rl.on("close", () => {
    stdinClosed = true;
  });

  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const check = () => {
      if (stdinClosed && agentEnded) {
        if (timer) clearTimeout(timer);
        resolve();
      }
    };
    const unsub2 = session.subscribe((ev) => {
      if (ev.type === "agent_end") {
        agentEnded = true;
        check();
      }
    });
    const interval = setInterval(check, 25);
    // Safety: resolve after 90s even if signals arrive out of order.
    timer = setTimeout(() => {
      clearInterval(interval);
      unsub2();
      resolve();
    }, 90_000);
    check();
  });

  // 10. Synthesis + final `result`.
  const stats = typeof session.getSessionStats === "function"
    ? session.getSessionStats()
    : undefined;
  const synthesis = (await import("./cost.js")).synthesizeUsageAndCost(
    stats,
    state.emitter.startedAtMs,
    modelId,
  );
  emitResult(state, synthesis, session.sessionId, false, false);

  // 11. Cleanup.
  rl.close();
  unsubscribe();
  session.dispose();
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

  const sessionManager = (() => {
    if (opts.resume || opts.continueConversation) {
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
