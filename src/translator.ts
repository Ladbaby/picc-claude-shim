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
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toClaudeToolName } from "./tool-names.js";
import {
  type SynthesizedModelUsage,
  type SynthesizedResultFields,
} from "./cost.js";
import { CLAUDE_CODE_VERSION_BARE } from "./version.js";

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
  mcp_servers?: Array<{ name: string; status: string }>;
  /**
   * NOTE: real Claude Code uses `permissionMode` (camelCase) here. The old
   * field name `permission_mode` (snake_case) was a shim-side typo.
   */
  permissionMode?: string;
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: Array<{ name: string; path: string; source?: string }>;
  betas?: string[];
  uuid?: string;
  parent_tool_use_id?: string | null;
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

/**
 * A `system` message marking a context-compaction boundary. Mirrors Claude
 * Code's `SDKCompactBoundaryMessageSchema` (`coreSchemas.ts`):
 * `{type, subtype:"compact_boundary", session_id, uuid, compact_metadata}`
 * where `compact_metadata` is `{trigger, pre_tokens, preserved_segment?}`.
 *
 * Note: real Claude Code does NOT emit a `post_tokens` field; the host (T3
 * Code) learns the post-compact token count from a `compact_metadata.post_tokens`
 * OR falls back to its synthesized "Context compacted" divider. We emit
 * `post_tokens` anyway so T3's `compactBoundaryTokenUsageSnapshot` can build a
 * real before→after token summary ("Compacted context N → M tokens").
 */
export interface SDKCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  session_id: string;
  uuid: string;
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    /** Optional extra field T3 reads (not in Claude Code's schema, but harmless). */
    post_tokens?: number;
    preserved_segment?: {
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
}


export interface SDKAssistantMessage {
  type: "assistant";
  parent_tool_use_id?: string | null;
  message: {
    role: "assistant";
    model?: string;
    content: AssistantContentBlock[];
    /** Anthropic-usage-shaped, mirrored from pi's `usage`. */
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
    stop_reason?: string | null;
  };
  uuid?: string;
  session_id?: string;
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
  modelUsage?: Record<string, SynthesizedModelUsage>;
  stop_reason?: string | null;
  terminal_reason?: string | null;
  uuid?: string;
  parent_tool_use_id?: string | null;
}

export interface SDKControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: unknown[];
  };
}

/**
 * A `control_response` we emit back to the SDK in answer to one of its
 * `control_request`s (e.g. `initialize`, `get_usage`). Mirrors Claude Code's
 * envelope: `{type:"control_response", response:{subtype, request_id, response}}`.
 */
export interface SDKControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: unknown;
    error?: string;
  };
}

export interface SDKControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

/**
 * A `stream_event` message — a raw Anthropic streaming event forwarded to the
 * SDK. Only emitted when the parent requested partials
 * (`--include-partial-messages` / `includePartialMessages: true`).
 *
 * Envelope mirrors `SDKPartialAssistantMessageSchema` in Claude Code's
 * `coreSchemas.ts`: exactly `{type, event, parent_tool_use_id, uuid,
 * session_id}`. `event` is one of Anthropic's `BetaRawMessageStreamEvent`s
 * (message_start, content_block_start/delta/stop, message_delta,
 * message_stop) and is passed through verbatim.
 */
export interface SDKStreamEvent {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export type SDKMessageOut =
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKControlCancelRequest
  | SDKStreamEvent;

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
  // ---- stream_event (partial) bookkeeping ------------------------------
  // Anthropic content-block index counter and the index assigned to each
  // logical unit ("text", "thinking", or a tool-call id) the first time that
  // unit starts streaming. Used to emit content_block_* events with a stable
  // `index` and to close every opened block at message_end.
  nextBlockIndex: number;
  blockIndexByUnit: Map<string, number>;
  openBlocks: number[];
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
    nextBlockIndex: 0,
    blockIndexByUnit: new Map(),
    openBlocks: [],
  };
}

// =====================================================================
// Pi -> Anthropic wire-shape helpers
// =====================================================================

/** Map pi's `Usage` to the Anthropic usage shape t3code reads. */
export function toAnthropicUsage(
  usage:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined,
):
  | {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    }
  | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
  };
}

/** Map pi's `StopReason` to Claude's `stop_reason` values. */
export function toClaudeStopReason(
  reason:
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | undefined,
): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    case "error":
    case "aborted":
      return "stop_sequence";
    default:
      return null;
  }
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
// stream_event (partial) emission
//
// When `emitter.includePartialMessages` is set we forward Anthropic's raw
// streaming events, one `stream_event` NDJSON line each, so the SDK's
// `includePartialMessages` consumer can render incrementally. All helpers are
// no-ops when the flag is off.
// =====================================================================

/**
 * Wrap a raw Anthropic event in the `stream_event` envelope and emit it.
 * No-op when partials are disabled.
 */
export function emitStreamEvent(state: TranslatorState, event: unknown): void {
  if (!state.emitter.includePartialMessages) return;
  const msg: SDKStreamEvent = {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: state.emitter.sessionId,
  };
  state.emitter.emit(msg);
}

/**
 * Return (and lazily assign) the Anthropic content-block index for a logical
 * unit. A unit is `"text"`, `"thinking"`, or a tool-call id. The first call
 * for a unit opens it with a `content_block_start`; later calls reuse the
 * index. No-op when partials are disabled.
 */
function streamOpenUnit(
  state: TranslatorState,
  buf: AssistantBuffer,
  unitKey: string,
  startBlock: Record<string, unknown>,
): number | undefined {
  if (!state.emitter.includePartialMessages) return undefined;
  let idx = buf.blockIndexByUnit.get(unitKey);
  if (idx === undefined) {
    idx = buf.nextBlockIndex++;
    buf.blockIndexByUnit.set(unitKey, idx);
    buf.openBlocks.push(idx);
    emitStreamEvent(state, { type: "content_block_start", index: idx, content_block: startBlock });
  }
  return idx;
}

/** Emit a text delta (opening the text block on first use). */
function streamTextDelta(state: TranslatorState, buf: AssistantBuffer, delta: string): void {
  const idx = streamOpenUnit(state, buf, "text", { type: "text", text: "", citations: null });
  if (idx === undefined) return;
  emitStreamEvent(state, { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: delta } });
}

/** Emit a thinking delta (opening the thinking block on first use). */
function streamThinkingDelta(state: TranslatorState, buf: AssistantBuffer, delta: string): void {
  const idx = streamOpenUnit(state, buf, "thinking", { type: "thinking", thinking: "" });
  if (idx === undefined) return;
  emitStreamEvent(state, { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: delta } });
}

/** Open a tool_use block when a tool call begins streaming. */
function streamToolUseStart(state: TranslatorState, buf: AssistantBuffer, id: string, name: string): void {
  if (!id) return;
  streamOpenUnit(state, buf, id, { type: "tool_use", id, name: toClaudeToolName(name), input: {} });
}

/** Emit a tool_use input_json delta (a fragment of the arguments JSON). */
function streamToolUseDelta(state: TranslatorState, buf: AssistantBuffer, id: string, fragment: string): void {
  if (!state.emitter.includePartialMessages) return;
  const idx = buf.blockIndexByUnit.get(id);
  if (idx === undefined) return;
  emitStreamEvent(state, { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: fragment } });
}

/** Close a single content block (tool_use) that has finished. */
function streamCloseUnit(state: TranslatorState, buf: AssistantBuffer, unitKey: string): void {
  if (!state.emitter.includePartialMessages) return;
  const idx = buf.blockIndexByUnit.get(unitKey);
  if (idx === undefined) return;
  buf.openBlocks = buf.openBlocks.filter((b) => b !== idx);
  emitStreamEvent(state, { type: "content_block_stop", index: idx });
}

/**
 * Emit the `message_start` event for a new assistant message.
 */
function streamMessageStart(state: TranslatorState): void {
  if (!state.emitter.includePartialMessages) return;
  emitStreamEvent(state, {
    type: "message_start",
    message: {
      id: `msg_${randomUUID().slice(0, 24)}`,
      type: "message",
      role: "assistant",
      model: state.emitter.modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

/** Close every still-open content block (text/thinking) for the message. */
function streamCloseOpenBlocks(state: TranslatorState, buf: AssistantBuffer): void {
  if (!state.emitter.includePartialMessages) return;
  for (const idx of buf.openBlocks) {
    emitStreamEvent(state, { type: "content_block_stop", index: idx });
  }
  buf.openBlocks = [];
}

/**
 * Emit the `message_delta` (carrying `stop_reason` + running output tokens)
 * and the final `message_stop` for a completed assistant message. Called at
 * `message_end`, after any open blocks have been closed.
 */
function streamMessageDeltaAndStop(
  state: TranslatorState,
  stopReason: string | null,
  outputTokens: number,
): void {
  if (!state.emitter.includePartialMessages) return;
  emitStreamEvent(state, {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
    context_management: null,
  });
  emitStreamEvent(state, { type: "message_stop" });
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
  /**
   * Handle an incoming `control_request` from the SDK (e.g. `initialize`,
   * `get_usage`). The callback emits the matching `control_response`.
   * Optional: when absent, `control_request`s are ignored.
   */
  respondControlRequest?: (
    requestId: string,
    request: { subtype: string; [k: string]: unknown },
  ) => void;
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

    case "control_request": {
      // The SDK sends control_requests (initialize, get_usage, interrupt,
      // set_model, set_permission_mode, ...). We answer the ones we
      // understand and ignore the rest with an empty success so the SDK
      // never hangs waiting.
      const request = (m as { request?: { subtype?: string; [k: string]: unknown } }).request;
      const requestId = (m as { request_id?: string }).request_id;
      const subtype = request?.subtype;
      if (request && subtype && requestId) {
        ctx.respondControlRequest?.(requestId, { ...request, subtype });
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

function extractUserText(m: Record<string, unknown>): string | null {
  const message = m.message as { content?: unknown } | undefined;
  const content = message?.content;
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
  /**
   * The durable session id, set via {@link setSessionId} so per-message
   * emissions (assistant/result) can stamp `session_id`.
   */
  sessionId: string;
}

export interface EmitterContext extends OutputEmitter {
  pendingSynthesis?: SynthesizedResultFields;
  /** Latest assistant message we have flushed. */
  lastFlushedText: string;
  /**
   * When true, emit `stream_event` partial messages in addition to the
   * assembled `assistant` message. Set from `deps.includePartialMessages` at
   * state-creation time.
   */
  includePartialMessages: boolean;
}

export interface TranslatorDeps {
  cwd: string;
  modelId: string;
  /**
   * Compute the result synthesis. Optional: the entry orchestrator computes
   * it directly from `session.getSessionStats()` at `agent_end`, so it need
   * not be supplied up front.
   */
  buildSynthesis?: () => SynthesizedResultFields | Promise<SynthesizedResultFields>;
  /** Compute the current set of available tools (PascalCase). */
  toolsAvailable: () => string[];
  /** Optional slash commands list. Empty for the shim. */
  slashCommandsAvailable?: () => string[];
  /** Permission mode that's currently in effect. */
  permissionMode?: string;
  /**
   * When true, also emit `stream_event` partial messages (Anthropic raw
   * streaming events) alongside the assembled `assistant` message. Driven by
   * the parent's `--include-partial-messages` / `includePartialMessages`.
   */
  includePartialMessages?: boolean;
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
    sessionId: "",
    lastFlushedText: "",
    pendingSynthesis: undefined,
    includePartialMessages: deps.includePartialMessages ?? false,
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
  state.emitter.sessionId = sessionId;
  const msg: SDKSystemInit = {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: deps.modelId,
    cwd: deps.cwd,
    tools: deps.toolsAvailable(),
    slash_commands: deps.slashCommandsAvailable?.() ?? [],
    mcp_servers: [],
    permissionMode: deps.permissionMode ?? "default",
    apiKeySource: "user",
    claude_code_version: CLAUDE_CODE_VERSION_BARE,
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
    betas: [],
    uuid: randomUUID(),
    parent_tool_use_id: null,
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
  event: AgentSessionEvent,
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
      streamMessageStart(state);
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
            streamTextDelta(state, buf, ev.delta);
          }
          return undefined;
        }
        case "thinking_start":
        case "thinking_delta":
          if (ev.type === "thinking_delta") {
            buf.thinkingSegments.push(ev.delta);
            streamThinkingDelta(state, buf, ev.delta);
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
          streamToolUseStart(state, buf, id, name);
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
          streamToolUseDelta(state, buf, id, ev.delta);
          return undefined;
        }
        case "toolcall_end": {
          // `toolcall_end` carries the authoritative, fully-parsed tool call
          // at `ev.toolCall`; prefer it over the (possibly mid-stream)
          // `partial.content[contentIndex]` slice.
          const toolCall = ev.toolCall;
          const id = toolCall.id;
          let accum = buf.toolUses.get(id);
          if (!accum) {
            accum = { id, name: toolCall.name ?? "unknown", input: "" };
            buf.toolUses.set(id, accum);
          }
          // toolCall.arguments is the final parsed object; stringify it.
          accum.input = JSON.stringify(toolCall.arguments ?? {});
          if (toolCall.name) accum.name = toolCall.name;
          streamCloseUnit(state, buf, id);

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
                input: (toolCall.arguments ?? {}) as Record<string, unknown>,
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
      const assistant = message as unknown as AssistantMessage;
      // Close any still-open text/thinking blocks and finish the stream
      // (message_delta carries stop_reason + running output tokens, then
      // message_stop). Emitted before the assembled `assistant` so partials
      // complete before the deduplicated full message, matching Claude Code.
      const stopReason = toClaudeStopReason(assistant.stopReason);
      streamCloseOpenBlocks(state, buf);
      streamMessageDeltaAndStop(state, stopReason, assistant.usage?.output ?? 0);
      const assistantMsg: SDKAssistantMessage = {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          model: assistant.model,
          content,
          usage: toAnthropicUsage(assistant.usage),
          stop_reason: toClaudeStopReason(assistant.stopReason),
        },
        uuid: randomUUID(),
        session_id: state.emitter.sessionId,
      };
      state.emitter.emit(assistantMsg);
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
    stop_reason: errorMaxTurns ? "max_turns" : isError ? "stop_sequence" : "end_turn",
    terminal_reason: null,
    uuid: randomUUID(),
    parent_tool_use_id: null,
  };
  state.emitter.emit(result);
}

/**
 * Emit a `system` / `compact_boundary` message. Real Claude Code emits one of
 * these when the conversation is compacted (`/compact` or auto-compaction); the
 * host (T3 Code) reads it to render the "Context compacted" divider and to
 * settle its compaction wait.
 *
 * We always include `post_tokens` so T3's `compactBoundaryTokenUsageSnapshot`
 * builds a real before→after token summary (`post_tokens` is not in Claude
 * Code's schema, but it's a superset field T3 explicitly reads; harmless for
 * consumers that ignore it).
 */
export function emitCompactBoundary(
  state: TranslatorState,
  sessionId: string,
  opts: { preTokens: number; postTokens?: number; trigger?: "manual" | "auto" },
): void {
  const meta: SDKCompactBoundaryMessage["compact_metadata"] = {
    trigger: opts.trigger ?? "manual",
    pre_tokens: opts.preTokens,
  };
  if (typeof opts.postTokens === "number" && Number.isFinite(opts.postTokens) && opts.postTokens > 0) {
    meta.post_tokens = opts.postTokens;
  }
  const msg: SDKCompactBoundaryMessage = {
    type: "system",
    subtype: "compact_boundary",
    session_id: sessionId,
    uuid: randomUUID(),
    compact_metadata: meta,
  };
  state.emitter.emit(msg);
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
 * Build and emit a `control_response` answering an incoming `control_request`.
 *
 * Handles the subtypes the Claude Agent SDK actually sends and that a
 * `claude`-impersonator is expected to answer:
 *   - `initialize`  → account/models/commands/output_styles (what
 *     `q.initializationResult()` awaits)
 *   - `get_usage`   → rate-limit windows (what `usage_EXPERIMENTAL_…()` awaits)
 *   - everything else → a bare `success` with an empty payload, so the SDK
 *     never hangs waiting on a response it won't retry.
 */
export function respondControlRequest(
  state: TranslatorState,
  requestId: string,
  request: { subtype: string; [k: string]: unknown },
): void {
  const response: unknown = buildControlResponsePayload(request);
  const msg: SDKControlResponse = {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
  state.emitter.emit(msg);
}

/**
 * Build the `response` payload for a `control_request`. Pure (no side
 * effects) so it can be unit-tested directly.
 */
export function buildControlResponsePayload(
  request: { subtype: string; [k: string]: unknown },
): unknown {
  switch (request.subtype) {
    case "initialize": {
      const now = Date.now();
      const in5h = Math.floor(now / 1000) + 5 * 3600;
      const in7d = Math.floor(now / 1000) + 7 * 24 * 3600;
      return {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default", "Explanatory", "Learning"],
        models: [
          {
            value: "claude-sonnet",
            displayName: "Claude Sonnet",
            description: "General-purpose coding model.",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "max"],
            supportsAdaptiveThinking: true,
            supportsFastMode: false,
            supportsAutoMode: false,
          },
        ],
        account: {
          email: null,
          organization: null,
          subscriptionType: "api",
          tokenSource: "apiKey",
          apiKeySource: "user",
          apiProvider: "firstParty",
        },
        pid: process.pid,
        fast_mode_state: "off",
      };
    }
    case "get_usage":
    case "usage": {
      const now = Date.now();
      const in5h = Math.floor(now / 1000) + 5 * 3600;
      const in7d = Math.floor(now / 1000) + 7 * 24 * 3600;
      return {
        session: {},
        subscription_type: "api",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: in5h },
          seven_day: { utilization: 0, resets_at: in7d },
          model_scoped: [],
        },
        behaviors: null,
      };
    }
    default:
      // Unknown / unsupported control_request subtypes: empty success so the
      // SDK does not block. The SDK ignores a null response for subtypes it
      // does not expect.
      return {};
  }
}

// Re-export the message/result types so consumers don't have to import
// them piecemeal.
export type {
  Message as PiMessage,
  AssistantMessage as PiAssistantMessage,
} from "@earendil-works/pi-ai";
