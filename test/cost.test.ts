/**
 * Smoke test for the usage + cost synthesizer.
 *
 * Run via: node test/cost.test.ts
 */

import { synthesizeUsageAndCost } from "../src/cost.js";

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

// Empty stats.
{
  const synth = synthesizeUsageAndCost(undefined, 0, "claude-sonnet", 200_000, 8192);
  assertEq(synth.total_cost_usd, 0, "no stats -> total cost 0");
  assertEq(synth.usage, undefined, "no stats -> usage undefined");
  assertEq(synth.duration_ms >= 0, true, "duration_ms non-negative");
}

// Real stats.
{
  const stats = {
    sessionFile: undefined,
    sessionId: "abc",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 30,
      total: 380,
    },
    cost: 0.0123,
  } as unknown as Parameters<typeof synthesizeUsageAndCost>[0];
  const synth = synthesizeUsageAndCost(stats, Date.now() - 1000, "claude-sonnet", 200_000);
  assertEq(synth.usage?.input_tokens, 100, "input_tokens");
  assertEq(synth.usage?.output_tokens, 50, "output_tokens");
  assertEq(synth.usage?.cache_read_input_tokens, 200, "cache_read");
  assertEq(synth.usage?.cache_creation_input_tokens, 30, "cache_creation");
  assertEq(synth.total_cost_usd, 0.0123, "total_cost_usd");
  assertEq(synth.modelUsage["claude-sonnet"]?.inputTokens, 100, "modelUsage input");
}
