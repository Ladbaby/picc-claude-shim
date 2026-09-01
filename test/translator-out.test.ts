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

// 7. Error result: isError flips subtype to error_during_execution.
col.lines = [];
emitResult(state, synth, "session-1", true, false);
const errResult = col.messages().find((m) => m.type === "result")!;
assertEq(
  (errResult as { subtype: string }).subtype,
  "error_during_execution",
  "error result subtype",
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
