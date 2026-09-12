import * as varianceService from '../forecaster/varianceService.js';
import { summarizeVariance } from '../../utils/boarddeckVariance.js';
import type { SummarizedVariance } from '../../utils/boarddeckVariance.js';

/**
 * BoardDeck (Phase 15) — budget-vs-actual at board grain. This file contains
 * ZERO SQL. Its only route into ForecasterPro is
 * `varianceService.planVariance` (guardrails rule 16), the same boundary
 * `services/fpa-engine/forecastService.ts` documents for its own reads.
 */

export interface BvaReport {
  planId: string;
  planName: string;
  versionId: string;
  versionLabel: string;
  baseCurrency: string;
  from: string; // 'YYYY-MM-01'
  to: string; // 'YYYY-MM-01'
  summary: SummarizedVariance;
}

export async function bvaReport(
  orgId: string,
  planId: string,
  from: string | null,
  to: string | null,
  topN: number,
): Promise<BvaReport> {
  const variance = await varianceService.planVariance(orgId, planId, from, to);
  const summary = summarizeVariance(variance.rows, topN);

  return {
    planId: variance.planId,
    planName: variance.planName,
    versionId: variance.versionId,
    versionLabel: variance.versionLabel,
    baseCurrency: variance.baseCurrency,
    from: variance.from,
    to: variance.to,
    summary,
  };
}
