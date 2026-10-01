import { drainEmailOutbox } from '../../services/mail/emailOutboxService.js';
import type { JobPayloads } from '../../types/jobs.js';
import { logger } from '../../utils/logger.js';

/**
 * Phase 38b — runs every EMAIL_DRAIN_INTERVAL_MS (worker.ts's job
 * scheduler). One pass over `email_outbox`; the retry policy lives in the
 * rows themselves (`attempts`, `next_attempt_at`), not in BullMQ, so the
 * job runs with attempts: 1 and the next tick picks up anything left.
 */
export async function handleEmailDrain(_payload: JobPayloads['email-drain']): Promise<void> {
  const result = await drainEmailOutbox();
  if (result.claimed > 0 || result.reclaimed > 0) {
    logger.info(result, '[email-drain] pass complete');
  }
}
