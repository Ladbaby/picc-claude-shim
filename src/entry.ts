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
  emitCompactBoundary,
  emitControlRequest,
  emitResult,
  emitSystemInit,
  handleAgentEvent as translateAgentEvent,
  handleClaudeInput,
  respondControlRequest,
  type SDKMessageOut,
} from "./translator.js";
import { fromClaudeToolName } from "./tool-names.js";
import {
  createAskUserQuestionTool,
  type AskUserQuestionHost,
  type AskUserQuestionOutcome,
} from "./ask-user-question.js";
import { synthesizeUsageAndCost } from "./cost.js";
import { extractStructuredOutput } from "./structured-output.js";
import { resolveSkillExpansion } from "./skills.js";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getClaudeCodeVersion } from "./version.js";

const PI_VERSION = `${getClaudeCodeVersion()} (Claude Code)`;

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

/**
 * Recognize a host-side `/compact` invocation. T3 Code sends the slash
 * command as a plain user message (exactly the text `/compact`, or
 * `/compact <custom instructions>`), mirroring how real Claude Code's host
 * SDK delivers it. Returns `null` when the message is NOT a compact command
 * (so it is forwarded to pi as an ordinary prompt), otherwise the trimmed
 * custom instructions (or `undefined` for a bare `/compact`).
 */
export function parseCompactCommand(text: string): string | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "/compact") return undefined;
  if (trimmed.startsWith("/compact ")) {
    const rest = trimmed.slice("/compact ".length).trim();
    return rest.length > 0 ? rest : undefined;
  }
  return null;
}

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

  // Gate each tool call by the mode selected at process startup. Runtime
  // `set_permission_mode` requests are acknowledged on the control channel;
  // pi cannot safely replace this session's extension configuration mid-run.
  const gateOpen = computeGateOpen(opts.permissionPromptTool, opts.permissionMode);
  // Claude Code's --allowedTools is a pre-approval rule list. Keep this
  // separate from pi's active-tool selection, which is handled when the
  // session is constructed below.
  const allowedToolNames = new Set(
    opts.allowedTools
      .map((name) => fromClaudeToolName(name) ?? name)
      .filter((name) => name.length > 0)
      .map((name) => name.toLowerCase()),
  );

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
  /**
   * True while a `/compact` is running. A compact is not a prompt: it must not
   * be appended to the session transcript as a user turn (that would defeat
   * the compaction), and two compacts can't run at once (pi's `compact()`
   * aborts any in-flight run first, so a second call would interrupt the
   * first).
   */
  let compactInFlight = false;

  const pending = new Map<string, PendingPermission>();
  let cancellationPromise: Promise<void> | null = null;
  let cancellationRequested = false;

  /**
   * Stop the parent turn when the host interrupts it or tears down stdin.
   * Aborting the parent session propagates its current tool AbortSignal to a
   * foreground Agent subagent; session shutdown below aborts background agents.
   */
  const cancelActiveRun = (): Promise<void> => {
    cancellationRequested = true;
    if (cancellationPromise) return cancellationPromise;
    for (const pendingPermission of pending.values()) {
      pendingPermission.resolve({ behavior: "deny", message: "cancelled by client" });
    }
    pending.clear();
    cancellationPromise = session?.abort().catch((error: unknown) => {
      process.stderr.write(`pi-claude-shim: abort failed: ${String(error)}\n`);
    }) ?? Promise.resolve();
    return cancellationPromise;
  };

  const permissionAsk = async (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > => {
    // Claude Code treats --allowedTools as pre-approved permission rules,
    // not as an activation allow-list. Match it before going to the host's
    // canUseTool callback. Full command-pattern matching is intentionally
    // deferred; exact tool-name rules are the safe common denominator and
    // cover hapi's MCP title tool plus normal SDK use.
    if (allowedToolNames.has(toolName.toLowerCase())) return { behavior: "allow" };
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
      if (event.type === "compaction_end") {
        // Pi can recover an overflow (the provider may have returned HTTP 400)
        // by compacting and continuing the same prompt. Surface that boundary
        // immediately, but never synthesize a Claude `result` for it: T3 Code
        // treats a result as the terminal state of its active turn.
        if (
          event.reason !== "manual" &&
          !event.aborted &&
          event.result !== undefined
        ) {
          emitCompactBoundary(state, wireSessionId, {
            trigger: "auto",
            preTokens: event.result.tokensBefore,
            postTokens: event.result.estimatedTokensAfter,
          });
        }
        return;
      }
      if (event.type === "agent_end") {
        // Do not end the wire turn here. `agent_end` occurs before pi performs
        // overflow recovery, so an HTTP 400 can be followed by automatic
        // compaction and a continuation. `agent_settled` is pi's definitive
        // signal that the prompt and every compact/retry have finished.
        //
        // A host-side `/compact` explicitly owns its result and aborts any
        // running agent operation first, so keep that abort out of this turn.
        if (compactInFlight) agentActive = false;
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
      if (event.type === "agent_settled") {
        if (agentActive && !compactInFlight) {
          agentActive = false;
          emitTurnResult();
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
        const askToolName = (fromClaudeToolName("AskUserQuestion") ?? "AskUserQuestion").toLowerCase();
        const buildResult = await buildPiSession(opts, cwd, undefined, wireSessionId, {
          request: (toolCallId, input) => {
            if (allowedToolNames.has(askToolName)) {
              return Promise.resolve(undefined);
            }
            const requestId = emitControlRequest(state, "AskUserQuestion", input as Record<string, unknown>, toolCallId);
            return new Promise<AskUserQuestionOutcome>((resolve) => {
              pending.set(requestId, {
                requestId,
                toolName: "AskUserQuestion",
                toolCallId,
                input: input as Record<string, unknown>,
                resolve: (r) => {
                  pending.delete(requestId);
                  if (r.behavior === "allow" && r.updatedInput) {
                    resolve({ answers: (r.updatedInput.answers ?? {}) as Record<string, string | string[]> });
                  } else {
                    resolve({ declineMessage: "User declined to answer questions" });
                  }
                },
              });
            });
          },
        });
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
        process.stderr.write(
          `pi-claude-shim: pi session ready with tools: ${listActiveToolsLowercase(s).join(", ") || "(none)"}\n`,
        );
      })();
    }
    return buildPromise;
  };

  // 4b. Handle a host-side `/compact`. T3 Code (and real Claude Code's host
  //     SDK) deliver `/compact` as a plain user message; real Claude Code's
  //     harness intercepts it, runs a real compaction, and emits a
  //     `compact_boundary` system message plus a terminal `result`. pi does
  //     NOT know about `/compact` — fed as a prompt it just gets answered as
  //     prose and no compaction happens. So we intercept it here and drive
  //     pi's own `session.compact()`, then emit the same messages the host
  //     expects to settle the compaction.
  const handleCompactCommand = async (customInstructions: string | undefined): Promise<void> => {
    if (compactInFlight) return; // a compact already running; drop the duplicate
    try {
      await ensureSession();
      if (!session) return;
      compactInFlight = true; // guard the agent_end handler against the abort() inside compact()
      try {
        const result = await session.compact(customInstructions);
        // The `compact_boundary` is what T3 reads to (a) render the "Context
        // compacted" divider and (b) settle its compaction wait. `pre_tokens`
        // comes from pi; `post_tokens` (estimatedTokensAfter) is a shim-added
        // field T3 uses for the before→after token summary.
        emitCompactBoundary(state, wireSessionId, {
          trigger: "manual",
          preTokens: result.tokensBefore,
          postTokens: result.estimatedTokensAfter,
        });
        // A terminal `result` so the `/compact` turn completes in the host
        // (Claude Code always ends a submitMessage with one, even when it
        // didn't call the model for the main conversation). No assistant text.
        state.emitter.lastFlushedText = "";
        const stats =
          typeof session.getSessionStats === "function" ? session.getSessionStats() : undefined;
        const synthesis = synthesizeUsageAndCost(stats, sessionStartMs, sessionModelId);
        emitResult(state, synthesis, wireSessionId, false, false);
        turnResultsEmitted += 1;
      } catch (e) {
        // "Nothing to compact (session too small)" / "Already compacted" /
        // LLM error. Emit an error result so the turn isn't silently dropped.
        const stats =
          typeof session.getSessionStats === "function" ? session.getSessionStats() : undefined;
        const synthesis = synthesizeUsageAndCost(stats, sessionStartMs, sessionModelId);
        emitResult(state, synthesis, wireSessionId, true, false);
        turnResultsEmitted += 1;
        process.stderr.write(`pi-claude-shim: compact failed: ${(e as Error).message}\n`);
      } finally {
        compactInFlight = false;
      }
    } catch (e) {
      compactInFlight = false;
      process.stderr.write(`pi-claude-shim: compact setup failed: ${(e as Error).message}\n`);
    }
  };

  /**
   * Expand a `/<skill>` turn into the prompt Claude Code would send, or `null`
   * when `text` is not an invocation of a discovered claude skill.
   *
   * Real Claude Code intercepts a leading `/name` and expands it from the
   * SKILL.md body (Base-directory prefix + argument substitution). T3 rewrites
   * a `$skill` mention into exactly that text and sends it as an ordinary turn;
   * without this, pi would answer `/skill …` as prose. Only the LAST text block
   * can be a skill invocation (earlier `/…` are prose), and leading whitespace
   * is not an invocation — mirroring both Claude Code and T3's dispatch.
   */
  const expandSkillTurn = async (text: string): Promise<string | null> => {
    const lastBlock = text.split("\n\n").pop()?.trim() ?? text;
    if (!lastBlock.startsWith("/")) return null;
    const firstLine = lastBlock.split("\n", 1)[0];
    if (!firstLine.startsWith("/")) return null;
    const space = firstLine.indexOf(" ");
    const name = space === -1 ? firstLine.slice(1) : firstLine.slice(1, space);
    const args = space === -1 ? "" : firstLine.slice(space + 1);
    if (!name) return null;
    // Never treat the built-in control command as a skill.
    if (name === "compact") return null;
    return (await resolveSkillExpansion(cwd, name, args, session?.sessionId ?? "")) ?? null;
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
        onInterrupt: () => {
          void cancelActiveRun();
        },
        onUserMessage: (text: string) => {
          // A later user turn after an interrupt is a fresh run.
          cancellationRequested = false;
          cancellationPromise = null;
          // Host-side `/compact`: run a real pi compaction and emit the
          // compact_boundary + result the host settles on — do NOT forward it
          // to pi as a prompt (that would be answered as prose, not compact).
          const compactInstructions = parseCompactCommand(text);
          if (compactInstructions !== null) {
            void handleCompactCommand(compactInstructions);
            return;
          }
          // Kick off the (one-time) pi session build, then prompt. The probe
          // never reaches here, so this ~30s cost is paid only for real runs.
          void (async () => {
            try {
              await ensureSession();
              if (!session || !sessionFile || cancellationRequested) return;
              // A `/<skill>` turn is expanded into the prompt Claude Code would
              // have sent (SKILL.md body + args). The transcript still records
              // the raw `text` the user typed — Claude Code does the same.
              const promptText = (await expandSkillTurn(text)) ?? text;
              appendSessionEntry(sessionFile, {
                kind: "user",
                message: { role: "user", content: text },
                sessionId: session.sessionId,
                cwd,
              });
              const streamBehavior = firstMessage ? undefined : ("followUp" as const);
              firstMessage = false;
              await session.prompt(promptText, streamBehavior ? { streamingBehavior: streamBehavior } : {});
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
    void cancelActiveRun();
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

  // 8. Cleanup. Tell extensions the session is ending before disposal so
  // picc-subagents can abort background/queued agents via session_shutdown.
  rl.close();
  if (sRef) {
    try {
      await sRef.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // Best effort: session disposal still releases the parent operation.
    }
    sRef.dispose();
  }
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
  askHost?: AskUserQuestionHost,
): Promise<Result<SessionRuntime>> {
  const agentDir = getAgentDir();
  let settingsManager;
  try {
    // Keep SettingsManager and DefaultResourceLoader on the same explicit
    // agent directory. Calling `SettingsManager.create(cwd)` alone lets it
    // derive a different global-config root from the spawned host's env,
    // which leaves packages/extensions (and therefore registered tools) out
    // of a headless shim session.
    settingsManager = SettingsManager.create(cwd, agentDir);
  } catch (e) {
    return {
      ok: false,
      error: `failed to load settings: ${(e as Error).message}`,
    };
  }

  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
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

  const disallowed = opts.disallowedTools
    .map((t) => fromClaudeToolName(t) ?? t)
    .filter((t) => t.length > 0);

  void opts.model;
  void opts.maxTurns;
  void effortToThinkingLevel(opts.effort);

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
      modelRuntime,
      thinkingLevel: effortToThinkingLevel(opts.effort),
    };
    if (noTools) createOpts.noTools = noTools;
    if (disallowed.length > 0) createOpts.excludeTools = disallowed;
    if (askHost) {
      createOpts.customTools = [createAskUserQuestionTool(askHost)];
    }

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
