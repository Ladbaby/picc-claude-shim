import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionTool, formatAnsweredResult, type AskUserQuestionOutcome } from "../src/ask-user-question.js";

const input = { questions: [{
  question: "Which library?", header: "Library",
  options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
}] };
const context = {} as ExtensionContext;
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

export async function run(): Promise<void> {
  assert.match(formatAnsweredResult(input.questions, { "Which library?": ["A", "B"] }), /"Which library\?"="A, B"/);
  const tool = createAskUserQuestionTool({ request: async () => ({ answers: { "Which library?": "B" } }) });
  assert.match(text(await tool.execute("answer", input, undefined, undefined, context)), /"Which library\?"="B"/);
  const denied = createAskUserQuestionTool({ request: async () => ({ declineMessage: "Cancelled by user" }) });
  assert.equal(text(await denied.execute("deny", input, undefined, undefined, context)), "Cancelled by user");
  const empty = createAskUserQuestionTool({ request: async () => ({ declineMessage: "" }) });
  assert.equal(text(await empty.execute("empty", input, undefined, undefined, context)), "User declined to answer questions");

  // Advance the old five-minute deadline without sleeping. Any scheduled
  // timeout would fire here; a delayed human answer must still be accepted.
  const originalSetTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = ((callback: () => void) => {
    timers++;
    queueMicrotask(callback);
    return { unref() {} };
  }) as unknown as typeof setTimeout;
  try {
    let respond!: (outcome: AskUserQuestionOutcome) => void;
    let completed = false;
    const controller = new AbortController();
    const waiting = createAskUserQuestionTool({ request: (_id, _input, signal) => {
      assert.equal(signal, controller.signal);
      return new Promise((resolve) => { respond = resolve; });
    } }).execute("delayed", input, controller.signal, undefined, context);
    void waiting.then(() => { completed = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers, 0, "question must have no automatic deadline");
    assert.equal(completed, false, "question remains pending while user is away");
    respond({ answers: { "Which library?": "A" } });
    assert.match(text(await waiting), /"Which library\?"="A"/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  process.stdout.write("ok AskUserQuestion answers, declines, and waits indefinitely\n");
}
