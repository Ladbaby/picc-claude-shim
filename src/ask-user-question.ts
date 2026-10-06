/**
 * Headless `AskUserQuestion` override for the Claude-shim session.
 *
 * pi's `picc-ask-user-question` renders an interactive picker via
 * `ctx.ui.custom(...)` and short-circuits with "UI not available" when no TUI
 * is bound. The Claude-shim drives a *headless* session, so that tool always
 * errors and hapi shows a dead card.
 *
 * Claude Code instead models `AskUserQuestion` as a *permission* tool:
 * `checkPermissions()` returns `behavior:'ask'` and the host (hapi) answers by
 * replying to the `can_use_tool` control_request with
 * `{ behavior:'allow', updatedInput:{ questions, answers } }`.
 *
 * This tool reproduces that flow and is registered via
 * `createAgentSession({ customTools })` in `entry.ts`, where it *shadows* the
 * TUI `AskUserQuestion` (custom tool definitions override same-named extension
 * tools in pi's registry). The tool itself stays deliberately thin — it only
 * awaits `host.request` and maps the outcome to Claude's canonical result
 * string. All the `control_request`/`pending`/timeout wiring lives in
 * `entry.ts`, which owns the translator state.
 */

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Answer map as hapi ships it: keyed by question text, values comma-joined. */
export type AskAnswers = Record<string, string | string[]>;

/** Outcome of a host permission round-trip for AskUserQuestion. */
export type AskUserQuestionOutcome =
  | { answers: AskAnswers }
  | { declineMessage: string }
  /** No host, gate closed, or timed out → the tool degrades to "decide". */
  | undefined;

/**
 * Narrow contract `entry.ts` supplies. `request` registers the round-trip in
 * the translator's `pending` map, emits the `can_use_tool` control_request,
 * and resolves when the matching `control_response` (or timeout/abort) lands.
 */
export interface AskUserQuestionHost {
  /** Optional round-trip bound. Defaults to 300_000 ms. */
  timeoutMs?: number;
  request: (
    toolCallId: string,
    input: { questions: unknown[] },
    signal: AbortSignal | undefined,
  ) => Promise<AskUserQuestionOutcome>;
}

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description:
      "MAX 60 CHARACTERS — hard limit. Short display text (1-5 words).",
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if selected.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content (markdown / mockup) shown when focused.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      "The complete question to ask the user. Clear, specific, ends with '?'.",
  }),
  header: Type.String({
    maxLength: 16,
    description:
      "MAX 16 CHARACTERS — a very short chip/tag, e.g. \"Auth method\".",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "The 2-4 choices. The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Set to true to allow multiple options to be selected.",
    }),
  ),
});

const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "Questions to ask the user (1-4 questions)",
  }),
});

type QuestionParams = {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
    multiSelect?: boolean;
  }>;
};

/** Normalize a possibly-array answer value to a comma-joined string. */
function toAnswerString(value: string | string[] | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

/** Build Claude's canonical "answered" result string from a host answer map. */
export function formatAnsweredResult(
  questions: QuestionParams["questions"],
  answers: AskAnswers,
): string {
  const lines = questions
    .map((q) => `"${q.question}"="${toAnswerString(answers[q.question])}"`)
    .join(", ");
  return `User has answered your questions: ${lines}. You can now continue with the user's answers in mind.`;
}

const DECLINE_MESSAGE = "User declined to answer questions";
const ANSWER_TIMEOUT_MS = 300_000;
const NO_HOST_MESSAGE =
  "You are running without an interactive host and cannot present these " +
  "questions. Make a reasonable decision on your own, state the assumption " +
  "you are making, and continue.";

/**
 * Build the headless `AskUserQuestion` ToolDefinition. Its `execute` blocks
 * on the host's permission round-trip and returns Claude's canonical result.
 */
export function createAskUserQuestionTool(host: AskUserQuestionHost): ToolDefinition {
  return {
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user one or more structured questions during execution to " +
      "gather requirements, clarify choices, or get a decision before " +
      "continuing. Prefer this over asking in plain text when you need a " +
      "specific, structured answer.",
    parameters: QuestionParamsSchema,
    executionMode: "sequential",
    async execute(
      toolCallId: string,
      params: QuestionParams,
      signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: string;
    }> {
      const questions = ((params as QuestionParams).questions ?? []);

      const timeoutMs = host.timeoutMs ?? ANSWER_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        host.request(toolCallId, { questions }, signal),
        timeout,
      ]);
      if (timer) clearTimeout(timer);

      if (outcome == null) {
        return {
          content: [{ type: "text", text: NO_HOST_MESSAGE }],
          details: "no_host",
        };
      }
      if ("answers" in outcome) {
        const text = formatAnsweredResult(questions, outcome.answers);
        return { content: [{ type: "text", text }], details: "answered" };
      }
      const decline = outcome.declineMessage || DECLINE_MESSAGE;
      return { content: [{ type: "text", text: decline }], details: "declined" };
    },
  };
}
