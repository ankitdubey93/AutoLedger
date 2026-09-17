/**
 * What one million tokens costs, per model, in MicroUsd.
 *
 * VERIFIED PRICES ONLY. A model absent from this table is not an error: its
 * calls are recorded with the tokens they used and `cost_micro_usd NULL`,
 * and the usage summary reports them as `unpricedCallCount`. Never guess a
 * price — a fabricated number in front of a user is worse than an honest
 * gap.
 *
 * Bump AI_PRICING_VERSION whenever any number here changes, so a historical
 * row records which table priced it and a later reprice is auditable.
 *
 * See study/architecture/metering-and-cost-attribution.md.
 */

export const AI_PRICING_VERSION = '2026-06-24';

export interface ModelPrice {
  /** Price of 1M input tokens, in MicroUsd. $2.00 -> 2_000_000. */
  inputPerMTokMicroUsd: number;
  /** Price of 1M output tokens, in MicroUsd. */
  outputPerMTokMicroUsd: number;
}

export const AI_MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic, verified against the published pricing table (2026-06-24).
  'claude-sonnet-5': { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000 },
  // Gemini and Voyage are deliberately ABSENT: their prices were not
  // verified when this table was written. Add an entry ONLY from the
  // provider's own published pricing page, and bump AI_PRICING_VERSION.
};

/**
 * There is no separate cached-input rate here. AP-Flow sends no
 * `cache_control`, so `cached_input_tokens` is always 0 today; the caller
 * (aiUsageService) prices cached input at the plain input rate, which is a
 * deliberate over-estimate. Before prompt caching is ever introduced, a
 * verified cache-read rate must be added to this table first.
 */

/** The price for a model id, or null when this table does not carry one. */
export function priceFor(model: string): ModelPrice | null {
  return AI_MODEL_PRICES[model] ?? null;
}
