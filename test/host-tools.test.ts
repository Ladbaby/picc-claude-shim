import assert from "node:assert/strict";
import { createTranslatorState, handleClaudeInput, type PendingPermission, type SDKMessageOut } from "../src/translator.js";
import { requestHostTool } from "../src/host-tools.js";

export async function run(): Promise<void> {
  const state = createTranslatorState({ cwd: process.cwd(), modelId: "test", toolsAvailable: () => [], slashCommandsAvailable: () => [] });
  const pending = new Map<string, PendingPermission>();
  const messages: SDKMessageOut[] = [];
  state.emitter.emit = (message) => { messages.push(message); };
  const respond = (requestId: string, response: unknown) => handleClaudeInput(JSON.stringify({
    type: "control_response", response: { subtype: "success", request_id: requestId, response },
  }), { pendingPermissions: pending, onUserMessage: () => {} });

  const controller = new AbortController();
  const answer = requestHostTool(state, pending, "AskUserQuestion", "question-id", { questions: [] }, controller.signal);
  const request = messages.at(-1);
  assert.ok(request?.type === "control_request");
  assert.equal(request.request.tool_use_id, "question-id");
  assert.equal(pending.size, 1);
  await Promise.resolve();
  assert.equal(pending.size, 1, "unanswered questions stay pending");
  respond(request.request_id, { behavior: "allow", updatedInput: { answers: { Q: "A" } } });
  assert.deepEqual(await answer, { behavior: "allow", updatedInput: { answers: { Q: "A" } } });
  assert.equal(pending.size, 0);
  controller.abort();
  assert.equal(messages.length, 1, "settled request has no lingering abort handler");

  const abortController = new AbortController();
  const aborted = requestHostTool(state, pending, "ExitPlanMode", "exit-id", { plan: "# Plan" }, abortController.signal);
  const exitRequest = messages.at(-1);
  assert.ok(exitRequest?.type === "control_request");
  abortController.abort();
  assert.deepEqual(await aborted, { behavior: "deny", message: "cancelled by client" });
  assert.equal(pending.size, 0);
  assert.equal(messages.at(-1)?.type, "control_cancel_request");
  respond(exitRequest.request_id, { behavior: "allow" });
  assert.equal(pending.size, 0, "late answers to cancelled requests are ignored");

  const capture = requestHostTool(state, pending, "ExitPlanMode", "capture-id", { plan: "# Proposed plan", filePath: "plan.md" });
  const captureRequest = messages.at(-1);
  assert.ok(captureRequest?.type === "control_request");
  respond(captureRequest.request_id, { behavior: "deny", message: "Stop and wait for user feedback." });
  assert.deepEqual(await capture, { behavior: "deny", message: "Stop and wait for user feedback." });

  const cancelled = requestHostTool(state, pending, "EnterPlanMode", "cancel-id", {});
  const cancelRequest = messages.at(-1);
  assert.ok(cancelRequest?.type === "control_request");
  handleClaudeInput(JSON.stringify({ type: "control_cancel_request", request_id: cancelRequest.request_id }), {
    pendingPermissions: pending, onUserMessage: () => {},
  });
  assert.equal((await cancelled).behavior, "deny");
  assert.equal(pending.size, 0);
  process.stdout.write("ok host transport round-trip, indefinite wait, denial, cancellation and late responses\n");
}
