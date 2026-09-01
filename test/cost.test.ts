/**
 * Smoke test for the usage + cost synthesizer.
 *
 * Run via: node test/cost.test.ts
 */

import { synthesizeUsageAndCost } from "../src/cost.js";
import type { SessionStats } from "@earendil-works/pi-coding-agent";

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
  const started = Date.now() - 50;
  const synth = synthesizeUsageAndCost(undefined, started, "claude-sonnet", 200_000, 8192);
  assertEq(synth.total_cost_usd, 0, "no stats -> total cost 0");
  assertEq(synth.usage, undefined, "no stats -> usage undefined");
  assertEq(Object.keys(synth.modelUsage).length, 0, "no stats -> empty modelUsage");
  assertEq(
    synth.duration_ms >= 50 && synth.duration_ms < 5000,
    true,
    "duration_ms bounded (~50ms)",
  );
}

// Real stats (typed as the real SessionStats so field names are checked).
{
  const stats: SessionStats = {
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
  };
  const synth = synthesizeUsageAndCost(stats, Date.now() - 1000, "claude-sonnet", 200_000);
  assertEq(synth.usage?.input_tokens, 100, "input_tokens");
  assertEq(synth.usage?.output_tokens, 50, "output_tokens");
  assertEq(synth.usage?.cache_read_input_tokens, 200, "cache_read");
  assertEq(synth.usage?.cache_creation_input_tokens, 30, "cache_creation");
  assertEq(synth.total_cost_usd, 0.0123, "total_cost_usd");
  assertEq(synth.duration_ms >= 1000 && synth.duration_ms < 5000, true, "duration_ms ~1000ms");
  assertEq(synth.modelUsage["claude-sonnet"]?.inputTokens, 100, "modelUsage input");
  assertEq(synth.modelUsage["claude-sonnet"]?.costUSD, 0.0123, "modelUsage costUSD");
  assertEq(synth.modelUsage["claude-sonnet"]?.contextWindow, 200_000, "modelUsage contextWindow");
}

// Zero cache counts normalize to undefined (the `|| undefined` path).
{
  const stats: SessionStats = {
    sessionFile: undefined,
    sessionId: "abc",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0,
  };
  const synth = synthesizeUsageAndCost(stats, Date.now() - 10, "claude-sonnet");
  assertEq(synth.usage?.cache_read_input_tokens, undefined, "cache_read 0 -> undefined");
  assertEq(synth.usage?.cache_creation_input_tokens, undefined, "cache_write 0 -> undefined");
}
