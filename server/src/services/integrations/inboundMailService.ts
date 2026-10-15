import { randomBytes } from 'node:crypto';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { MAX_UPLOAD_BYTES } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { logger } from '../../utils/logger.js';
import { enqueue } from '../../queue/queues.js';
import * as captureDocumentService from '../capture/captureDocumentService.js';
import { downloadAttachment, type ParsedInboundEmail } from './brevoInbound.js';

/**
 * Phase 43d — each organization's email-in address for the bill inbox, and the
 * intake of what arrives there.
 *
 * TENANCY NOTE (rule 1): `recordInboundBatch`'s first query, the lookup of an
 * ACTIVE address by its token, is the only statement in this phase with no
 * `org_id` predicate. That is inherent: an inbound email carries no session
 * and no organization; the unguessable token (80 bits of crypto.randomBytes,
 * globally unique) is how the organization is discovered. From that row on,
 * every statement is scoped by the discovered `org_id`. An unknown or
 * rotated token is skipped silently so the webhook is no oracle for which
 * addresses exist.
 *
 * Rule 16: the attachment reaches the bill inbox through
 * `captureDocumentService.captureFile` only — the same path a direct upload
 * takes, so extraction, PII masking and metering are unchanged.
 */

export const INBOUND_PROVIDER = 'brevo';
const ELIGIBLE_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const ERROR_MAX = 500;
const PROCESS_ATTEMPTS = 3;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export interface InboundAddress {
  address: string;
  rotatedAt: string | null;
}

export interface InboundMessage {
  id: string;
  fromAddress: string;
  subject: string | null;
  receivedAt: string;
  status: string;
  attachmentCount: number;
  importedCount: number;
  error: string | null;
}

export function assertInboundEnabled(): void {
  if (env.INBOUND_MAIL === 'off') throw new ApiError(404, 'Email-in is not enabled');
}

/** 10 random bytes = 80 bits = exactly 16 base32 characters (RFC 4648 alphabet, lowercased). */
function newToken(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

function toAddress(token: string, rotatedAt: Date | null): InboundAddress {
  return {
    address: `${token}@${env.INBOUND_MAIL_DOMAIN}`,
    rotatedAt: rotatedAt === null ? null : rotatedAt.toISOString(),
  };
}

export async function getOrCreateAddress(orgId: string, userId: string): Promise<InboundAddress> {
  assertInboundEnabled();
  const { rows } = await pool.query<{ token: string; rotated_at: Date | null }>(
    `SELECT token, rotated_at FROM inbound_mail_addresses
      WHERE org_id = $1 AND purpose = 'VENDOR_BILL' AND is_active`,
    [orgId],
  );
  const existing = rows[0];
  if (existing !== undefined) return toAddress(existing.token, existing.rotated_at);
  return insertAddress(orgId, userId, null);
}

async function insertAddress(orgId: string, userId: string, rotatedAt: Date | null): Promise<InboundAddress> {
  // ON CONFLICT on the one-active-per-org index: a concurrent first GET loses
  // quietly and re-reads the winner's row.
  const token = newToken();
  const { rows } = await pool.query<{ token: string; rotated_at: Date | null }>(
    `INSERT INTO inbound_mail_addresses (org_id, token, purpose, created_by, rotated_at)
     VALUES ($1, $2, 'VENDOR_BILL', $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING token, rotated_at`,
    [orgId, token, userId, rotatedAt],
  );
  const inserted = rows[0];
  if (inserted !== undefined) return toAddress(inserted.token, inserted.rotated_at);
  const { rows: current } = await pool.query<{ token: string; rotated_at: Date | null }>(
    `SELECT token, rotated_at FROM inbound_mail_addresses
      WHERE org_id = $1 AND purpose = 'VENDOR_BILL' AND is_active`,
    [orgId],
  );
  const winner = current[0];
  if (winner === undefined) throw new ApiError(409, 'Could not create the address — try again');
  return toAddress(winner.token, winner.rotated_at);
}

/** Deactivates the current address (its token never routes again) and issues a new one, in one transaction. */
export async function rotateAddress(orgId: string, userId: string): Promise<InboundAddress> {
  assertInboundEnabled();
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await client.query(
      `UPDATE inbound_mail_addresses SET is_active = false
        WHERE org_id = $1 AND purpose = 'VENDOR_BILL' AND is_active`,
      [orgId],
    );
    const { rows } = await client.query<{ token: string; rotated_at: Date }>(
      `INSERT INTO inbound_mail_addresses (org_id, token, purpose, created_by, rotated_at)
       VALUES ($1, $2, 'VENDOR_BILL', $3, now())
       RETURNING token, rotated_at`,
      [orgId, newToken(), userId],
    );
    await client.query('COMMIT');
    const row = rows[0];
    if (row === undefined) throw new Error('Address insert returned no row');
    return toAddress(row.token, row.rotated_at);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listMessages(
  orgId: string,
  page: number,
  limit: number,
): Promise<{ messages: InboundMessage[]; totalCount: number; currentPage: number; totalPages: number }> {
  assertInboundEnabled();
  const { rows: countRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM inbound_messages WHERE org_id = $1',
    [orgId],
  );
  const totalCount = Number(countRows[0]?.count ?? '0');
  const { rows } = await pool.query<{
    id: string;
    from_address: string;
    subject: string | null;
    received_at: Date;
    status: string;
    attachment_count: number;
    imported_count: number;
    error: string | null;
  }>(
    `SELECT id, from_address, subject, received_at, status, attachment_count, imported_count, error
       FROM inbound_messages
      WHERE org_id = $1
      ORDER BY received_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [orgId, limit, (page - 1) * limit],
  );
  return {
    messages: rows.map((r) => ({
      id: r.id,
      fromAddress: r.from_address,
      subject: r.subject,
      receivedAt: r.received_at.toISOString(),
      status: r.status,
      attachmentCount: r.attachment_count,
      importedCount: r.imported_count,
      error: r.error,
    })),
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  };
}

/**
 * Records one message row per (matched organization, provider message id) and
 * queues its processing. Idempotent: a provider retry of the same webhook hits
 * ux_inbound_messages_provider_msg and creates nothing. Never throws for an
 * unmatched recipient.
 */
export async function recordInboundBatch(emails: readonly ParsedInboundEmail[]): Promise<void> {
  const domain = env.INBOUND_MAIL_DOMAIN;
  for (const email of emails) {
    const tokens = new Set<string>();
    for (const recipient of email.recipients) {
      const at = recipient.lastIndexOf('@');
      if (at <= 0 || recipient.slice(at + 1) !== domain) continue;
      tokens.add(recipient.slice(0, at));
    }
    for (const token of tokens) {
      // The one query without an org_id predicate — see the file header.
      const { rows: addressRows } = await pool.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM inbound_mail_addresses WHERE token = $1 AND is_active`,
        [token],
      );
      const address = addressRows[0];
      if (address === undefined) continue;

      const { rows: inserted } = await pool.query<{ id: string }>(
        `INSERT INTO inbound_messages
           (org_id, address_id, provider, provider_message_id, from_address, subject, attachment_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ON CONSTRAINT ux_inbound_messages_provider_msg DO NOTHING
         RETURNING id`,
        [
          address.org_id,
          address.id,
          INBOUND_PROVIDER,
          email.messageId,
          email.fromAddress,
          email.subject,
          email.attachments.length,
        ],
      );
      const row = inserted[0];
      if (row === undefined) continue;

      try {
        await enqueue(
          'inbound-mail-process',
          { orgId: address.org_id, messageId: row.id, attachments: email.attachments },
          { jobId: `inbound-mail-${row.id}`, attempts: PROCESS_ATTEMPTS },
        );
      } catch (err) {
        // The row exists but nothing will process it: say so rather than leave it RECEIVED forever.
        await pool.query(
          `UPDATE inbound_messages SET status = 'FAILED', error = $3 WHERE org_id = $1 AND id = $2`,
          [address.org_id, row.id, 'Could not queue the message for processing'],
        );
        logger.error({ err: err instanceof Error ? err.message : 'unknown' }, '[inbound-mail] enqueue failed');
      }
    }
  }
}

/**
 * Worker side. Re-reads the message row (org-scoped), imports each eligible
 * attachment through the bill inbox, and records the outcome. A content
 * problem with one attachment (an ApiError from capture: wrong type, corrupt)
 * skips that attachment; anything else (a failed download, a database error)
 * marks the message FAILED and rethrows so the queue retries. A retry may
 * re-capture an attachment that already landed; capture records that as a
 * visible DUPLICATE row for a human, never silently.
 */
export async function processInboundMessage(
  orgId: string,
  messageId: string,
  attachments: readonly { downloadToken: string; name: string; contentType: string; contentLength: number }[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { rows } = await pool.query<{ status: string; created_by: string }>(
    `SELECT m.status, a.created_by
       FROM inbound_messages m
       JOIN inbound_mail_addresses a ON a.org_id = m.org_id AND a.id = m.address_id
      WHERE m.org_id = $1 AND m.id = $2`,
    [orgId, messageId],
  );
  const message = rows[0];
  if (message === undefined) return;
  if (message.status !== 'RECEIVED' && message.status !== 'FAILED') return;

  const eligible = attachments.filter(
    (a) => ELIGIBLE_TYPES.has(a.contentType) && a.contentLength <= MAX_UPLOAD_BYTES,
  );
  if (eligible.length === 0) {
    await setOutcome(orgId, messageId, 'REJECTED', 0, 'No PDF, PNG or JPEG attachment');
    return;
  }

  let imported = 0;
  try {
    for (const attachment of eligible) {
      const buffer = await downloadAttachment(attachment.downloadToken, fetchImpl);
      try {
        await captureDocumentService.captureFile(orgId, message.created_by, {
          buffer,
          originalname: attachment.name,
        });
        imported += 1;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
      }
    }
  } catch (err) {
    await setOutcome(
      orgId,
      messageId,
      'FAILED',
      imported,
      (err instanceof Error ? err.message : 'Processing failed').slice(0, ERROR_MAX),
    );
    throw err;
  }

  if (imported === eligible.length) await setOutcome(orgId, messageId, 'IMPORTED', imported, null);
  else if (imported > 0) await setOutcome(orgId, messageId, 'PARTIAL', imported, 'Some attachments could not be read as a bill');
  else await setOutcome(orgId, messageId, 'REJECTED', 0, 'No attachment could be read as a bill');
}

async function setOutcome(
  orgId: string,
  messageId: string,
  status: 'IMPORTED' | 'PARTIAL' | 'REJECTED' | 'FAILED',
  importedCount: number,
  error: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE inbound_messages SET status = $3, imported_count = $4, error = $5
      WHERE org_id = $1 AND id = $2`,
    [orgId, messageId, status, importedCount, error],
  );
}
