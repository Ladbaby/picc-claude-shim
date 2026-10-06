/**
 * Unit test for the headless AskUserQuestion override tool.
 *
 * `execute` always performs the host permission round-trip (regardless of
 * permission mode — Claude Code and both hosts ask for AskUserQuestion
 * regardless of mode). Outcomes covered:
 *   - host answers          -> canonical "answered" string
 *   - host declines         -> decline message (or default when empty)
 *   - host never responds   -> timeout -> "no_host" (degrade to decide)
 * Plus `formatAnsweredResult` formatting (single, multi, array values).
 */

import {
  createAskUserQuestionTool,
  formatAnsweredResult,
  type AskUserQuestionHost,
  type AskAnswers,
} from "../src/ask-user-question.js";

function check(cond: boolean, label: string): void {
  if (!cond) {
    process.stderr.write(`FAIL ${label}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok ${label}\n`);
}

const Q = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
    {
      question: "Enable feature?",
      header: "Feature",
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
      multiSelect: false,
    },
  ],
};

// --- formatAnsweredResult ---
const oneLine = formatAnsweredResult(
  Q.questions as any,
  { "Which library?": "A" } as AskAnswers,
);
check(
  oneLine.includes('"Which library?"="A"') &&
    oneLine.includes('"Enable feature?"=""') &&
    oneLine.startsWith("User has answered your questions:") &&
    oneLine.endsWith("in mind."),
  "formatAnsweredResult: canonical shape with empty for missing answer",
);

const multiLine = formatAnsweredResult(
  Q.questions as any,
  { "Which library?": ["A", "B"] } as AskAnswers,
);
check(
  multiLine.includes('"Which library?"="A, B"'),
  "formatAnsweredResult: array answer comma-joined",
);

// --- execute outcomes ---
async function main(): Promise<void> {
  const tool = (host: AskUserQuestionHost) => createAskUserQuestionTool(host);

  // 1. host answers -> answered
  const r1 = await tool({
    request: () =>
      Promise.resolve({ answers: { "Which library?": "B", "Enable feature?": "Yes" } }),
  }).execute("t1", Q as any, undefined, undefined, {} as any);
  check(r1.details === "answered", "execute: answered details");
  check(
    (r1.content[0] as any).text.includes('"Which library?"="B"') &&
      (r1.content[0] as any).text.includes('"Enable feature?"="Yes"'),
    "execute: answered text carries the answers",
  );

  // 2. host declines -> declined (host-supplied message)
  const r2 = await tool({
    request: () => Promise.resolve({ declineMessage: "No answers were provided." }),
  }).execute("t2", Q as any, undefined, undefined, {} as any);
  check(r2.details === "declined", "execute: declined details");
  check(
    (r2.content[0] as any).text === "No answers were provided.",
    "execute: declined text is the host message",
  );

  // 3. host declines with empty message -> default
  const r3 = await tool({
    request: () => Promise.resolve({ declineMessage: "" } as any),
  }).execute("t3", Q as any, undefined, undefined, {} as any);
  check(
    (r3.content[0] as any).text === "User declined to answer questions",
    "execute: default decline message",
  );

  // 4. host never responds -> timeout -> no_host (degrade instruction)
  const r4 = await tool({
    timeoutMs: 30,
    request: () => new Promise<undefined>(() => {}),
  }).execute("t4", Q as any, undefined, undefined, {} as any);
  check(r4.details === "no_host", "execute: timeout -> no_host");
  check(
    (r4.content[0] as any).text.includes("decision on your own"),
    "execute: no_host text is the degrade instruction",
  );

  console.error("ask-user-question.test done");
}

void main();
