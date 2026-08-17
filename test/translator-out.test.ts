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
col.lines = [];
const ts = "1700000000000";
handleAgentEvent(state, {
  type: "message_start",
  message: { role: "assistant", content: [] } as never,
  timestamp: ts,
} as never, {} as never);
handleAgentEvent(state, {
  type: "message_update",
  message: { role: "assistant", content: [] } as never,
  assistantMessageEvent: {
    type: "text_delta",
    contentIndex: 0,
    delta: "hello ",
    partial: { content: [] } as never,
  },
} as never, {} as never);
handleAgentEvent(state, {
  type: "message_update",
  message: { role: "assistant", content: [] } as never,
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
  } as never,
  timestamp: ts,
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

// 5. emitResult writes a `result` message with usage.
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
assertEq((result as { num_turns: number }).num_turns >= 0, true, "result num_turns");
