import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { AI_PRICING_VERSION, priceFor } from '../config/aiPricing.js';
import { costMicroUsd, parseMicroUsd } from '../utils/microUsd.js';
import type {
  AiModelCall,
  AiUsageDay,
  AiUsageFilters,
  AiUsageGroup,
  AiUsageSummary,
  AiUsageTotals,
  ModelCallRecord,
} from '../types/aiUsage.js';

/**
 * Phase 19.1's AI token/cost metering — platform-level, like `auditService`.
 * `app_slug` on every row carries the namespace (guardrails rule 16); every
 * query here carries `org_id = $1` (rule 1).
 */

interface CallRow {
  id: string;
  app_slug: string;
  purpose: string;
  provider: string;
  model: string;
  entity_type: string | null;
  entity_id: string | null;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string;
  reasoning_tokens: string;
  total_tokens: string;
  cost_micro_usd: string | null;
  pricing_version: string | null;
  status: string;
  error_code: string | null;
  latency_ms: number;
  created_at: Date;
}

function toModelCall(row: CallRow): AiModelCall {
  return {
    id: row.id,
    module: row.app_slug,
    purpose: row.purpose as AiModelCall['purpose'],
    provider: row.provider as AiModelCall['provider'],
    model: row.model,
    entityType: row.entity_type,
    entityId: row.entity_id,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
    costMicroUsd: row.cost_micro_usd === null ? null : Number(parseMicroUsd(row.cost_micro_usd)),
    pricingVersion: row.pricing_version,
    status: row.status as AiModelCall['status'],
    errorCode: row.error_code,
    latencyMs: row.latency_ms,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Records ONE provider call. NEVER THROWS — metering must not be able to
 * fail a document that extracted fine, the same posture
 * autoPostService.recordBlockersSafely already takes. Any failure is
 * logged and swallowed.
 *
 * Only calls that actually reached a provider are recorded. A 503 "not
 * configured" throws before any HTTP request and must never appear here —
 * enforced by every caller, not by this function.
 *
 * Cached input is priced at the full input rate, a deliberate
 * over-estimate. It is exactly zero today because no caller sends
 * `cache_control`; a verified cache-read rate must be added to
 * config/aiPricing.ts before caching is introduced. `usage.reasoningTokens`
 * is never added to the cost — the adapter has already folded it into
 * `outputTokens` where the provider bills it that way (see `ModelUsage`).
 */
export async function recordCall(orgId: string, record: ModelCallRecord): Promise<void> {
  try {
    const usage = record.usage;
    const price = usage === null ? null : priceFor(record.model);

    let costMicroUsdValue: number | null = null;
    let pricingVersion: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;

    if (usage !== null) {
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      cachedInputTokens = usage.cachedInputTokens;
      reasoningTokens = usage.reasoningTokens;
      totalTokens = usage.totalTokens;

      if (price !== null) {
        const inputCost = costMicroUsd(inputTokens + cachedInputTokens, price.inputPerMTokMicroUsd);
        const outputCost = costMicroUsd(outputTokens, price.outputPerMTokMicroUsd);
        costMicroUsdValue = Number(inputCost) + Number(outputCost);
        pricingVersion = AI_PRICING_VERSION;
      }
    }

    await withTransaction((client) =>
      client.query(
        `INSERT INTO ai_model_calls
           (org_id, app_slug, purpose, provider, model, entity_type, entity_id,
            input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens,
            cost_micro_usd, pricing_version, status, error_code, latency_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          orgId,
          record.module,
          record.purpose,
          record.provider,
          record.model,
          record.entityType,
          record.entityId,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
          totalTokens,
          costMicroUsdValue,
          pricingVersion,
          record.status,
          record.errorCode,
          record.latencyMs,
          record.createdBy,
        ],
      ),
    );
  } catch (err) {
    console.error('[ai-usage] failed to record a model call:', err);
  }
}

/**
 * Shared by every aggregate query below — one predicate, so totals and
 * groups can never silently drift apart. `to` is inclusive of that whole
 * day, the same ruling auditService.buildFilters uses.
 */
function buildFilters(orgId: string, filters: AiUsageFilters): { where: string; values: unknown[] } {
  const values: unknown[] = [orgId, filters.from, filters.to, filters.module];
  const where = `org_id = $1
      AND ($2::date IS NULL OR created_at >= $2::date)
      AND ($3::date IS NULL OR created_at < ($3::date + 1))
      AND ($4::text IS NULL OR app_slug = $4)`;
  return { where, values };
}

const TOTALS_SELECT = `
  count(*)::text                                                       AS call_count,
  count(*) FILTER (WHERE status = 'OK')::text                          AS ok_count,
  count(*) FILTER (WHERE status = 'ERROR')::text                       AS error_count,
  COALESCE(SUM(input_tokens), 0)::text                                 AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::text                                AS output_tokens,
  COALESCE(SUM(total_tokens), 0)::text                                 AS total_tokens,
  COALESCE(SUM(cost_micro_usd), 0)::text                               AS cost_micro_usd,
  count(*) FILTER (WHERE cost_micro_usd IS NULL)::text                 AS unpriced_call_count`;

interface TotalsRow {
  call_count: string;
  ok_count: string;
  error_count: string;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_micro_usd: string;
  unpriced_call_count: string;
}

function toTotals(row: TotalsRow): AiUsageTotals {
  return {
    callCount: Number(row.call_count),
    okCount: Number(row.ok_count),
    errorCount: Number(row.error_count),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    costMicroUsd: Number(parseMicroUsd(row.cost_micro_usd)),
    unpricedCallCount: Number(row.unpriced_call_count),
  };
}

export async function getUsageSummary(orgId: string, filters: AiUsageFilters): Promise<AiUsageSummary> {
  const { where, values } = buildFilters(orgId, filters);

  const totalsResult = await pool.query<TotalsRow>(`SELECT ${TOTALS_SELECT} FROM ai_model_calls WHERE ${where}`, values);
  const totalsRow = totalsResult.rows[0];
  const totals: AiUsageTotals =
    totalsRow === undefined
      ? { callCount: 0, okCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicroUsd: 0, unpricedCallCount: 0 }
      : toTotals(totalsRow);

  const byModelResult = await pool.query<TotalsRow & { model: string; provider: string }>(
    `SELECT model, provider, ${TOTALS_SELECT}
       FROM ai_model_calls
      WHERE ${where}
      GROUP BY provider, model
      ORDER BY SUM(cost_micro_usd) DESC NULLS LAST, count(*) DESC`,
    values,
  );
  const byModel: AiUsageGroup[] = byModelResult.rows.map((row) => ({
    key: row.model,
    provider: row.provider,
    ...toTotals(row),
  }));

  const byAppResult = await pool.query<TotalsRow & { app_slug: string }>(
    `SELECT app_slug, ${TOTALS_SELECT}
       FROM ai_model_calls
      WHERE ${where}
      GROUP BY app_slug
      ORDER BY SUM(cost_micro_usd) DESC NULLS LAST, count(*) DESC`,
    values,
  );
  const byApp: AiUsageGroup[] = byAppResult.rows.map((row) => ({
    key: row.app_slug,
    provider: null,
    ...toTotals(row),
  }));

  const byPurposeResult = await pool.query<TotalsRow & { purpose: string }>(
    `SELECT purpose, ${TOTALS_SELECT}
       FROM ai_model_calls
      WHERE ${where}
      GROUP BY purpose
      ORDER BY SUM(cost_micro_usd) DESC NULLS LAST, count(*) DESC`,
    values,
  );
  const byPurpose: AiUsageGroup[] = byPurposeResult.rows.map((row) => ({
    key: row.purpose,
    provider: null,
    ...toTotals(row),
  }));

  const byDayResult = await pool.query<TotalsRow & { date: string }>(
    `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, ${TOTALS_SELECT}
       FROM ai_model_calls
      WHERE ${where}
      GROUP BY (created_at AT TIME ZONE 'UTC')::date
      ORDER BY (created_at AT TIME ZONE 'UTC')::date ASC`,
    values,
  );
  const byDay: AiUsageDay[] = byDayResult.rows.map((row) => ({
    date: row.date,
    ...toTotals(row),
  }));

  return { totals, byModel, byApp, byPurpose, byDay, pricingVersion: AI_PRICING_VERSION };
}

/** Every call attributed to one entity, newest first. Capped at 100 rows. */
export async function listCallsForEntity(
  orgId: string,
  entityType: string,
  entityId: string,
): Promise<AiModelCall[]> {
  const { rows } = await pool.query<CallRow>(
    `SELECT id, app_slug, purpose, provider, model, entity_type, entity_id,
            input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens,
            cost_micro_usd, pricing_version, status, error_code, latency_ms, created_at
       FROM ai_model_calls
      WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY created_at DESC
      LIMIT 100`,
    [orgId, entityType, entityId],
  );
  return rows.map(toModelCall);
}
