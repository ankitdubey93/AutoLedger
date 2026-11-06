import * as reminderService from '../../services/accounting/invoiceReminderService.js';
import { todayIso } from '../../services/accounting/statementService.js';
import type { JobPayloads } from '../../types/jobs.js';
import { logger } from '../../utils/logger.js';

/**
 * Runs every INVOICE_REMINDER_SWEEP_INTERVAL_MS (worker.ts's job scheduler).
 * One organization at a time, each in its own try/catch, so one org's failure
 * never blocks another's. Exactly-once is enforced in the service, not here.
 */
export async function handleInvoiceReminderSweep(_payload: JobPayloads['invoice-reminder-sweep']): Promise<void> {
  const today = todayIso();
  const orgIds = await reminderService.listOrgsWithReminders();
  for (const orgId of orgIds) {
    try {
      await reminderService.sendDueRemindersForOrg(orgId, today);
    } catch (err) {
      logger.error({ err, orgId }, 'invoice reminder sweep failed for organization');
    }
  }
}
