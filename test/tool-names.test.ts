/**
 * Smoke test for the tool name mapping helpers.
 *
 * Run via: node test/tool-names.test.ts
 */

import {
  toClaudeToolName,
  fromClaudeToolName,
  isSupportedClaudeToolName,
  normalizeIncomingToolName,
} from "../src/tool-names.js";

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

assertEq(toClaudeToolName("read"), "Read", "read -> Read");
assertEq(toClaudeToolName("bash"), "Bash", "bash -> Bash");
assertEq(toClaudeToolName("edit"), "Edit", "edit -> Edit");
assertEq(toClaudeToolName("write"), "Write", "write -> Write");
assertEq(toClaudeToolName("grep"), "Grep", "grep -> Grep");
assertEq(toClaudeToolName("find"), "Find", "find -> Find");
assertEq(toClaudeToolName("ls"), "Ls", "ls -> Ls");

assertEq(fromClaudeToolName("Bash"), "bash", "Bash -> bash");
assertEq(fromClaudeToolName("bash"), "bash", "bash -> bash (lowercase)");
assertEq(fromClaudeToolName("TodoWrite"), null, "TodoWrite -> null (unsupported)");
assertEq(isSupportedClaudeToolName("Edit"), true, "Edit is supported");
assertEq(isSupportedClaudeToolName("WebSearch"), false, "WebSearch is unsupported");
assertEq(normalizeIncomingToolName("WebSearch"), "websearch", "WebSearch normalized");
