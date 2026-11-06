import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { INVOICE_REMINDER_BATCH } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { reminderOffsetDue } from '../../utils/invoiceReminders.js';
import { getInvoiceSettings } from './invoiceSettingsService.js';
import { sendInvoiceOnClient } from './invoiceSendService.js';
import { allocatedCentsSubquery, depositAppliedCentsSubquery, noteAppliedCentsSubquery } from './settlementSql.js';

/**
 * Phase 48 — payment reminders. A sweep (worker.ts, hourly) asks, per
 * organization with reminders on, which issued invoices owe one. Exactly-once
 * is decided inside one transaction per invoice: a transaction-scoped advisory
 * lock serialises concurrent sweeps on that invoice, the reminder row is
 * checked, the send is enqueued and the reminder row inserted. The UNIQUE
 * (org_id, invoice_id, offset_days) constraint is the final guard.
 */

/**
 * Platform sweep: the one org-less query in this file. It returns only
 * organization ids; everything after it is scoped by org_id.
 */
export async function listOrgsWithReminders(): Promise<string[]> {
  const { rows } = await pool.query<{ org_id: string }>(
    'SELECT org_id FROM ledger_invoice_settings WHERE reminders_enabled',
  );
  return rows.map((r) => r.org_id);
}

interface CandidateRow {
  id: string;
  due_date: string;
  created_by: string;
  sent_offsets: number[];
}

export async function sendDueRemindersForOrg(
  orgId: string,
  today: string,
): Promise<{ sent: number; failed: number }> {
  const settings = await getInvoiceSettings(orgId);
  if (!settings.remindersEnabled) return { sent: 0, failed: 0 };

  const { rows } = await pool.query<CandidateRow>(
    `SELECT i.id, i.due_date::text AS due_date, i.created_by,
            COALESCE((SELECT array_agg(r.offset_days)
                        FROM invoice_reminders r
                       WHERE r.org_id = i.org_id AND r.invoice_id = i.id), '{}') AS sent_offsets
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
      WHERE i.org_id = $1
        AND i.status = 'ISSUED'
        AND COALESCE(btrim(c.email), '') <> ''
        AND i.total_cents
            - (${allocatedCentsSubquery('i', 'invoice_id')})::bigint
            - (${noteAppliedCentsSubquery('i', 'invoice_id')})::bigint
            - (${depositAppliedCentsSubquery('i', 'invoice_id')})::bigint > 0
        AND EXISTS (SELECT 1
                      FROM invoice_sends s
                      LEFT JOIN email_outbox e ON e.id = s.email_id
                     WHERE s.org_id = i.org_id AND s.invoice_id = i.id
                       AND COALESCE(e.status, 'SENT') <> 'FAILED')
      ORDER BY i.due_date, i.id
      LIMIT $2`,
    [orgId, INVOICE_REMINDER_BATCH],
  );

  let sent = 0;
  let failed = 0;
  for (const invoice of rows) {
    const offset = reminderOffsetDue(invoice.due_date, today, settings.reminderOffsetsDays, invoice.sent_offsets);
    if (offset === null) continue;

    try {
      const didSend = await withTransaction(async (client) => {
        // Serialise concurrent sweeps on this invoice. invoice_send_id is NOT
        // NULL, so the reminder row cannot be reserved before the send exists;
        // the lock makes check-then-send-then-insert safe instead.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${orgId}:${invoice.id}`]);
        const existing = await client.query(
          'SELECT 1 FROM invoice_reminders WHERE org_id = $1 AND invoice_id = $2 AND offset_days = $3',
          [orgId, invoice.id, offset],
        );
        if (existing.rows.length > 0) return false;

        const send = await sendInvoiceOnClient(client, orgId, invoice.created_by, {
          invoiceId: invoice.id,
          sendKind: 'REMINDER',
          toEmail: null,
          message: null,
          overdue: invoice.due_date < today,
        });
        if (send === null) return false;

        await client.query(
          `INSERT INTO invoice_reminders (org_id, invoice_id, offset_days, invoice_send_id)
           VALUES ($1, $2, $3, $4)`,
          [orgId, invoice.id, offset, send.id],
        );
        return true;
      });
      if (didSend) sent += 1;
    } catch (err) {
      // The unique constraint rolled back the send and its email together:
      // another sweep got there first. Neither sent nor failed.
      if ((err as { code?: string }).code === '23505') continue;
      logger.error({ err, orgId, invoiceId: invoice.id }, 'invoice reminder failed');
      failed += 1;
    }
  }
  return { sent, failed };
}
