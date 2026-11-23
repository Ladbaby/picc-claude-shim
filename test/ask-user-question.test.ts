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

  // hapi's web UI submits `Record<questionIndex, string[]>`, and other hosts
  // key by header or by their own question ids. A pure question-text lookup
  // missed every one of them and emitted `"Q"=""` for each question, which
  // reads to the model as "the user answered empty string" and strands the
  // turn. Every host shape below must resolve to the real answer.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["index-keyed string[] (hapi web)", { "0": ["A"] }],
    ["index-keyed string", { "0": "A" }],
    ["header-keyed", { Library: ["A"] }],
    ["q-index-keyed id", { "q-0": "A" }],
    ["nested codex shape", { "0": { answers: ["A"] } }],
    ["whitespace-drifted text key", { "  Which   library? ": "A" }],
  ];
  for (const [label, answers] of cases) {
    assert.match(
      formatAnsweredResult(input.questions, answers),
      /"Which library\?"="A"/,
      `${label} must resolve to the selected option`,
    );
  }

  // An answer map whose keys we cannot match must never fabricate `=""`
  // answers, and must not claim the user declined when they actually answered:
  // echoing the raw key/value is what real Claude Code does, and losing a real
  // answer is worse than relaying an unusually-keyed one.
  const unmatched = formatAnsweredResult(input.questions, { unrelated: "x" });
  assert.doesNotMatch(unmatched, /=""/);
  assert.match(unmatched, /"unrelated"="x"/);

  // A genuinely empty answer map is the only real decline.
  const none = formatAnsweredResult(input.questions, {});
  assert.equal(none, "User declined to answer questions");

  // Partial resolution emits only the questions actually answered.
  const twoQuestions = [
    { question: "First?", header: "One", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
    { question: "Second?", header: "Two", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
  ];
  const partial = formatAnsweredResult(twoQuestions, { "1": ["C"] });
  assert.match(partial, /"Second\?"="C"/);
  assert.doesNotMatch(partial, /First\?/);

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
