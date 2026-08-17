/**
 * Bidirectional translator between pi's session events and Claude Code's
 * NDJSON wire protocol.
 *
 * ## Output (pi → Claude)
 *
 * pi's `AgentSession.subscribe()` emits:
 *   - `agent_start`, `agent_end`              (lifecycle, no Claude equivalent)
 *   - `turn_start`, `turn_end`                (no Claude equivalent)
 *   - `message_start`, `message_update`, `message_end`
 *   - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
 *
 * Claude's surface (`hapi/cli/src/claude/sdk/types.ts`) consumes:
 *   - `{type:"system",subtype:"init", session_id, model, cwd, tools, slash_commands}`
 *   - `{type:"user", message:{role:"user", content}}`
 *   - `{type:"assistant", message:{role:"assistant", content:[...]}}`
 *   - `{type:"result", subtype, result, num_turns, usage, total_cost_usd, session_id, ...}`
 *   - `{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, input}}`
 *   - `{type:"control_cancel_request", request_id}`
 *
 * The conversion is inherently buffering because pi streams token deltas
 * (text_delta / thinking_delta / toolcall_delta) while Claude writes the
 * full assembled content blocks.
 *
 * ## Input (Claude → pi)
 *
 * Stdin NDJSON messages:
 *   - `{type:"user", message:{role:"user", content}}`          → session.prompt()
 *   - `{type:"control_response", ...}`                         → resolve pending permission
 *   - `{type:"control_cancel_request", request_id}`            → abort permission
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { toClaudeToolName } from "./tool-names.js";
import {
  synthesizeUsageAndCost,
  type SynthesizedResultFields,
} from "./cost.js";

// =====================================================================
// Wire types (Claude Code protocol)
// =====================================================================

export interface SDKSystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
  mcp_servers?: unknown[];
  permission_mode?: string;
  [k: string]: unknown;
}

export interface SDKSystemStatus {
  type: "system";
  subtype: "status";
  status?: string;
  compact_result?: string;
  compact_error?: string;
  [k: string]: unknown;
}

export type SDKSystemMessage = SDKSystemInit | SDKSystemStatus | { type: "system"; subtype: string; [k: string]: unknown };

export interface SDKAssistantMessage {
  type: "assistant";
  parent_tool_use_id?: string | null;
  message: {
    role: "assistant";
    content: AssistantContentBlock[];
  };
}

export type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface SDKUserMessage {
  type: "user";
  parent_tool_use_id?: string | null;
  message: {
    role: "user";
    content: string | Array<{ type: string; [k: string]: unknown }>;
  };
}

export interface SDKResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  result?: string;
  num_turns: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  session_id: string;
}

export interface SDKControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

export interface SDKControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

export type SDKMessageOut =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKControlRequest
  | SDKControlCancelRequest;

// =====================================================================
// Per-session buffer: accumulating partial assistant content
// =====================================================================

interface ToolUseAccum {
  id: string;
  name: string;
  input: string; // raw JSON string from pi; parse at flush
}

export interface AssistantBuffer {
  textSegments: string[];
  toolUses: Map<string, ToolUseAccum>;
  thinkingSegments: string[];
  flushed: boolean;
}

export function createAssistantBuffer(): AssistantBuffer {
  return {
    textSegments: [], // collected as a single concatenated string by
    //   `flushAssistantBuffer`. We push deltas into a single entry.
    //   Implementation: push the delta onto textSegments; flush joins
    //   them all.
    toolUses: new Map(),
    thinkingSegments: [],
    flushed: false,
  };
}

/**
 * Flush the buffer into a Claude `assistant.content` array. We always
 * flush at `message_end`; intermediate flushing is unnecessary because
 * pi exposes token-level granularity but consumers expect full content
 * blocks.
 *
 * Text and thinking deltas are concatenated into single blocks; tool
 * uses become one block each (their `input` is the parsed JSON).
 */
export function flushAssistantBuffer(buf: AssistantBuffer): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  const text = buf.textSegments.join("");
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const [, tu] of buf.toolUses) {
    let parsedInput: Record<string, unknown> = {};
    if (tu.input.trim().length > 0) {
      try {
        parsedInput = JSON.parse(tu.input) as Record<string, unknown>;
      } catch {
        parsedInput = { raw: tu.input };
      }
    }
    blocks.push({
      type: "tool_use",
      id: tu.id,
      name: toClaudeToolName(tu.name),
      input: parsedInput,
    });
  }
  const thinking = buf.thinkingSegments.join("");
  if (thinking.length > 0) blocks.push({ type: "thinking", thinking });
  buf.flushed = true;
  return blocks;
}

// =====================================================================
// Input messages (Claude → pi)
// =====================================================================

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  resolve: (
    result:
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string },
  ) => void;
}

export interface InputContext {
  pendingPermissions: Map<string, PendingPermission>;
  onUserMessage: (text: string) => Promise<void> | void;
}

/**
 * Route a single NDJSON line read from stdin to the appropriate handler.
 * Returns the parsed message (for logging) or null on parse error.
 */
export function handleClaudeInput(
  rawLine: string,
  ctx: InputContext,
): unknown | null {
  const line = rawLine.trimEnd();
  if (line.length === 0) return null;

  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }

  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: string; [k: string]: unknown };

  switch (m.type) {
    case "user": {
      const text = extractUserText(m);
      if (text !== null) {
        void ctx.onUserMessage(text);
      }
      return m;
    }

    case "control_response": {
      const response = (m as { response?: { request_id?: string; subtype?: string; response?: unknown; error?: string } }).response;
      if (!response || !response.request_id) return m;
      const pending = ctx.pendingPermissions.get(response.request_id);
      if (!pending) return m;
      ctx.pendingPermissions.delete(response.request_id);
      if (response.subtype === "success" && response.response) {
        const r = response.response as
          | { behavior: "allow"; updatedInput?: Record<string, unknown> }
          | { behavior: "deny"; message: string };
        pending.resolve(r);
      } else {
        pending.resolve({
          behavior: "deny",
          message: response.error ?? "permission denied",
        });
      }
      return m;
    }

    case "control_cancel_request": {
      const requestId = (m as { request_id?: string }).request_id;
      if (requestId) {
        const pending = ctx.pendingPermissions.get(requestId);
        if (pending) {
          ctx.pendingPermissions.delete(requestId);
          pending.resolve({
            behavior: "deny",
            message: "cancelled by client",
          });
        }
      }
      return m;
    }

    default:
      return m;
  }
}

function extractUserText(m: { message?: { role?: string; content?: unknown } }): string | null {
  const content = m.message?.content;
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

// =====================================================================
// Output messages (pi → Claude)
// =====================================================================

export interface OutputEmitter {
  emit(msg: SDKMessageOut): void;
  /** Track the running number of completed agent turns. */
  numTurns: number;
  /** The model id, used in result message. */
  modelId: string;
  /** Start time for duration calculations. */
  startedAtMs: number;
  /** Whether the run has ended (causes translator to stop producing). */
  ended: boolean;
}

export interface EmitterContext extends OutputEmitter {
  pendingSynthesis?: SynthesizedResultFields;
  /** Latest assistant message we have flushed. */
  lastFlushedText: string;
}

export interface TranslatorDeps {
  cwd: string;
  modelId: string;
  buildSynthesis: () => SynthesizedResultFields | Promise<SynthesizedResultFields>;
  /** Compute the current set of available tools (PascalCase). */
  toolsAvailable: () => string[];
  /** Optional slash commands list. Empty for the shim. */
  slashCommandsAvailable?: () => string[];
  /** Permission mode that's currently in effect. */
  permissionMode?: string;
}

export interface TranslatorState {
  emitter: EmitterContext;
  bufs: Map<string, AssistantBuffer>;
  initEmitted: boolean;
  numTurns: number;
}

export function createTranslatorState(deps: TranslatorDeps): TranslatorState {
  const startedAtMs = Date.now();

  const emitter: EmitterContext = {
    emit(msg) {
      process.stdout.write(JSON.stringify(msg) + "\n");
    },
    numTurns: 0,
    modelId: deps.modelId,
    startedAtMs,
    ended: false,
    lastFlushedText: "",
    pendingSynthesis: undefined,
  };

  return {
    emitter,
    bufs: new Map(),
    initEmitted: false,
    numTurns: 0,
  };
}

/**
 * Emit the initial `system/init` once. hapi explicitly waits for this
 * before consuming subsequent messages.
 */
export function emitSystemInit(
  state: TranslatorState,
  sessionId: string,
  deps: TranslatorDeps,
): void {
  if (state.initEmitted) return;
  state.initEmitted = true;
  const msg: SDKSystemInit = {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: deps.modelId,
    cwd: deps.cwd,
    tools: deps.toolsAvailable(),
    slash_commands: deps.slashCommandsAvailable?.() ?? [],
    permission_mode: deps.permissionMode ?? "default",
  };
  state.emitter.emit(msg);
}

/**
 * Subscribe to pi's event stream and translate each event into Claude
 * NDJSON. Permission-ask mode is enabled via the `permissionAsk` callback,
 * which the entry orchestrator wires up to a separate AbortController if
 * the parent requests cancellation.
 */
export function handleAgentEvent(
  state: TranslatorState,
  event: AgentEvent,
  deps: TranslatorDeps,
  permissionAsk?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ) => Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >,
): { needsPermissionAskFor?: { toolName: string; input: unknown; toolCallId: string } } | undefined {
  // We do not call deps.buildSynthesis() here directly; the entry
  // orchestrator reads `session.getSessionStats()` after agent_end and
  // feeds the result in via `state.emitter.pendingSynthesis` (set after
  // calling this function's `buildSynthesis` arg or a deferred helper).

  switch (event.type) {
    case "agent_start":
      // Lifecycle event: Claude has no surface for this, so we drop it.
      return undefined;

    case "agent_end":
      // Defer the `result` to entry.ts which sets pendingSynthesis and
      // then calls emitResult(); here we only flip the ended flag so we
      // stop emitting if other events trickle in.
      state.emitter.ended = true;
      return undefined;

    case "turn_start":
      return undefined;

    case "turn_end":
      state.numTurns += 1;
      return undefined;

    case "message_start": {
      const message = event.message;
      if (message.role !== "assistant") return undefined;
      const buf = createAssistantBuffer();
      const key = String(message.timestamp);
      state.bufs.set(key, buf);
      return undefined;
    }

    case "message_update": {
      const message = event.message;
      if (message.role !== "assistant") return undefined;
      const buf = state.bufs.get(String(message.timestamp));
      if (!buf) return undefined;
      const ev = event.assistantMessageEvent;

      switch (ev.type) {
        case "text_start":
        case "text_delta": {
          // `text_delta` carries `delta` (string). `text_start` is just a
          // boundary marker — nothing to buffer.
          if (ev.type === "text_delta") {
            buf.textSegments.push(ev.delta);
          }
          return undefined;
        }
        case "thinking_start":
        case "thinking_delta":
          if (ev.type === "thinking_delta") {
            buf.thinkingSegments.push(ev.delta);
          }
          return undefined;
        case "text_end":
        case "thinking_end":
          // Block complete; nothing more to buffer.
          return undefined;
        case "toolcall_start": {
          // Begin a tool call. pi's partial may already have populated
          // id/name; we use randomUUID as a fallback so the protocol
          // always has a stable id per tool_use.
          const tc = (ev.partial.content[ev.contentIndex] ?? {}) as Partial<ToolCall>;
          const id = tc.id ?? `toolu_${randomUUID().slice(0, 24)}`;
          const name = tc.name ?? "unknown";
          buf.toolUses.set(id, { id, name, input: "" });
          return undefined;
        }
        case "toolcall_delta": {
          // `delta` is a raw JSON snippet of arguments; concatenate.
          const tc = (ev.partial.content[ev.contentIndex] ?? {}) as Partial<ToolCall>;
          const id = tc.id ?? "";
          if (!id) return undefined;
          let accum = buf.toolUses.get(id);
          if (!accum) {
            accum = { id, name: tc.name ?? "unknown", input: "" };
            buf.toolUses.set(id, accum);
          }
          accum.input += ev.delta;
          // Also update the name lazily as it may stream in.
          if (tc.name) accum.name = tc.name;
          return undefined;
        }
        case "toolcall_end": {
          const toolCall = (ev.partial.content[ev.contentIndex] ?? {}) as Partial<ToolCall>;
          const id = toolCall.id ?? "";
          if (!id) return undefined;
          const accum = buf.toolUses.get(id);
          if (!accum) return undefined;
          // toolcall_end carries the final parsed arguments; overwrite.
          if (toolCall.arguments !== undefined) {
            accum.input = JSON.stringify(toolCall.arguments);
          }
          if (toolCall.name) accum.name = toolCall.name;

          // If a permission-ask handler is configured, surface the tool
          // call to it. The handler is expected to synchronously return
          // an allow/deny; we translate it into a control_request →
          // control_response round-trip.
          if (permissionAsk) {
            // Stash a marker; the entry orchestrator resolves via the
            // pending control_response it reads from stdin.
            return {
              needsPermissionAskFor: {
                toolName: toolCall.name ?? "unknown",
                input: toolCall.arguments ?? {},
                toolCallId: id,
              },
            };
          }
          return undefined;
        }
      }
      return undefined;
    }

    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") return undefined;
      const buf = state.bufs.get(String(message.timestamp));
      if (!buf) return undefined;
      const content = flushAssistantBuffer(buf);
      // Empty buffer (pure thinking) → still emit a sentinel empty
      // assistant message because hapi listens for it (it's a "no-text"
      // path through the reducer). We use a placeholder text block so
      // downstream consumers don't choke on no-content messages.
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      const assistant: SDKAssistantMessage = {
        type: "assistant",
        message: { role: "assistant", content },
      };
      state.emitter.emit(assistant);
      state.emitter.lastFlushedText = content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      state.bufs.delete(String(message.timestamp));
      return undefined;
    }

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      // Lifecycle observation only. The matching `tool_use` already
      // appeared in the prior `assistant` content block (which carries
      // the `id`), and the tool result is delivered through the next
      // pi user message. We don't emit a Claude-side user message here
      // because tool_results in the stream-json wire only appear when
      // they're part of a synthetic `user` envelope.
      return undefined;
  }

  return undefined;
}

/**
 * Emit the final `result` message. `synthesis` is computed by the entry
 * orchestrator (it has access to `session.getSessionStats()`).
 */
export function emitResult(
  state: TranslatorState,
  synthesis: SynthesizedResultFields,
  sessionId: string,
  isError: boolean,
  errorMaxTurns: boolean,
): void {
  const result: SDKResultMessage = {
    type: "result",
    subtype: errorMaxTurns
      ? "error_max_turns"
      : isError
        ? "error_during_execution"
        : "success",
    result: state.emitter.lastFlushedText || undefined,
    num_turns: state.numTurns,
    usage: synthesis.usage
      ? {
          input_tokens: synthesis.usage.input_tokens,
          output_tokens: synthesis.usage.output_tokens,
          cache_read_input_tokens: synthesis.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: synthesis.usage.cache_creation_input_tokens ?? 0,
        }
      : undefined,
    total_cost_usd: synthesis.total_cost_usd,
    duration_ms: synthesis.duration_ms,
    duration_api_ms: synthesis.duration_api_ms,
    is_error: isError,
    session_id: sessionId,
    modelUsage: synthesis.modelUsage as unknown as SDKResultMessage["modelUsage"],
  };
  state.emitter.emit(result);
}

/**
 * Build and emit a `control_request` for a tool call. Returns the
 * generated `request_id`. Pair with a follow-up
 * `control_response` from stdin.
 */
export function emitControlRequest(
  state: TranslatorState,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
): string {
  const requestId = `perm_${randomUUID().slice(0, 24)}`;
  const msg: SDKControlRequest = {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
    },
  };
  state.emitter.emit(msg);

  // Pair toolCallId with the request_id so that, if the parent cancels
  // via control_cancel_request, we can return the right key.
  // Stored on emitter via the entry orchestrator's pendingPermissions map.
  void toolCallId; // referenced for future use
  return requestId;
}

/**
 * Convenience wrapper to compute the result synthesis once at agent_end.
 */
export function buildSynthesisFromStats(
  stats: ReturnType<"object"> | undefined,
  startedAtMs: number,
  modelId: string,
): SynthesizedResultFields {
  return synthesizeUsageAndCost(
    stats as unknown as Parameters<typeof synthesizeUsageAndCost>[0],
    startedAtMs,
    modelId,
  );
}

// Re-export the message/result types so consumers don't have to import
// them piecemeal.
export type {
  Message as PiMessage,
  AssistantMessage as PiAssistantMessage,
} from "@earendil-works/pi-ai";
