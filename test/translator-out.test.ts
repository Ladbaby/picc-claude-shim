/**
 * Smoke test for the translator's output (pi event -> Claude NDJSON)
 * pipeline.
 *
 * Uses a writable stream that captures lines into memory so we can
 * inspect the emitted JSON without polluting real stdout.
 */

import { Writable } from "node:stream";
import {
  createAssistantBuffer,
  createTranslatorState,
  emitControlRequest,
  emitResult,
  emitSystemInit,
  flushAssistantBuffer,
  handleAgentEvent,
  handleClaudeInput,
  buildControlResponsePayload,
  toClaudeStopReason,
  toAnthropicUsage,
  type SDKMessageOut,
} from "../src/translator.js";
import { synthesizeUsageAndCost } from "../src/cost.js";

class StringCollector {
  lines: string[] = [];
  writable: Writable;

  constructor() {
    this.writable = new Writable({
      write: (chunk, _enc, cb) => {
        this.lines.push(chunk.toString());
        cb();
      },
    });
  }

  messages(): SDKMessageOut[] {
    return this.lines
      .filter((l) => l.endsWith("\n"))
      .map((l) => JSON.parse(l) as SDKMessageOut);
  }
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    process.stderr.write(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok ${label}\n`);
}

const col = new StringCollector();
const state = createTranslatorState({
  cwd: "C:\\Users\\Test\\Projects\\Demo",
  modelId: "claude-sonnet",
  toolsAvailable: () => ["Read", "Bash"],
  slashCommandsAvailable: () => [],
  permissionMode: "default",
});
// Override the stdout writer
state.emitter.emit = (msg: SDKMessageOut) => {
  col.writable.write(JSON.stringify(msg) + "\n");
};

// 1. system/init
emitSystemInit(state, "session-1", {
  cwd: "C:\\Users\\Test\\Projects\\Demo",
  modelId: "claude-sonnet",
  toolsAvailable: () => ["Read", "Bash"],
  slashCommandsAvailable: () => [],
});
const init = col.messages()[0]!;
assertEq(init.type, "system", "init type");
assertEq((init as { subtype: string }).subtype, "init", "init subtype");
assertEq((init as { session_id: string }).session_id, "session-1", "init session_id");
assertEq(Array.isArray((init as { tools: unknown[] }).tools), true, "init tools array");
// New Phase-2a fields.
assertEq(
  (init as { permissionMode?: string }).permissionMode,
  "default",
  "init permissionMode camelCase",
);
assertEq(
  (init as { claude_code_version?: string }).claude_code_version,
  "1.0.37",
  "init claude_code_version",
);
assertEq(
  (init as { apiKeySource?: string }).apiKeySource,
  "user",
  "init apiKeySource",
);
assertEq(
  (init as { model?: string }).model,
  "claude-sonnet",
  "init model",
);
assertEq(
  typeof (init as { uuid?: string }).uuid,
  "string",
  "init uuid present",
);

// 2. Idempotency: a second emitSystemInit is a no-op.
col.lines = [];
emitSystemInit(state, "session-1", {
  cwd: "C:\\Users\\Test\\Projects\\Demo",
  modelId: "claude-sonnet",
  toolsAvailable: () => ["Read", "Bash"],
});
assertEq(col.lines.length, 0, "system/init idempotent");

// 3. Assistant message_start + text deltas + message_end flushes content.
//    The buffer is keyed on `message.timestamp`, so put it on the message.
col.lines = [];
const ts = "1700000000000";
handleAgentEvent(state, {
  type: "message_start",
  message: { role: "assistant", content: [], timestamp: ts } as never,
} as never, {} as never);
handleAgentEvent(state, {
  type: "message_update",
  message: { role: "assistant", content: [], timestamp: ts } as never,
  assistantMessageEvent: {
    type: "text_delta",
    contentIndex: 0,
    delta: "hello ",
    partial: { content: [] } as never,
  },
} as never, {} as never);
handleAgentEvent(state, {
  type: "message_update",
  message: { role: "assistant", content: [], timestamp: ts } as never,
  assistantMessageEvent: {
    type: "text_delta",
    contentIndex: 0,
    delta: "world",
    partial: { content: [] } as never,
  },
} as never, {} as never);
handleAgentEvent(state, {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello world" }],
    model: "claude-sonnet",
    usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: ts,
  } as never,
} as never, {} as never);
const flushed = col.messages().find((m) => m.type === "assistant");
assertEq(flushed !== undefined, true, "assistant message flushed");
assertEq(
  JSON.stringify((flushed as { message: { content: unknown[] } }).message.content),
  JSON.stringify([{ type: "text", text: "hello world" }]),
  "assistant content",
);
assertEq(
  (flushed as { message: { model?: string } }).message.model,
  "claude-sonnet",
  "assistant model",
);
assertEq(
  (flushed as { message: { stop_reason?: string } }).message.stop_reason,
  "tool_use",
  "assistant stop_reason mapped",
);
assertEq(
  JSON.stringify(
    (flushed as { message: { usage?: unknown } }).message.usage,
  ),
  JSON.stringify({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }),
  "assistant usage anthropic-shaped",
);
assertEq(
  typeof (flushed as { uuid?: string }).uuid,
  "string",
  "assistant uuid present",
);
assertEq(
  (flushed as { session_id?: string }).session_id,
  "session-1",
  "assistant session_id",
);

// 4. Buffer helper: prebuilt tool_use + text + thinking flushes all three.
{
  const buf = createAssistantBuffer();
  buf.textSegments.push("hi");
  buf.toolUses.set("toolu_a", { id: "toolu_a", name: "bash", input: '{"command":"ls"}' });
  buf.thinkingSegments.push("thinking");
  const blocks = flushAssistantBuffer(buf);
  const types = blocks.map((b) => b.type);
  assertEq(JSON.stringify(types), JSON.stringify(["text", "tool_use", "thinking"]), "buffer flushes all three blocks");
}

// 5. num_turns increments per turn_end and is reported in result.
col.lines = [];
for (let i = 0; i < 3; i++) handleAgentEvent(state, { type: "turn_end" } as never, {} as never);
assertEq(state.numTurns, 3, "num_turns counts turn_end");

// 6. emitResult writes a `result` message; usage/cost round-trip.
col.lines = [];
const synth = synthesizeUsageAndCost(
  {
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.001,
  } as never,
  Date.now() - 100,
  "claude-sonnet",
);
emitResult(state, synth, "session-1", false, false);
const result = col.messages().find((m) => m.type === "result")!;
assertEq(result.type, "result", "result type");
assertEq((result as { subtype: string }).subtype, "success", "result subtype");
assertEq((result as { session_id: string }).session_id, "session-1", "result session_id");
assertEq((result as { num_turns: number }).num_turns, 3, "result num_turns is 3");
assertEq((result as { total_cost_usd: number }).total_cost_usd, 0.001, "result total_cost_usd");
assertEq((result as { usage: { input_tokens: number } }).usage?.input_tokens, 10, "result usage input_tokens");
assertEq(
  (result as { modelUsage: Record<string, unknown> }).modelUsage["claude-sonnet"] !== undefined,
  true,
  "result modelUsage present",
);
assertEq(
  (result as { stop_reason?: string | null }).stop_reason,
  "end_turn",
  "result stop_reason on success",
);
assertEq(
  typeof (result as { uuid?: string }).uuid,
  "string",
  "result uuid present",
);

// 7. Error result: isError flips subtype to error_during_execution.
col.lines = [];
emitResult(state, synth, "session-1", true, false);
const errResult = col.messages().find((m) => m.type === "result")!;
assertEq(
  (errResult as { subtype: string }).subtype,
  "error_during_execution",
  "error result subtype",
);
assertEq(
  (errResult as { stop_reason?: string | null }).stop_reason,
  "stop_sequence",
  "error result stop_reason",
);

// 8. control_request output shape.
{
  const before = col.lines.length;
  const requestId = emitControlRequest(state, "Bash", { command: "ls" }, "toolu_x");
  const req = col.messages()[col.messages().length - 1] as {
    type: string;
    request_id: string;
    request: { subtype: string; tool_name: string; input: unknown };
  };
  assertEq(requestId.length > 0, true, "control_request returns id");
  assertEq(req.type, "control_request", "control_request type");
  assertEq(req.request_id, requestId, "control_request id matches");
  assertEq(req.request.subtype, "can_use_tool", "control_request subtype");
  assertEq(req.request.tool_name, "Bash", "control_request tool_name");
  assertEq(JSON.stringify(req.request.input), JSON.stringify({ command: "ls" }), "control_request input");
  assertEq(col.lines.length > before, true, "control_request emitted a line");
}

// 9. buildControlResponsePayload: the shapes the Claude Agent SDK awaits.
{
  const initPayload = buildControlResponsePayload({ subtype: "initialize" }) as Record<string, unknown>;
  assertEq(
    Array.isArray(initPayload.models),
    true,
    "initialize response has models array",
  );
  assertEq(
    Array.isArray(initPayload.available_output_styles),
    true,
    "initialize response has available_output_styles",
  );
  assertEq(
    "account" in initPayload,
    true,
    "initialize response has account",
  );
  assertEq(
    typeof initPayload.pid === "number",
    true,
    "initialize response has numeric pid",
  );

  const usagePayload = buildControlResponsePayload({ subtype: "get_usage" }) as {
    rate_limits_available: boolean;
    rate_limits: {
      five_hour: { utilization: number; resets_at: number };
      seven_day: { utilization: number; resets_at: number };
    };
  };
  assertEq(usagePayload.rate_limits_available, true, "usage response rate_limits_available");
  assertEq(typeof usagePayload.rate_limits.five_hour.resets_at === "number", true, "usage five_hour resets_at");
  assertEq(typeof usagePayload.rate_limits.seven_day.resets_at === "number", true, "usage seven_day resets_at");

  // Unknown subtypes resolve to an empty success payload (never throw).
  assertEq(JSON.stringify(buildControlResponsePayload({ subtype: "set_model" })), "{}", "unknown subtype -> {}");
}

// 10. toClaudeStopReason / toAnthropicUsage helpers.
assertEq(toClaudeStopReason("stop"), "end_turn", "stopReason stop -> end_turn");
assertEq(toClaudeStopReason("toolUse"), "tool_use", "stopReason toolUse -> tool_use");
assertEq(toClaudeStopReason("length"), "max_tokens", "stopReason length -> max_tokens");
assertEq(toClaudeStopReason(undefined), null, "stopReason undefined -> null");
assertEq(
  JSON.stringify(toAnthropicUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })),
  JSON.stringify({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
  "usage mapped",
);
assertEq(toAnthropicUsage(undefined) === undefined, true, "usage undefined -> undefined");

// 11. handleClaudeInput routes an incoming control_request to the responder.
{
  const seen: { id: string; subtype: string }[] = [];
  const ctx = {
    pendingPermissions: new Map<string, never>(),
    onUserMessage: () => undefined,
    respondControlRequest: (id: string, req: { subtype: string }) => {
      seen.push({ id, subtype: req.subtype });
    },
  };
  handleClaudeInput(
    JSON.stringify({ type: "control_request", request_id: "cr_1", request: { subtype: "initialize" } }),
    ctx,
  );
  assertEq(
    seen.length === 1 && seen[0]!.id === "cr_1" && seen[0]!.subtype === "initialize",
    true,
    "control_request routed to responder",
  );
}

// 12. Phase 2e: stream_event partials. A fresh state with
//     includePartialMessages: true should emit the full Anthropic raw-stream
//     sequence in order, and the default state (flag off) should emit none.
{
  const partialCol = new StringCollector();
  const partialState = createTranslatorState({
    cwd: "C:\\Users\\Test\\Projects\\Demo",
    modelId: "claude-sonnet",
    toolsAvailable: () => ["Read", "Bash"],
    permissionMode: "default",
    includePartialMessages: true,
  });
  partialState.emitter.emit = (msg: SDKMessageOut) => {
    partialCol.writable.write(JSON.stringify(msg) + "\n");
  };
  // Set the session id so envelopes carry it.
  emitSystemInit(partialState, "session-p", {
    cwd: "C:\\Users\\Test\\Projects\\Demo",
    modelId: "claude-sonnet",
    toolsAvailable: () => ["Read", "Bash"],
  });

  partialCol.lines = [];
  const pts = "1700000000999";
  // text-only assistant turn with a tool call to exercise multiple blocks.
  handleAgentEvent(partialState, {
    type: "message_start",
    message: { role: "assistant", content: [], timestamp: pts } as never,
  } as never, {} as never);
  handleAgentEvent(partialState, {
    type: "message_update",
    message: { role: "assistant", content: [], timestamp: pts } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "running ",
      partial: { content: [] } as never,
    },
  } as never, {} as never);
  handleAgentEvent(partialState, {
    type: "message_update",
    message: { role: "assistant", content: [], timestamp: pts } as never,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: { content: [{ id: "toolu_p", name: "Bash" }] } as never,
    },
  } as never, {} as never);
  handleAgentEvent(partialState, {
    type: "message_update",
    message: { role: "assistant", content: [], timestamp: pts } as never,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"command":"ls"}',
      partial: { content: [{ id: "toolu_p", name: "Bash" }] } as never,
    },
  } as never, {} as never);
  handleAgentEvent(partialState, {
    type: "message_update",
    message: { role: "assistant", content: [], timestamp: pts } as never,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "toolu_p", name: "Bash", arguments: { command: "ls" } } as never,
    },
  } as never, {} as never);
  handleAgentEvent(partialState, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "running " }, { type: "tool_use", id: "toolu_p", name: "Bash", input: { command: "ls" } }],
      model: "claude-sonnet",
      usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
      stopReason: "toolUse",
      timestamp: pts,
    } as never,
  } as never, {} as never);

  const se = partialCol
    .messages()
    .filter((m) => m.type === "stream_event") as Array<{
    event: { type: string; [k: string]: unknown };
    uuid?: string;
    session_id?: string;
    parent_tool_use_id?: string | null;
  }>;
  const order = se.map((m) => m.event.type);
  assertEq(
    JSON.stringify(order),
    JSON.stringify([
      "message_start",
      "content_block_start", // text
      "content_block_delta", // text
      "content_block_start", // tool_use
      "content_block_delta", // input_json
      "content_block_stop",  // tool_use closed at toolcall_end
      "content_block_stop",  // text closed at message_end
      "message_delta",
      "message_stop",
    ]),
    "partial stream event order",
  );
  // Every envelope carries the wire envelope fields.
  assertEq(se.every((m) => typeof m.uuid === "string"), true, "partial envelopes have uuid");
  assertEq(se.every((m) => m.session_id === "session-p"), true, "partial envelopes have session_id");
  assertEq(se.every((m) => m.parent_tool_use_id === null), true, "partial envelopes parent_tool_use_id null");
  // message_delta carries stop_reason + output_tokens.
  const md = se.find((m) => m.event.type === "message_delta")!;
  const mdDelta = md.event.delta as { stop_reason: string };
  const mdUsage = md.event.usage as { output_tokens: number };
  assertEq(mdDelta.stop_reason, "tool_use", "partial message_delta stop_reason");
  assertEq(mdUsage.output_tokens, 3, "partial message_delta output_tokens");
  // content_block indices are 0 (text) and 1 (tool_use).
  const starts = se
    .filter((m) => m.event.type === "content_block_start")
    .map((m) => m.event.index as number);
  assertEq(JSON.stringify(starts), JSON.stringify([0, 1]), "partial content_block indices");

  // Default state (flag off) emits NO stream_event.
  const offCol = new StringCollector();
  const offState = createTranslatorState({
    cwd: "C:\\Users\\Test\\Projects\\Demo",
    modelId: "claude-sonnet",
    toolsAvailable: () => ["Read", "Bash"],
  });
  offState.emitter.emit = (msg: SDKMessageOut) => {
    offCol.writable.write(JSON.stringify(msg) + "\n");
  };
  const ots = "1700000000888";
  handleAgentEvent(offState, {
    type: "message_start",
    message: { role: "assistant", content: [], timestamp: ots } as never,
  } as never, {} as never);
  handleAgentEvent(offState, {
    type: "message_update",
    message: { role: "assistant", content: [], timestamp: ots } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "hi",
      partial: { content: [] } as never,
    },
  } as never, {} as never);
  handleAgentEvent(offState, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "claude-sonnet",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: ots,
    } as never,
  } as never, {} as never);
  assertEq(
    offCol.messages().filter((m) => m.type === "stream_event").length,
    0,
    "no stream_event when flag off",
  );
}

