import * as quoteService from '../../services/accounting/quoteService.js';
import type { JobPayloads } from '../../types/jobs.js';
import { logger } from '../../utils/logger.js';

/**
 * Runs every QUOTE_EXPIRY_SWEEP_INTERVAL_MS (worker.ts's job scheduler).
 * Persists EXPIRED on every SENT quote past its `valid_until`, one org per
 * transaction, so one org's failure never blocks another's.
 *
 * Correctness does not depend on this job: every read derives the
 * effective status from the date, and accepting re-checks it. The sweep
 * exists so EXPIRED is a recorded fact in the audit trail and filterable.
 */
export async function handleQuoteExpirySweep(_payload: JobPayloads['quote-expiry-sweep']): Promise<void> {
  const orgIds = await quoteService.listOrgsWithExpiredSentQuotes();
  for (const orgId of orgIds) {
    try {
      await quoteService.expireQuotesForOrg(orgId);
    } catch (err) {
      logger.error({ err, orgId }, 'quote expiry sweep failed for organization');
    }
  }
}
