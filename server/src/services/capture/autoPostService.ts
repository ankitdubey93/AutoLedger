import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { evaluateAutoPost } from './autoPostPolicy.js';
import * as captureDocumentService from './captureDocumentService.js';
import * as postingService from './postingService.js';
import { CAPTURE_AUTO_POST_DEFAULTS } from '../../types/capture.js';
import type { CaptureAutoPostBlocker, CaptureSettings } from '../../types/capture.js';

/**
 * Capture's auto-post settings and the straight-through attempt itself
 * (Phase 19). Every function takes `orgId` first and every statement
 * carries an `org_id` predicate (guardrails rule 1).
 */

interface SettingsRow {
  auto_post_enabled: boolean;
  auto_post_min_confidence: string;
  auto_post_max_total_cents: string | null;
  updated_at: Date;
}

export async function getSettings(orgId: string): Promise<CaptureSettings> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT auto_post_enabled, auto_post_min_confidence, auto_post_max_total_cents, updated_at
       FROM ap_flow_settings WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) return { ...CAPTURE_AUTO_POST_DEFAULTS };

  return {
    autoPostEnabled: row.auto_post_enabled,
    autoPostMinConfidence: Number(row.auto_post_min_confidence),
    autoPostMaxTotalCents: row.auto_post_max_total_cents === null ? null : Number(row.auto_post_max_total_cents),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function updateSettings(
  orgId: string,
  userId: string,
  input: { autoPostEnabled: boolean; autoPostMinConfidence: number; autoPostMaxTotalCents: number | null },
): Promise<CaptureSettings> {
  await withTransaction((client) =>
    client.query(
      `INSERT INTO ap_flow_settings (org_id, auto_post_enabled, auto_post_min_confidence, auto_post_max_total_cents, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE
         SET auto_post_enabled = EXCLUDED.auto_post_enabled,
             auto_post_min_confidence = EXCLUDED.auto_post_min_confidence,
             auto_post_max_total_cents = EXCLUDED.auto_post_max_total_cents,
             updated_by = EXCLUDED.updated_by`,
      [orgId, input.autoPostEnabled, input.autoPostMinConfidence, input.autoPostMaxTotalCents, userId],
    ),
  );

  return getSettings(orgId);
}

/**
 * Called by the extraction worker directly after `savePipelineResult`.
 * Never throws — an auto-post refusal (a blocked gate, or a posting-time
 * rejection like a duplicate invoice or a locked period) must never turn a
 * document that extracted fine into FAILED; it degrades to leaving the
 * document EXTRACTED with its blockers recorded for a human to read.
 */
export async function attemptAutoPost(orgId: string, captureDocumentId: string): Promise<'POSTED' | 'BLOCKED' | 'SKIPPED'> {
  const settings = await getSettings(orgId);

  let doc;
  try {
    doc = await captureDocumentService.getCaptureDocumentById(orgId, captureDocumentId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return 'SKIPPED';
    throw err;
  }

  if (doc.status !== 'EXTRACTED' || doc.extraction === null) return 'SKIPPED';

  const { rows: orgRows } = await pool.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) return 'SKIPPED';

  const blockers = evaluateAutoPost(
    {
      vendorName: doc.extraction.vendorName,
      invoiceNumber: doc.extraction.invoiceNumber,
      invoiceDate: doc.extraction.invoiceDate,
      currency: doc.extraction.currency,
      baseCurrency,
      totalCents: doc.extraction.totalCents,
      arithmeticOk: doc.extraction.arithmeticOk,
      fieldConfidence: doc.extraction.fieldConfidence,
      lineItems: doc.lineItems.map((item) => ({
        amountCents: item.amountCents,
        accountId: item.accountId,
        mappingSource: item.mappingSource,
        mappingConfidence: item.mappingConfidence,
      })),
    },
    settings,
  );

  if (blockers.length > 0) {
    await recordBlockersSafely(orgId, captureDocumentId, blockers);
    return 'BLOCKED';
  }

  try {
    await postingService.postCaptureDocument(orgId, doc.createdBy, captureDocumentId, { autoPosted: true });
    return 'POSTED';
  } catch (err) {
    const rejection: CaptureAutoPostBlocker[] =
      err instanceof ApiError && (err.status === 409 || err.status === 422)
        ? [{ code: 'POSTING_REJECTED', message: err.message }]
        : [{ code: 'POSTING_REJECTED', message: 'Posting failed unexpectedly — post it manually from the review queue' }];

    if (!(err instanceof ApiError && (err.status === 409 || err.status === 422))) {
      console.error('[capture] auto-post failed unexpectedly:', err);
    }

    await recordBlockersSafely(orgId, captureDocumentId, rejection);
    return 'BLOCKED';
  }
}

/** Recording a blocker must never itself fail the pipeline — log and move on. */
async function recordBlockersSafely(orgId: string, id: string, blockers: CaptureAutoPostBlocker[]): Promise<void> {
  try {
    await captureDocumentService.recordAutoPostBlockers(orgId, id, blockers);
  } catch (err) {
    console.error('[capture] failed to record auto-post blockers:', err);
  }
}
