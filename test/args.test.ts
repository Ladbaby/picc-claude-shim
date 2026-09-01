/**
 * Smoke test for the Claude shim flag parser.
 *
 * Run via: node test/args.test.ts (jiti-resolved via the bin script
 * fallback).
 */

import {
  parseClaudeArgs,
  effortToThinkingLevel,
  printClaudeShapedHelp,
} from "../src/args.js";

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

function assertArrayEq<T>(
  actual: readonly T[],
  expected: readonly T[],
  label: string,
): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    process.stderr.write(
      `FAIL ${label}\n  expected: ${b}\n  actual:   ${a}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok ${label}\n`);
}

function main(): void {
  // Empty argv: defaults
  {
    const o = parseClaudeArgs([]);
    assertEq(o.outputFormat, undefined, "empty argv outputFormat");
    assertEq(o.inputFormat, undefined, "empty argv inputFormat");
    assertEq(o.verbose, false, "empty argv verbose");
  }

  // --version / -v
  assertEq(parseClaudeArgs(["-v"]).version, true, "-v sets version");
  assertEq(parseClaudeArgs(["--version"]).version, true, "--version sets version");

  // --help / -h
  assertEq(parseClaudeArgs(["-h"]).help, true, "-h sets help");
  assertEq(parseClaudeArgs(["--help"]).help, true, "--help sets help");

  // --output-format stream-json + --input-format stream-json + --verbose
  {
    const o = parseClaudeArgs([
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ]);
    assertEq(o.outputFormat, "stream-json", "stream-json output");
    assertEq(o.inputFormat, "stream-json", "stream-json input");
    assertEq(o.verbose, true, "verbose");
  }

  // Inline `=`
  assertEq(
    parseClaudeArgs(["--output-format=stream-json"]).outputFormat,
    "stream-json",
    "output-format=stream-json",
  );

  // --system-prompt / --append-system-prompt
  {
    const o = parseClaudeArgs([
      "--system-prompt", "hello world",
      "--append-system-prompt", " extra",
    ]);
    assertEq(o.systemPrompt, "hello world", "system-prompt");
    assertEq(o.appendSystemPrompt, " extra", "append-system-prompt");
  }

  // --permission-prompt-tool stdio
  assertEq(
    parseClaudeArgs(["--permission-prompt-tool", "stdio"]).permissionPromptTool,
    "stdio",
    "permission-prompt-tool stdio",
  );

  // --resume and --continue
  assertEq(parseClaudeArgs(["--resume", "abc"]).resume, "abc", "resume");
  assertEq(
    parseClaudeArgs(["--continue"]).continueConversation,
    true,
    "continue",
  );

  // --allowedTools
  {
    const o = parseClaudeArgs(["--allowedTools", "Read,Bash,Grep"]);
    assertArrayEq(o.allowedTools, ["Read", "Bash", "Grep"], "allowedTools csv");
  }

  // --disallowedTools with mixed separators
  {
    const o = parseClaudeArgs(["--disallowedTools", "Bash, Edit"]);
    assertArrayEq(o.disallowedTools, ["Bash", "Edit"], "disallowedTools csv+space");
  }

  // --add-dir repeated
  {
    const o = parseClaudeArgs(["--add-dir", "a", "--add-dir", "b"]);
    assertArrayEq(o.addDirs, ["a", "b"], "add-dir repeats");
  }

  // --permission-mode
  assertEq(
    parseClaudeArgs(["--permission-mode", "bypassPermissions"]).permissionMode,
    "bypassPermissions",
    "permission-mode bypassPermissions",
  );

  // --model / --effort / --max-turns
  assertEq(parseClaudeArgs(["--model", "opus"]).model, "opus", "model");
  assertEq(
    parseClaudeArgs(["--max-turns", "10"]).maxTurns,
    10,
    "max-turns",
  );

  // --print <prompt>
  {
    const o = parseClaudeArgs(["-p", "say hi"]);
    assertEq(o.printPrompt, "say hi", "print prompt");
  }

  // Unknown flags accumulate
  {
    const o = parseClaudeArgs(["--no-such-flag", "1"]);
    assertArrayEq(o.unrecognized, ["--no-such-flag", "1"], "unrecognized flags");
  }

  // Invalid --output-format value is ignored (stays undefined).
  {
    const o = parseClaudeArgs(["--output-format", "bogus"]);
    assertEq(o.outputFormat, undefined, "bogus output-format ignored");
  }

  // A known flag with a missing value lands in unrecognized.
  {
    const o = parseClaudeArgs(["--model"]);
    assertEq(o.model, undefined, "value-less --model ignored");
    assertArrayEq(o.unrecognized, ["--model"], "value-less known flag -> unrecognized");
  }

  // effortToThinkingLevel
  assertEq(effortToThinkingLevel("max"), "max", "effort max");
  assertEq(effortToThinkingLevel("high"), "high", "effort high");
  assertEq(effortToThinkingLevel("medium"), "medium", "effort medium");
  assertEq(effortToThinkingLevel("low"), "low", "effort low");
  assertEq(effortToThinkingLevel("minimal"), "minimal", "effort minimal");
  assertEq(effortToThinkingLevel(undefined), "off", "effort undefined -> off");

  // help output is non-empty and contains a known flag
  {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      printClaudeShapedHelp();
    } finally {
      process.stdout.write = orig;
    }
    const help = chunks.join("");
    assertEq(help.length > 0, true, "help output non-empty");
    assertEq(help.includes("--permission-prompt-tool"), true, "help mentions --permission-prompt-tool");
    assertEq(help.includes("--output-format"), true, "help mentions --output-format");
  }
}

main();
