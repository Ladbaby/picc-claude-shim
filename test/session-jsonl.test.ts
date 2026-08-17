/**
 * Smoke test for the hapi-compatible session JSONL writer.
 *
 * Run via: node test/session-jsonl.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionEntry,
  computeHapiProjectDir,
  computeHapiSessionPath,
  ensureHapiCompatibleSessionFile,
} from "../src/session-jsonl.js";

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

const tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-shim-"));
const claudeConfigDir = join(tmpDir, "claude-config");
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

const cwd = "C:\\Users\\Test\\Projects\\My App";

// 1. computeHapiProjectDir strips non-alphanumerics. On Windows the
//    drive letter colon AND the backslash separators both get replaced,
//    producing a double-dash for the drive boundary.
{
  const dir = computeHapiProjectDir(cwd);
  // hapi's path.ts: resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  // For "C:\\Users\\Test\\Projects\\My App" the leading "C:" produces
  // "C-" (drive letter + colon) and the backslash becomes "-", so the
  // project id is "C--Users-Test-Projects-My-App".
  const expectedProjectId = "C--Users-Test-Projects-My-App";
  assertEq(
    dir.endsWith(expectedProjectId),
    true,
    `project dir endsWith ${expectedProjectId} (got ${dir})`,
  );
}

// 2. computeHapiSessionPath joins sessionId.jsonl under the project dir.
{
  const path = computeHapiSessionPath(cwd, "session-abc");
  assertEq(
    path.endsWith("session-abc.jsonl"),
    true,
    `session path endsWith sessionId.jsonl (got ${path})`,
  );
}

// 3. ensureHapiCompatibleSessionFile creates the file with uuid.
{
  const state = ensureHapiCompatibleSessionFile({
    cwd,
    sessionId: "session-xyz",
    modelId: "claude-sonnet",
  });
  assertEq(existsSync(state.path), true, "session file exists after ensure");
  const lines = readFileSync(state.path, "utf-8").trim().split("\n");
  assertEq(lines.length, 1, "first call writes exactly one line");
  const parsed = JSON.parse(lines[0]!);
  assertEq(parsed.type, "session_meta", "session_meta type");
  assertEq(parsed.sessionId, "session-xyz", "session_meta sessionId");
  assertEq(typeof parsed.uuid, "string", "session_meta uuid is string");

  // 4. Subsequent calls don't overwrite.
  const state2 = ensureHapiCompatibleSessionFile({ cwd, sessionId: "session-xyz" });
  const lines2 = readFileSync(state2.path, "utf-8").trim().split("\n");
  assertEq(lines2.length, 1, "idempotent: file still has one line");

  // 5. appendSessionEntry writes a new line with uuid.
  const uuid = appendSessionEntry(state, {
    kind: "user",
    message: { role: "user", content: "hello" },
    sessionId: "session-xyz",
    cwd,
  });
  assertEq(typeof uuid, "string", "append returns uuid string");
  const lines3 = readFileSync(state.path, "utf-8").trim().split("\n");
  assertEq(lines3.length, 2, "after append, two lines");
  const entry = JSON.parse(lines3[1]!);
  assertEq(entry.type, "user", "appended entry type=user");
  assertEq(entry.uuid, uuid, "appended uuid matches return");
}

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });
