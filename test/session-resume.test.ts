/**
 * Session resume test (no live model).
 *
 * Proves the pi `SessionManager` mechanics the shim's resume path depends
 * on:
 *
 *   1. `SessionManager.create(cwd, dir, { id })` adopts the *provided* id as
 *      the on-disk session id (the shim passes the wire session id here so
 *      the wire id and pi's id are always equal).
 *   2. `SessionManager.list(cwd, dir)` can find that session by that id —
 *      which is exactly how `buildPiSession` resolves `--resume <wireId>`.
 *   3. `SessionManager.open(path, dir, cwd)` restores the session with the
 *      same id AND its message history — so a resumed turn's LLM context
 *      includes the previous turn.
 *
 * This is the regression guard for the "resume loses conversation history"
 * bug: before the fix, pi minted its own id, so the wire id reported to the
 * host never matched the on-disk id and `--resume` always fell back to a
 * fresh session.
 *
 * Fully isolated: uses a temp sessionDir, never touches the real
 * ~/.pi/agent/sessions.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

function assert(cond: unknown, label: string): void {
  if (!cond) {
    process.stderr.write(`FAIL ${label}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`ok ${label}\n`);
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pi-claude-shim-resume-"));
  const cwd = join(tmp, "ResumeApp");
  const sessionDir = join(tmp, "sessions");
  const wireId = "11111111-2222-3333-4444-555555555555";

  try {
    // 1. create adopts the provided id.
    const created = SessionManager.create(cwd, sessionDir, { id: wireId });
    assert(created.getSessionId() === wireId, "create({id}) adopts the provided wire id");

    // Append a real turn (user + assistant). pi does not write the session
    // file to disk until an assistant message exists (see SessionManager
    // `_persist`), which always holds for a real T3 turn before a resume.
    created.appendMessage({
      role: "user",
      content: "what did we compare in turn one?",
      timestamp: Date.now(),
    });
    created.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "we compared the oauth implementations" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // 2. list finds it by the wire id (this is buildPiSession's lookup).
    const infos = await SessionManager.list(cwd, sessionDir);
    const match = infos.find((info) => info.id === wireId);
    assert(!!match, "list(cwd, dir) finds the session by the wire id");
    if (!match) return;

    // 3. open restores the same id AND the message history.
    const opened = SessionManager.open(match.path, sessionDir, cwd);
    assert(opened.getSessionId() === wireId, "open restores the same session id");

    const entries = opened.getEntries();
    assert(entries.length >= 1, "opened session has entries");
    const text = JSON.stringify(entries);
    assert(text.includes("what did we compare in turn one?"), "history restored from disk");

    // The resume-fallback path (id not found) must also keep the wire id when
    // it creates a fresh session — so a *subsequent* resume still matches.
    const fresh = SessionManager.create(cwd, sessionDir, { id: "99999999-0000-1111-2222-333333333333" });
    assert(fresh.getSessionId() === "99999999-0000-1111-2222-333333333333", "fallback create keeps the wire id");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
