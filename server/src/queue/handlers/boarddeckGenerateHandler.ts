import * as deckService from '../../services/boarddeck/deckService.js';
import * as closeRunService from '../../services/boarddeck/closeRunService.js';
import * as bvaService from '../../services/boarddeck/bvaService.js';
import * as reportService from '../../services/ledger-core/reportService.js';
import * as organizationService from '../../services/organizationService.js';
import * as storageService from '../../services/storageService.js';
import { buildDeck } from '../../services/boarddeck/deckBuilderService.js';
import { ApiError } from '../../utils/apiError.js';
import type { JobPayloads } from '../../types/jobs.js';
import type { SummarizedVariance } from '../../utils/boarddeckVariance.js';

/**
 * BoardDeck's deck-generation job handler (Phase 15). Runs in the worker
 * process, so the AsyncLocalStorage-published audit actor
 * (utils/requestContext.ts) does not cross the process boundary — rows this
 * handler causes to be audited carry a null actor, the same accepted
 * behaviour the outbox drain and the AP-Flow extract handler already have.
 */

export async function handleBoardDeckGenerate(payload: JobPayloads['boarddeck-generate']): Promise<void> {
  const { orgId, deckId } = payload;

  const deck = await deckService.loadForGeneration(orgId, deckId);
  if (deck === null) {
    // The deck was deleted; retrying is pointless.
    console.warn(`[worker] boarddeck-generate: deck ${deckId} no longer exists`);
    return;
  }

  const started = await deckService.markGenerating(orgId, deckId);
  if (!started) {
    // Duplicate job under at-least-once delivery, or the deck has already
    // moved past PENDING — a no-op, not an error.
    return;
  }

  try {
    const org = await organizationService.getById(orgId);
    const pnl = await reportService.profitAndLoss(orgId, deck.periodStartsOn, deck.periodEndsOn);
    const bs = await reportService.balanceSheet(orgId, deck.periodEndsOn);
    const closeChecks = await closeRunService.findChecksForPeriod(orgId, deck.fiscalPeriodId);

    let bva: SummarizedVariance | null = null;
    if (deck.planId !== null) {
      try {
        const from = `${deck.periodStartsOn.slice(0, 7)}-01`;
        const to = `${deck.periodEndsOn.slice(0, 7)}-01`;
        const report = await bvaService.bvaReport(orgId, deck.planId, from, to, 5);
        bva = report.summary;
      } catch (err) {
        // No approved budget version must not fail the whole deck — every
        // other error propagates.
        if (!(err instanceof ApiError && err.status === 422)) throw err;
      }
    }

    const { buffer, slideCount } = await buildDeck({
      orgName: org.name,
      baseCurrency: org.baseCurrency,
      title: deck.title,
      periodStartsOn: deck.periodStartsOn,
      periodEndsOn: deck.periodEndsOn,
      profitAndLoss: pnl,
      balanceSheet: bs,
      closeChecks,
      bva,
    });

    const { sha256 } = await storageService.put(orgId, buffer);
    await deckService.markReady(orgId, deckId, { sha256, byteSizeBytes: buffer.byteLength, slideCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await deckService.markFailed(orgId, deckId, message);
    // Re-thrown so BullMQ retries, and a terminal failure still reaches the
    // dead-letter queue via the worker's existing 'failed' listener.
    throw err instanceof Error ? err : new Error(message);
  }
}
