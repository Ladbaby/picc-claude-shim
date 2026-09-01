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

// toClaudeToolName: pi name -> Claude wire name, case-insensitive input.
assertEq(toClaudeToolName("read"), "Read", "read -> Read");
assertEq(toClaudeToolName("Read"), "Read", "Read -> Read (already cased)");
assertEq(toClaudeToolName("bash"), "Bash", "bash -> Bash");
assertEq(toClaudeToolName("BASH"), "Bash", "BASH -> Bash (case-insensitive)");
assertEq(toClaudeToolName("edit"), "Edit", "edit -> Edit");
assertEq(toClaudeToolName("write"), "Write", "write -> Write");
assertEq(toClaudeToolName("grep"), "Grep", "grep -> Grep");
assertEq(toClaudeToolName("find"), "Glob", "find -> Glob");
assertEq(toClaudeToolName("ls"), "LS", "ls -> LS");

// fromClaudeToolName: Claude wire name -> pi canonical, case-insensitive.
assertEq(fromClaudeToolName("Bash"), "bash", "Bash -> bash");
assertEq(fromClaudeToolName("bash"), "bash", "bash -> bash (lowercase)");
assertEq(fromClaudeToolName("Read"), "read", "Read -> read");
assertEq(fromClaudeToolName("READ"), "read", "READ -> read (case-insensitive)");
assertEq(fromClaudeToolName("Glob"), "find", "Glob -> find");
assertEq(fromClaudeToolName("glob"), "find", "glob -> find (lowercase)");
assertEq(fromClaudeToolName("TodoWrite"), null, "TodoWrite -> null (unsupported)");

assertEq(isSupportedClaudeToolName("Edit"), true, "Edit is supported");
assertEq(isSupportedClaudeToolName("edit"), true, "edit is supported (lowercase)");
assertEq(isSupportedClaudeToolName("Glob"), true, "Glob is supported");
assertEq(isSupportedClaudeToolName("WebSearch"), false, "WebSearch is unsupported");

assertEq(normalizeIncomingToolName("WebSearch"), "websearch", "WebSearch normalized (unknown fallback)");
assertEq(normalizeIncomingToolName("Glob"), "find", "Glob normalized -> find");
assertEq(normalizeIncomingToolName("read"), "read", "read normalized (identity)");
