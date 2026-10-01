import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import {
  EMAIL_DRAIN_BATCH,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RETRY_BASE_MS,
  EMAIL_STALE_CLAIM_MS,
} from '../../config/constants.js';
import { decryptSecret, encryptSecret } from '../../utils/secretBox.js';
import { logger } from '../../utils/logger.js';
import { isEmailTemplate, type EmailTemplate } from '../../types/email.js';
import { renderEmail } from './templates.js';
import { MailSendError, transportFromEnv, type MailTransport } from './transports.js';

/**
 * Phase 38b — the transactional email outbox. See docs/architecture.md
 * § Email and study/architecture/transactional-outbox-for-email.md.
 *
 * Producers call `enqueueEmailOnClient` on the transaction that makes the
 * change the email is about (a reset token, an invitation, a submitted
 * bill). If that transaction rolls back, the email never existed; if it
 * commits, the email is guaranteed to be attempted. Sending from inside the
 * transaction would hold a connection across a network call and could send
 * an email about a change that then rolls back; sending after COMMIT would
 * lose the email if the process died in between (rule 5).
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface EnqueueEmailInput {
  orgId: string | null;
  to: string;
  toName?: string | null;
  template: EmailTemplate;
  /** Non-secret values the template renders. Stored as-is. */
  data?: Record<string, unknown>;
  /** A token-bearing link. Encrypted at rest when a key is configured; cleared once sent. */
  link?: string | null;
}

/**
 * Writes one outbox row on the caller's transaction. An organization's
 * sender name and reply-to (Organization settings → Email) are resolved
 * now, on the same client, so the email reflects the settings at the moment
 * of the change.
 */
export async function enqueueEmailOnClient(client: Queryable, input: EnqueueEmailInput): Promise<string> {
  let senderName: string | null = null;
  let replyTo: string | null = null;
  if (input.orgId !== null) {
    const { rows } = await client.query<{ sender_name: string | null; reply_to: string | null }>(
      'SELECT sender_name, reply_to FROM organization_email_settings WHERE org_id = $1',
      [input.orgId],
    );
    senderName = rows[0]?.sender_name ?? null;
    replyTo = rows[0]?.reply_to ?? null;
  }

  const link = input.link ?? null;
  const key = env.INTEGRATION_ENCRYPTION_KEY;
  const encrypted = link !== null && key !== '';

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO email_outbox
       (org_id, to_email, to_name, template, template_data, secret_link, secret_encrypted, sender_name, reply_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.orgId,
      input.to.toLowerCase(),
      input.toName ?? null,
      input.template,
      JSON.stringify(input.data ?? {}),
      link === null ? null : encrypted ? encryptSecret(link, key) : link,
      encrypted,
      senderName,
      replyTo,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return id;
}

interface ClaimedRow {
  id: string;
  to_email: string;
  to_name: string | null;
  template: string;
  template_data: Record<string, unknown>;
  secret_link: string | null;
  secret_encrypted: boolean;
  sender_name: string | null;
  reply_to: string | null;
  attempts: number;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  reclaimed: number;
}

/** 30s, 60s, 120s, … capped at 30 minutes. */
function backoffMs(attempts: number): number {
  return Math.min(EMAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), 30 * 60 * 1000);
}

/**
 * One drain pass, run by the `email-drain` repeating job. A platform
 * process: it reads every organization's rows (as `outbox-drain` does for
 * webhooks), so there is no `org_id` predicate to apply here.
 *
 * 1. Reclaim: SENDING rows whose worker died mid-send go back to PENDING.
 * 2. Claim: due PENDING rows → SENDING with `FOR UPDATE SKIP LOCKED`, in a
 *    short transaction of its own, so two workers never claim the same row
 *    and no transaction is held open across the network call.
 * 3. Send each claimed row, then record SENT / PENDING (backed off) / FAILED.
 *    A finished row's link is cleared (CHECK ck_email_outbox_link_cleared).
 */
export async function drainEmailOutbox(
  options: { transport?: MailTransport; batchSize?: number } = {},
): Promise<DrainResult> {
  const transport = options.transport ?? transportFromEnv();
  const batchSize = options.batchSize ?? EMAIL_DRAIN_BATCH;

  const reclaimed = await pool.query(
    `UPDATE email_outbox SET status = 'PENDING', claimed_at = NULL, next_attempt_at = now()
      WHERE status = 'SENDING' AND claimed_at < now() - ($1::int * interval '1 millisecond')`,
    [EMAIL_STALE_CLAIM_MS],
  );

  const { rows } = await pool.query<ClaimedRow>(
    `UPDATE email_outbox o
        SET status = 'SENDING', claimed_at = now(), attempts = o.attempts + 1
      WHERE o.id IN (
              SELECT id FROM email_outbox
               WHERE status = 'PENDING' AND next_attempt_at <= now()
               ORDER BY next_attempt_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.to_email, o.to_name, o.template, o.template_data, o.secret_link,
                o.secret_encrypted, o.sender_name, o.reply_to, o.attempts`,
    [batchSize],
  );

  const result: DrainResult = { claimed: rows.length, sent: 0, retried: 0, failed: 0, reclaimed: reclaimed.rowCount ?? 0 };

  for (const row of rows) {
    try {
      if (!isEmailTemplate(row.template)) throw new MailSendError(`Unknown template "${row.template}"`, true);
      let link: string | null = row.secret_link;
      if (link !== null && row.secret_encrypted) {
        if (env.INTEGRATION_ENCRYPTION_KEY === '') {
          throw new MailSendError('Link was encrypted but INTEGRATION_ENCRYPTION_KEY is no longer set', true);
        }
        try {
          link = decryptSecret(link, env.INTEGRATION_ENCRYPTION_KEY);
        } catch {
          throw new MailSendError('Link could not be decrypted (encryption key changed?)', true);
        }
      }

      const rendered = renderEmail(row.template, row.template_data, link);
      const sent = await transport.send({
        ...rendered,
        to: { email: row.to_email, name: row.to_name },
        from: { email: env.MAIL_FROM_EMAIL, name: row.sender_name ?? env.MAIL_FROM_NAME },
        replyTo: row.reply_to,
      });

      // SENDING → SENT (EMAIL_STATUS_TRANSITIONS).
      await pool.query(
        `UPDATE email_outbox
            SET status = 'SENT', sent_at = now(), secret_link = NULL, provider_message_id = $2, last_error = NULL
          WHERE id = $1 AND status = 'SENDING'`,
        [row.id, sent.providerMessageId],
      );
      result.sent += 1;
    } catch (err) {
      const permanent = err instanceof MailSendError && err.permanent;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (permanent || row.attempts >= EMAIL_MAX_ATTEMPTS) {
        // SENDING → FAILED. The link goes with it.
        await pool.query(
          `UPDATE email_outbox SET status = 'FAILED', secret_link = NULL, last_error = $2
            WHERE id = $1 AND status = 'SENDING'`,
          [row.id, message],
        );
        result.failed += 1;
        logger.warn({ emailId: row.id, template: row.template, err: message }, 'email failed permanently');
      } else {
        // SENDING → PENDING, backed off.
        await pool.query(
          `UPDATE email_outbox
              SET status = 'PENDING', claimed_at = NULL, last_error = $2,
                  next_attempt_at = now() + ($3::int * interval '1 millisecond')
            WHERE id = $1 AND status = 'SENDING'`,
          [row.id, message, backoffMs(row.attempts)],
        );
        result.retried += 1;
      }
    }
  }
  return result;
}
