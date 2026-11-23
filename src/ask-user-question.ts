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
 * string. All the control_request/pending wiring lives in
 * `entry.ts`, which owns the translator state.
 */

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Answer map as hosts actually ship it.
 *
 * Keying varies by host — Claude's own permission UI uses the exact question
 * text, hapi's web UI uses the question index, T3 Code uses its own question
 * ids — and values are either a joined string or a `string[]` (codex nests
 * them one level deeper). `formatAnsweredResult` resolves all of these.
 */
export type AskAnswers = Record<string, unknown>;

/** Outcome of a host permission round-trip for AskUserQuestion. */
export type AskUserQuestionOutcome =
  | { answers: AskAnswers }
  | { declineMessage: string }
  /** No supported host transport was provided. */
  | undefined;

/**
 * Narrow contract `entry.ts` supplies. `request` registers the round-trip in
 * the translator's `pending` map, emits the `can_use_tool` control_request,
 * and resolves when the matching control_response or explicit cancellation lands.
 */
export interface AskUserQuestionHost {
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

/**
 * Flatten one host-supplied answer value into a plain string.
 *
 * Hosts disagree on both the key and the value shape:
 *   - Claude's built-in tool: `string` (multi-select already comma-joined)
 *   - hapi: `string[]`
 *   - codex `request_user_input`: `{ answers: string[] }`
 * Anything unrecognized degrades to an empty string rather than throwing.
 */
function toAnswerString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(", ");
  }
  if (typeof value === "object") {
    const nested = value as { answers?: unknown; selected?: unknown };
    return toAnswerString(nested.answers ?? nested.selected);
  }
  return String(value);
}

/** Collapse whitespace so key matching does not hinge on formatting drift. */
function normalizeKey(key: string): string {
  return key.trim().replace(/\s+/g, " ");
}

/**
 * Resolve the host's answer for one question.
 *
 * Claude Code's own tool never does this — it echoes `Object.entries(answers)`
 * verbatim because its permission UI always keys by exact question text. We
 * cannot assume that: hapi's web UI submits `Record<questionIndex, string[]>`
 * and T3 Code keys by its own question ids, so looking up the raw text alone
 * silently misses every question and yields a result full of `""`.
 *
 * Candidates are tried most-specific-first: exact text, whitespace-normalized
 * text, header, then index-keyed forms (`"0"`, `"q-0"`, `"q-0"`-style ids).
 */
function resolveAnswer(
  question: QuestionParams["questions"][number] | undefined,
  index: number,
  answers: AskAnswers,
  normalized: Map<string, unknown>,
): string {
  const candidates: string[] = [];
  if (question) {
    candidates.push(question.question, question.header);
  }
  candidates.push(String(index), `q-${index}`);

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const direct = Object.prototype.hasOwnProperty.call(answers, candidate)
      ? answers[candidate]
      : undefined;
    const keyed = direct ?? normalized.get(normalizeKey(candidate));
    const text = toAnswerString(keyed);
    if (text.trim().length > 0) return text;
  }
  return "";
}

/**
 * Build Claude's canonical "answered" result string from a host answer map.
 *
 * Only questions we actually resolved a non-empty answer for are emitted. A
 * result of `"Q"=""` for every question reads to the model as "the user chose
 * empty string" and strands the turn, which is exactly the bug this guards.
 *
 * If nothing resolves but the host did send non-empty answers under keys we
 * don't understand, echo them verbatim (which is all real Claude Code ever
 * does) rather than claiming the user declined — losing a real answer is worse
 * than an unusually-keyed one. Only a genuinely empty answer set declines.
 */
export function formatAnsweredResult(
  questions: QuestionParams["questions"],
  answers: AskAnswers,
): string {
  const normalized = new Map<string, unknown>();
  const rawNonEmpty: string[] = [];
  for (const [key, value] of Object.entries(answers)) {
    const norm = normalizeKey(key);
    if (norm.length > 0 && !normalized.has(norm)) normalized.set(norm, value);
    const text = toAnswerString(value);
    if (text.trim().length > 0) rawNonEmpty.push(`"${key}"="${text}"`);
  }

  const lines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const answer = resolveAnswer(question, i, answers, normalized);
    if (answer.length === 0) continue;
    lines.push(`"${question.question}"="${answer}"`);
  }

  if (lines.length === 0) {
    if (rawNonEmpty.length === 0) return DECLINE_MESSAGE;
    return `User has answered your questions: ${rawNonEmpty.join(", ")}. You can now continue with the user's answers in mind.`;
  }
  return `User has answered your questions: ${lines.join(", ")}. You can now continue with the user's answers in mind.`;
}

const DECLINE_MESSAGE = "User declined to answer questions";
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

      // A displayed question is pending human input, not a missing host.
      // Wait until the host answers, cancels, or closes the session.
      const outcome = await host.request(toolCallId, { questions }, signal);

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
