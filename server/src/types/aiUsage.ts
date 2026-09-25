/**
 * Phase 19.1's AI token/cost metering types. Platform-scoped, like
 * `audit.ts` — every app that calls a model records here, not just Capture
 * (guardrails rule 16).
 */

export const AI_CALL_PURPOSES = ['EXTRACT', 'CLASSIFY', 'ANSWER', 'EMBED'] as const;
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number];

export function isAiCallPurpose(value: string): value is AiCallPurpose {
  return (AI_CALL_PURPOSES as readonly string[]).includes(value);
}

export const AI_CALL_PROVIDERS = ['anthropic', 'gemini', 'voyage'] as const;
export type AiCallProvider = (typeof AI_CALL_PROVIDERS)[number];

export function isAiCallProvider(value: string): value is AiCallProvider {
  return (AI_CALL_PROVIDERS as readonly string[]).includes(value);
}

export const AI_CALL_STATUSES = ['OK', 'ERROR'] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/**
 * Normalized token usage for ONE provider call.
 *
 * `outputTokens` is BILLABLE output. Provider quirks are resolved at the
 * adapter boundary, never at costing time:
 *  - Anthropic already counts thinking tokens inside `output_tokens`.
 *  - Gemini bills `thoughtsTokenCount` as output, so the Gemini adapter adds
 *    it into `outputTokens` AND reports it separately in `reasoningTokens`.
 * `reasoningTokens` is therefore INFORMATIONAL ONLY and must never be added
 * to a cost a second time.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** One call, as reported by a service to `aiUsageService.recordCall`. */
export interface ModelCallRecord {
  module: string;
  purpose: AiCallPurpose;
  provider: AiCallProvider;
  model: string;
  entityType: string | null;
  entityId: string | null;
  usage: ModelUsage | null;
  status: AiCallStatus;
  errorCode: string | null;
  latencyMs: number;
  createdBy: string | null;
}

export interface AiModelCall {
  id: string;
  module: string;
  purpose: AiCallPurpose;
  provider: AiCallProvider;
  model: string;
  entityType: string | null;
  entityId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** null when this model carried no verified price at the time of the call. */
  costMicroUsd: number | null;
  pricingVersion: string | null;
  status: AiCallStatus;
  errorCode: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface AiUsageTotals {
  callCount: number;
  okCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum over PRICED rows only — never null. Read it with unpricedCallCount. */
  costMicroUsd: number;
  /** Calls excluded from costMicroUsd because their model had no price. */
  unpricedCallCount: number;
}

export interface AiUsageGroup extends AiUsageTotals {
  key: string;
  provider: string | null;
}

export interface AiUsageDay extends AiUsageTotals {
  date: string; // YYYY-MM-DD
}

export interface AiUsageSummary {
  totals: AiUsageTotals;
  byModel: AiUsageGroup[];
  byApp: AiUsageGroup[];
  byPurpose: AiUsageGroup[];
  byDay: AiUsageDay[];
  pricingVersion: string;
}

export interface AiUsageFilters {
  from: string | null; // YYYY-MM-DD, inclusive
  to: string | null; // YYYY-MM-DD, inclusive
  module: string | null;
}
