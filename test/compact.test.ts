/**
 * Tests for the host-side `/compact` interception.
 *
 * Two pure pieces are covered:
 *   - `parseCompactCommand` (entry.ts) — recognizing a `/compact` user message
 *     vs an ordinary prompt.
 *   - `emitCompactBoundary` (translator.ts) — the `compact_boundary` system
 *     message T3 Code reads to render the divider and settle its compaction
 *     wait.
 *
 * The end-to-end interception (driving pi's real `session.compact()`) is
 * exercised by `entry.e2e.test.ts` / manual T3 runs, not here.
 */

import {
  createTranslatorState,
  emitCompactBoundary,
  type SDKCompactBoundaryMessage,
  type SDKMessageOut,
} from "../src/translator.js";
import { parseCompactCommand } from "../src/entry.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    process.stdout.write(`ok ${label}\n`);
  } else {
    process.stderr.write(`FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}\n`);
    failures += 1;
  }
}
function eq<T>(label: string, actual: T, expected: T): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, pass, { expected, actual });
}

// ---------------------------------------------------------------------------
// parseCompactCommand
// ---------------------------------------------------------------------------

// Bare `/compact` (what T3 sends) → compact with no instructions.
eq("parseCompactCommand: bare /compact", parseCompactCommand("/compact"), undefined);
// Trailing space / surrounding whitespace is tolerated.
eq("parseCompactCommand: trailing space", parseCompactCommand("/compact "), undefined);
eq("parseCompactCommand: surrounding whitespace", parseCompactCommand("  /compact  "), undefined);
// `/compact <instructions>` → custom instructions, trimmed.
eq("parseCompactCommand: with instructions", parseCompactCommand("/compact focus on the auth fix"), "focus on the auth fix");
eq("parseCompactCommand: instructions trimmed", parseCompactCommand("/compact   keep only decisions  "), "keep only decisions");
// `/compact ` with only whitespace after → treated as bare (undefined).
eq("parseCompactCommand: whitespace-only arg", parseCompactCommand("/compact    "), undefined);
// Not a compact command → null (forward to pi as a prompt).
eq("parseCompactCommand: /compactx is not a command", parseCompactCommand("/compactx"), null);
eq("parseCompactCommand: /compaction is not a command", parseCompactCommand("/compaction"), null);
eq("parseCompactCommand: case-sensitive /Compact", parseCompactCommand("/Compact"), null);
eq("parseCompactCommand: no slash", parseCompactCommand("compact"), null);
eq("parseCompactCommand: mid-message /compact", parseCompactCommand("please /compact now"), null);
eq("parseCompactCommand: other slash command", parseCompactCommand("/clear"), null);
eq("parseCompactCommand: normal prompt", parseCompactCommand("write a function"), null);

// ---------------------------------------------------------------------------
// emitCompactBoundary
// ---------------------------------------------------------------------------

function captureEmitted(): { state: ReturnType<typeof createTranslatorState>; out: SDKMessageOut[] } {
  const state = createTranslatorState({
    cwd: "C:\\Projects\\Demo",
    modelId: "claude-sonnet",
    toolsAvailable: () => [],
    slashCommandsAvailable: () => [],
    permissionMode: "default",
  });
  const out: SDKMessageOut[] = [];
  state.emitter.emit = (m: SDKMessageOut) => {
    out.push(m);
  };
  return { state, out };
}

{
  const { state, out } = captureEmitted();
  emitCompactBoundary(state, "sess-123", { preTokens: 8000, postTokens: 1900 });
  const m = out[0] as unknown as SDKCompactBoundaryMessage;
  ok("boundary: exactly one message emitted", out.length === 1);
  eq("boundary: type", m.type, "system");
  eq("boundary: subtype", m.subtype, "compact_boundary");
  eq("boundary: session_id", m.session_id, "sess-123");
  ok("boundary: has uuid", typeof m.uuid === "string" && m.uuid.length > 0);
  eq("boundary: trigger default manual", m.compact_metadata.trigger, "manual");
  eq("boundary: pre_tokens", m.compact_metadata.pre_tokens, 8000);
  eq("boundary: post_tokens", m.compact_metadata.post_tokens, 1900);
}

{
  // No postTokens → field omitted (T3 then falls back to its synthesized divider).
  // No trigger → defaults to "manual".
  const { state, out } = captureEmitted();
  emitCompactBoundary(state, "sess-456", { preTokens: 1234 });
  const m = out[0] as unknown as SDKCompactBoundaryMessage;
  eq("boundary: trigger defaults to manual", m.compact_metadata.trigger, "manual");
  eq("boundary: post_tokens omitted when unset", "post_tokens" in m.compact_metadata, false);
}

{
  // Explicit trigger: "auto".
  const { state, out } = captureEmitted();
  emitCompactBoundary(state, "sess-111", { preTokens: 10, postTokens: 5, trigger: "auto" });
  const m = out[0] as unknown as SDKCompactBoundaryMessage;
  eq("boundary: trigger auto passthrough", m.compact_metadata.trigger, "auto");
}

{
  // postTokens = 0 → treated as absent (T3 requires a positive post_tokens).
  const { state, out } = captureEmitted();
  emitCompactBoundary(state, "sess-789", { preTokens: 500, postTokens: 0 });
  const m = out[0] as unknown as SDKCompactBoundaryMessage;
  eq("boundary: post_tokens omitted when zero", "post_tokens" in m.compact_metadata, false);
}

// ---------------------------------------------------------------------------

process.on("exit", (code) => {
  if (failures > 0) {
    process.exitCode = 1;
  }
});
