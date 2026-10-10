import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import { formatCents, cents } from '../../utils/money.js';
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPreference,
} from '../../types/email.js';
import { enqueueEmailOnClient } from './emailOutboxService.js';

/**
 * Phase 38b — notification emails and each user's opt-outs.
 *
 * Preferences are per user (an inbox belongs to a person), stored as
 * opt-outs: no row means enabled, so a new event reaches everyone without a
 * backfill. Every notification is enqueued on the transaction of the change
 * it describes (`*OnClient`), through the email outbox.
 */

type Queryable = Pick<PoolClient, 'query'>;

/** GET /auth/me/notifications — every event, with this user's setting. */
export async function getPreferences(userId: string): Promise<NotificationPreference[]> {
  const { rows } = await pool.query<{ event: string; enabled: boolean }>(
    'SELECT event, enabled FROM user_notification_preferences WHERE user_id = $1',
    [userId],
  );
  const stored = new Map(rows.map((r) => [r.event, r.enabled]));
  return NOTIFICATION_EVENTS.map((event) => ({ event, enabled: stored.get(event) ?? true }));
}

/** PUT /auth/me/notifications — upserts each given event. */
export async function setPreferences(userId: string, prefs: NotificationPreference[]): Promise<NotificationPreference[]> {
  for (const pref of prefs) {
    await pool.query(
      `INSERT INTO user_notification_preferences (user_id, event, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, event) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [userId, pref.event, pref.enabled],
    );
  }
  return getPreferences(userId);
}

/** Of `userIds`, those who have not opted out of `event`. */
async function optedIn(q: Queryable, userIds: string[], event: NotificationEvent): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await q.query<{ user_id: string }>(
    `SELECT user_id FROM user_notification_preferences
      WHERE user_id = ANY($1::uuid[]) AND event = $2 AND enabled = false`,
    [userIds, event],
  );
  const out = new Set(rows.map((r) => r.user_id));
  return new Set(userIds.filter((id) => !out.has(id)));
}

function frontendUrl(path: string): string {
  return `${new URL(env.FRONTEND_URL).origin}${path}`;
}

/**
 * A bill moved to AWAITING_APPROVAL: email everyone in the organization who
 * can approve it, except the person who submitted it.
 *
 * "Can approve" is the `POST /bills/:id/approve` gate — OWNER and ADMIN —
 * read from the membership table, not from anyone's token.
 */
export async function notifyBillAwaitingApprovalOnClient(
  client: Queryable,
  orgId: string,
  billId: string,
  submittedBy: string | null,
): Promise<number> {
  const { rows: billRows } = await client.query<{
    vendor_name: string;
    vendor_reference: string;
    total_cents: string;
    currency_code: string;
    org_name: string;
  }>(
    `SELECT v.name AS vendor_name, b.vendor_reference, b.total_cents, b.currency_code, o.name AS org_name
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
       JOIN organizations o ON o.id = b.org_id
      WHERE b.org_id = $1 AND b.id = $2`,
    [orgId, billId],
  );
  const bill = billRows[0];
  if (bill === undefined) return 0;

  const { rows: approvers } = await client.query<{ user_id: string; email: string; name: string | null }>(
    `SELECT u.id AS user_id, u.email, u.name
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role IN ('OWNER', 'ADMIN') AND ($2::uuid IS NULL OR u.id <> $2::uuid)`,
    [orgId, submittedBy],
  );
  const recipients = await optedIn(client, approvers.map((a) => a.user_id), 'bill_awaiting_approval');

  let count = 0;
  for (const approver of approvers) {
    if (!recipients.has(approver.user_id)) continue;
    await enqueueEmailOnClient(client, {
      orgId,
      to: approver.email,
      toName: approver.name,
      template: 'bill_awaiting_approval',
      data: {
        organizationName: bill.org_name,
        vendorName: bill.vendor_name,
        billNumber: bill.vendor_reference,
        amount: `${bill.currency_code.trim()} ${formatCents(cents(Number(bill.total_cents)))}`,
        url: frontendUrl(`/expenses/${billId}`),
      },
    });
    count += 1;
  }
  return count;
}

/** An invitation was accepted: tell the person who sent it, if they want to know. */
export async function notifyInvitationAcceptedOnClient(
  client: Queryable,
  orgId: string,
  inviterId: string | null,
  member: { name: string | null; email: string },
): Promise<boolean> {
  if (inviterId === null) return false;
  const { rows } = await client.query<{ email: string; name: string | null; org_name: string }>(
    `SELECT u.email, u.name, o.name AS org_name
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.org_id
      WHERE m.org_id = $1 AND m.user_id = $2`,
    [orgId, inviterId],
  );
  const inviter = rows[0];
  // The inviter may have left the organization since; then there is no one to tell.
  if (inviter === undefined) return false;
  if (!(await optedIn(client, [inviterId], 'invitation_accepted')).has(inviterId)) return false;

  await enqueueEmailOnClient(client, {
    orgId,
    to: inviter.email,
    toName: inviter.name,
    template: 'invitation_accepted',
    data: { organizationName: inviter.org_name, memberName: member.name ?? member.email },
  });
  return true;
}

/**
 * Phase 41 — a quote was accepted or declined (on its public page, or
 * recorded by a colleague): tell the person who sent it, if they are still a
 * member and have not opted out. Enqueued on the response's own transaction.
 */
export async function notifyQuoteRespondedOnClient(
  client: Queryable,
  orgId: string,
  quoteId: string,
  response: { response: 'ACCEPTED' | 'DECLINED'; signerName: string | null; declineReason: string | null },
  respondedBy: string | null,
): Promise<boolean> {
  const { rows } = await client.query<{
    sent_by: string | null;
    direction: string;
    quote_number: string | null;
    party_name_snapshot: string;
    email: string;
    name: string | null;
    org_name: string;
  }>(
    `SELECT q.sent_by, q.direction, q.quote_number, q.party_name_snapshot, u.email, u.name, o.name AS org_name
       FROM quotes q
       JOIN organization_members m ON m.org_id = q.org_id AND m.user_id = q.sent_by
       JOIN users u ON u.id = q.sent_by
       JOIN organizations o ON o.id = q.org_id
      WHERE q.org_id = $1 AND q.id = $2`,
    [orgId, quoteId],
  );
  const quote = rows[0];
  // Never sent by anyone still in the organization: there is no one to tell.
  if (quote === undefined || quote.sent_by === null) return false;
  // Recording your own colleague's answer needs no email to yourself.
  if (respondedBy !== null && respondedBy === quote.sent_by) return false;
  if (!(await optedIn(client, [quote.sent_by], 'quote_responded')).has(quote.sent_by)) return false;

  const path = quote.direction === 'PURCHASE' ? `/purchase-quotes/${quoteId}` : `/quotes/${quoteId}`;
  await enqueueEmailOnClient(client, {
    orgId,
    to: quote.email,
    toName: quote.name,
    template: 'quote_responded',
    data: {
      organizationName: quote.org_name,
      partyName: quote.party_name_snapshot,
      quoteNumber: quote.quote_number ?? '',
      response: response.response,
      signerName: response.signerName,
      declineReason: response.declineReason,
      url: frontendUrl(path),
    },
  });
  return true;
}
