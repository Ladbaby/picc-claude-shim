import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createTranslatorState,
  emitCompactBoundary,
  emitQueryInit,
  emitResult,
  emitSystemInit,
  handleAgentEvent,
  respondControlRequest,
  type SDKMessageOut,
  type SDKSystemInit,
} from "../src/translator.js";
import { synthesizeUsageAndCost } from "../src/cost.js";

export function run(): void {
  let tools: string[] = [];
  const deps = { cwd: "test-project", modelId: "startup-model", toolsAvailable: () => tools,
    permissionMode: "default", includePartialMessages: true };
  const state = createTranslatorState(deps);
  const messages: SDKMessageOut[] = [];
  // These are hapi claudeRemote.ts's actual init/result thinking predicates.
  let thinking = false;
  state.emitter.emit = (message) => {
    messages.push(message);
    if (message.type === "system" && message.subtype === "init") thinking = true;
    if (message.type === "result") thinking = false;
  };
  const inits = () => messages.filter((m) => m.type === "system" && m.subtype === "init") as SDKSystemInit[];
  const event = (value: AgentSessionEvent) => handleAgentEvent(state, value, deps);
  const finish = (error = false) => emitResult(state, synthesizeUsageAndCost(undefined, Date.now(), deps.modelId), "wire-id", error, false);
  const activity = (timestamp: number) => {
    const message: AssistantMessage = { role: "assistant", content: [], timestamp,
      api: "anthropic-messages", provider: "anthropic", model: deps.modelId,
      stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
        totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    event({ type: "message_start", message });
    assert.equal(thinking, true, "init precedes assistant streaming");
    event({ type: "message_end", message } as AgentSessionEvent);
    event({ type: "tool_execution_end", toolCallId: "bash-id", toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] }, isError: false });
    assert.equal(thinking, true, "tool completion must not end thinking");
  };

  // Cheap capability requests must neither create a query nor invoke live metadata.
  emitSystemInit(state, "wire-id", deps);
  respondControlRequest(state, "probe", { subtype: "initialize" });
  emitSystemInit(state, "wire-id", { ...deps, toolsAvailable: () => { throw new Error("must stay lazy"); } });
  assert.equal(inits().length, 1);
  assert.equal(state.queryActive, false);

  tools = ["Read", "Bash"];
  deps.modelId = "live-model";
  event({ type: "agent_start" });
  assert.equal(inits().length, 2, "first real run refreshes placeholder metadata");
  activity(1);
  event({ type: "turn_end" } as AgentSessionEvent);
  event({ type: "turn_start" });
  assert.equal(inits().length, 2, "model turns/queued follow-ups do not start a query");
  assert.equal(messages.filter((m) => m.type === "result").length, 0);
  event({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(thinking, true, "low-level agent_end may be followed by recovery");
  emitCompactBoundary(state, "wire-id", { trigger: "auto", preTokens: 100 });
  event({ type: "agent_start" });
  assert.equal(inits().length, 2, "retry/auto-compaction continuation emits no duplicate init");
  activity(2);
  event({ type: "agent_settled" });
  finish(); // Entry emits the result at agent_settled, not at tool/turn end.
  assert.equal(thinking, false);

  // The reported bug: later messages in the same process must restore thinking.
  tools = ["Read", "Bash", "Edit"];
  deps.permissionMode = "acceptEdits";
  deps.modelId = "changed-model";
  const before = messages.length;
  event({ type: "agent_start" });
  assert.equal(messages[before]?.type, "system");
  assert.equal(thinking, true, "second query restores hapi's thinking state");
  activity(3);
  const second = inits()[2]!;
  assert.equal(second.model, "changed-model");
  assert.equal(second.permissionMode, "acceptEdits");
  assert.deepEqual(second.tools, tools);
  assert.equal(state.emitter.modelId, "changed-model", "partial messages use refreshed model");
  finish(true); // An interrupted/error run still closes its query boundary.
  event({ type: "agent_start" });
  assert.equal(inits().length, 4, "post-interrupt query gets a new init");
  finish();

  // Manual compact is a host-owned query even though it has no agent_start.
  const compactStart = messages.length;
  emitQueryInit(state, "wire-id", deps);
  emitCompactBoundary(state, "wire-id", { trigger: "manual", preTokens: 100 });
  finish();
  assert.equal((messages[compactStart] as SDKSystemInit).subtype, "init");
  assert.equal((messages[compactStart + 1] as { subtype: string }).subtype, "compact_boundary");
  assert.equal(messages[compactStart + 2]?.type, "result");
  assert.equal(thinking, false);
  assert(inits().every((m) => m.session_id === "wire-id"));
  assert.equal(new Set(inits().map((m) => m.uuid)).size, inits().length);
  process.stdout.write("ok per-query init restores hapi thinking, refreshes metadata, preserves probe/retry/compact boundaries\n");
}
