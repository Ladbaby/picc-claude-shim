/**
 * Synthesize a Claude Code `result` message's usage + cost fields from
 * pi's `SessionStats`.
 *
 * pi tracks cumulative session usage; we map it onto the Anthropic
 * fields that hapi expects in `result.usage`, `result.total_cost_usd`,
 * `result.duration_ms`, and `result.modelUsage`.
 */

import type { SessionStats } from "@earendil-works/pi-coding-agent";

export interface SynthesizedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | undefined;
  cache_creation_input_tokens: number | undefined;
  service_tier?: string;
}

export interface SynthesizedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface SynthesizedResultFields {
  usage: SynthesizedUsage | undefined;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  modelUsage: Record<string, SynthesizedModelUsage>;
}

/**
 * Compute the `result`-message fill-in fields for a session. The
 * `startedAtMs` argument captures the moment the shim began driving the
 * session (in milliseconds via `Date.now()`).
 *
 * `duration_api_ms` mirrors `duration_ms` because pi does not separate
 * the API request time from the round-trip time at the per-session
 * granularity Claude exposes. hapi only uses this for display telemetry,
 * so the approximation is acceptable.
 */
export function synthesizeUsageAndCost(
  stats: SessionStats | undefined,
  startedAtMs: number,
  modelId: string,
  contextWindow?: number,
  maxOutputTokens?: number,
): SynthesizedResultFields {
  const duration_ms = Math.max(0, Date.now() - startedAtMs);

  if (!stats) {
    return {
      usage: undefined,
      total_cost_usd: 0,
      duration_ms,
      duration_api_ms: duration_ms,
      modelUsage: {},
    };
  }

  const usage: SynthesizedUsage = {
    input_tokens: stats.tokens.input,
    output_tokens: stats.tokens.output,
    cache_read_input_tokens: stats.tokens.cacheRead || undefined,
    cache_creation_input_tokens: stats.tokens.cacheWrite || undefined,
  };

  const modelUsage: Record<string, SynthesizedModelUsage> = {
    [modelId]: {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadInputTokens: stats.tokens.cacheRead,
      cacheCreationInputTokens: stats.tokens.cacheWrite,
      costUSD: stats.cost,
      contextWindow,
      maxOutputTokens,
    },
  };

  return {
    usage,
    total_cost_usd: stats.cost,
    duration_ms,
    duration_api_ms: duration_ms,
    modelUsage,
  };
}
