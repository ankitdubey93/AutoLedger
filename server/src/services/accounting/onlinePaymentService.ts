import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { logger } from '../../utils/logger.js';
import * as stripeClient from '../payments/stripeClient.js';
import type { StripeDeps } from '../payments/stripeClient.js';
import { createPaymentOnClient } from './paymentService.js';
import { settledCentsOnClient } from './settlementSql.js';
import { resolveLiveSend, type LiveSend, type PublicPaymentOptions } from './statementLinkService.js';
import { todayIso } from './statementService.js';
import {
  canTransitionOnlinePayment,
  type OnlinePayment,
  type OnlinePaymentSettings,
  type OnlinePaymentStatus,
} from '../../types/accounting.js';

/**
 * Paying an emailed statement by card (Phase 39c).
 *
 * The flow, and who is trusted for what:
 *   1. `startPayment` — the customer picks invoices on the public page. The
 *      SERVER computes each one's outstanding amount under a row lock; the
 *      browser never sends an amount. A PENDING `online_payments` row is
 *      committed first, then a Stripe PaymentIntent is created for exactly
 *      that total, idempotency-keyed by the row's id. Only the intent's
 *      client secret goes back to the browser.
 *   2. The browser hands the card to Stripe directly (Elements). Card data
 *      never reaches this server.
 *   3. `settleIntent` — called by BOTH the browser (right after Stripe says
 *      "succeeded") and Stripe's webhook, in either order, any number of
 *      times. It re-reads the intent from Stripe (never trusting the caller's
 *      word), locks the row, and records exactly one `payments` row through
 *      paymentService — the GL effect is the ordinary receipt journal. A
 *      second call finds the row RECORDED and does nothing.
 *
 * If money arrived but cannot be applied as chosen (an invoice was paid or
 * voided in the meantime, the period is closed, no FX rate), the row goes to
 * NEEDS_REVIEW with the reason instead of failing silently.
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_RAISE_EXCEPTION = 'P0001';

/** Currencies whose minor unit is not 1/100 — Stripe amounts would not be "cents". Refused (no minor-unit table yet). */
const NON_TWO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);

// ----------------------------------------------------------------- settings

interface SettingsRow {
  enabled: boolean;
  deposit_account_id: string | null;
}

async function readSettings(q: Queryable, orgId: string): Promise<SettingsRow> {
  const { rows } = await q.query<SettingsRow>(
    'SELECT enabled, deposit_account_id FROM ledger_online_payment_settings WHERE org_id = $1',
    [orgId],
  );
  return rows[0] ?? { enabled: false, deposit_account_id: null };
}

/** GET /settings/online-payments */
export async function getSettings(orgId: string, deps?: StripeDeps): Promise<OnlinePaymentSettings> {
  const row = await readSettings(pool, orgId);
  return {
    enabled: row.enabled,
    depositAccountId: row.deposit_account_id,
    providerConfigured: stripeClient.stripeConfig(deps) !== null,
  };
}

/** PATCH /settings/online-payments. Enabling needs a postable Asset account to deposit into. */
export async function updateSettings(
  orgId: string,
  input: { enabled?: boolean | undefined; depositAccountId?: string | null | undefined },
): Promise<OnlinePaymentSettings> {
  await withTransaction(async (client) => {
    const current = await readSettings(client, orgId);
    const enabled = input.enabled ?? current.enabled;
    const depositAccountId = input.depositAccountId === undefined ? current.deposit_account_id : input.depositAccountId;

    if (depositAccountId !== null) {
      const { rows } = await client.query<{ code: string; is_postable: boolean; type: string; is_active: boolean }>(
        'SELECT code, is_postable, type, is_active FROM accounts WHERE org_id = $1 AND id = $2',
        [orgId, depositAccountId],
      );
      const account = rows[0];
      if (account === undefined) throw new ApiError(422, 'Account does not exist in this organization');
      if (account.type !== 'Asset' || !account.is_postable || !account.is_active) {
        throw new ApiError(422, `Account ${account.code} must be an active, postable Asset account`);
      }
    }
    if (enabled && depositAccountId === null) {
      throw new ApiError(422, 'Choose the account online payments are deposited into before turning them on');
    }

    await client.query(
      `INSERT INTO ledger_online_payment_settings (org_id, enabled, deposit_account_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, deposit_account_id = EXCLUDED.deposit_account_id`,
      [orgId, enabled, depositAccountId],
    );
  });
  return getSettings(orgId);
}

/** Whether a statement link offers card payment: a customer send, enabled by the org, keys configured. */
export async function paymentOptionsFor(send: LiveSend, deps?: StripeDeps): Promise<PublicPaymentOptions> {
  const config = stripeClient.stripeConfig(deps);
  if (send.partyKind !== 'CUSTOMER' || config === null) return { enabled: false, publishableKey: null };
  const settings = await readSettings(pool, send.orgId);
  const enabled = settings.enabled && settings.deposit_account_id !== null;
  return { enabled, publishableKey: enabled ? config.publishableKey : null };
}

// ------------------------------------------------------------------- starting

export interface StartedPayment {
  onlinePaymentId: string;
  clientSecret: string;
  publishableKey: string;
  amountCents: number;
  currencyCode: string;
}

interface LockedInvoice {
  id: string;
  invoice_number: string | null;
  customer_id: string;
  status: string;
  currency_code: string;
  total_cents: string;
}

/** POST /public/statements/:token/payments */
export async function startPayment(token: string, invoiceIds: string[], deps?: StripeDeps): Promise<StartedPayment> {
  const send = await resolveLiveSend(token);
  const options = await paymentOptionsFor(send, deps);
  if (!options.enabled || options.publishableKey === null) {
    throw new ApiError(409, 'Online payment is not available for this statement');
  }
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) throw new ApiError(422, 'Choose at least one invoice to pay');

  const { onlinePaymentId, amountCents, currencyCode } = await withTransaction(async (client) => {
    // Sorted ids + FOR UPDATE: the same lock order paymentService uses, so a
    // concurrent receipt against the same invoices serialises, not deadlocks.
    const { rows } = await client.query<LockedInvoice>(
      `SELECT id, invoice_number, customer_id, status, currency_code, total_cents::text AS total_cents
         FROM invoices
        WHERE org_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [send.orgId, ids],
    );
    if (rows.length !== ids.length || rows.some((r) => r.customer_id !== send.partyId)) {
      throw new ApiError(404, 'Invoice not found');
    }
    if (rows.some((r) => r.status !== 'ISSUED')) throw new ApiError(422, 'Only issued invoices can be paid');
    const currencies = new Set(rows.map((r) => r.currency_code.trim()));
    if (currencies.size !== 1) throw new ApiError(422, 'Pay invoices in one currency at a time');
    const currency = [...currencies][0] ?? '';
    if (NON_TWO_DECIMAL.has(currency)) {
      throw new ApiError(422, `Online payment in ${currency} is not supported`);
    }

    const lines: { invoiceId: string; amountCents: number }[] = [];
    for (const invoice of rows) {
      const { paidCents, noteAppliedCents } = await settledCentsOnClient(client, send.orgId, 'invoice_id', invoice.id);
      const outstanding = parseCents(invoice.total_cents) - paidCents - noteAppliedCents;
      if (outstanding <= 0) throw new ApiError(422, `Invoice ${invoice.invoice_number ?? invoice.id} is already paid`);
      lines.push({ invoiceId: invoice.id, amountCents: outstanding });
    }
    const total = lines.reduce((sum, l) => sum + l.amountCents, 0);

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO online_payments (org_id, statement_send_id, customer_id, currency_code, amount_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [send.orgId, send.id, send.partyId, currency, total],
    );
    const id = created[0]?.id;
    if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');
    await client.query(
      `INSERT INTO online_payment_invoices (org_id, online_payment_id, invoice_id, amount_cents)
       SELECT $1, $2, invoice_id, amount_cents
         FROM unnest($3::uuid[], $4::bigint[]) AS t(invoice_id, amount_cents)`,
      [send.orgId, id, lines.map((l) => l.invoiceId), lines.map((l) => l.amountCents)],
    );
    return { onlinePaymentId: id, amountCents: total, currencyCode: currency };
  });

  // The Stripe call happens after COMMIT, outside any transaction: a network
  // round-trip must never hold invoice row locks (rule 5's spirit).
  let intent: stripeClient.PaymentIntent;
  try {
    intent = await stripeClient.createPaymentIntent(
      {
        amountCents,
        currencyCode,
        description: `Statement payment ${onlinePaymentId}`,
        metadata: { org_id: send.orgId, online_payment_id: onlinePaymentId },
        idempotencyKey: `online-payment-${onlinePaymentId}`,
      },
      deps,
    );
  } catch (err) {
    await transition(pool, send.orgId, onlinePaymentId, 'FAILED', {
      failureReason: err instanceof Error ? err.message.slice(0, 500) : 'Payment provider error',
    });
    throw err;
  }
  await pool.query(
    'UPDATE online_payments SET provider_intent_id = $3 WHERE org_id = $1 AND id = $2',
    [send.orgId, onlinePaymentId, intent.id],
  );
  if (intent.clientSecret === null) throw new ApiError(502, 'Unexpected response from the payment provider');
  return {
    onlinePaymentId,
    clientSecret: intent.clientSecret,
    publishableKey: options.publishableKey,
    amountCents,
    currencyCode,
  };
}

// ------------------------------------------------------------------- settling

interface PaymentRow {
  id: string;
  org_id: string;
  statement_send_id: string;
  customer_id: string;
  currency_code: string;
  amount_cents: string;
  status: OnlinePaymentStatus;
  payment_id: string | null;
}

/** The one place `online_payments.status` changes (rule 10). */
async function transition(
  q: Queryable,
  orgId: string,
  id: string,
  to: OnlinePaymentStatus,
  extra: { paymentId?: string; failureReason?: string } = {},
): Promise<void> {
  const { rows } = await q.query<{ status: OnlinePaymentStatus }>(
    'SELECT status FROM online_payments WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  const from = rows[0]?.status;
  if (from === undefined) throw new ApiError(404, 'Payment not found');
  if (!canTransitionOnlinePayment(from, to)) {
    throw new Error(`online payment ${id}: illegal transition ${from} → ${to}`);
  }
  await q.query(
    `UPDATE online_payments
        SET status = $3, payment_id = COALESCE($4, payment_id), failure_reason = COALESCE($5, failure_reason)
      WHERE org_id = $1 AND id = $2`,
    [orgId, id, to, extra.paymentId ?? null, extra.failureReason ?? null],
  );
}

export interface SettleResult {
  status: OnlinePaymentStatus;
  paymentId: string | null;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') return err.message;
  return 'Could not record the payment';
}

/**
 * Brings our row in line with what Stripe says about the intent. Idempotent:
 * the webhook and the browser's confirm may both call it, in any order, as
 * often as they like — the row lock serialises them and only the first
 * records a payment.
 */
export async function settleIntent(intentId: string, deps?: StripeDeps): Promise<SettleResult> {
  // Ours at all? Checked before calling Stripe: a webhook for another
  // integration's intent (or a guessed id) costs one indexed read, not a
  // network round-trip. This and the locking read below are the module's
  // only org-less queries, by necessity: a webhook carries no organization.
  // The intent id is globally unique (`UNIQUE (provider, provider_intent_id)`),
  // and every write after it is scoped by the matched row's own org_id (rule 1).
  const { rows: known } = await pool.query<{ status: OnlinePaymentStatus; payment_id: string | null }>(
    "SELECT status, payment_id FROM online_payments WHERE provider = 'stripe' AND provider_intent_id = $1",
    [intentId],
  );
  const existing = known[0];
  if (existing === undefined) throw new ApiError(404, 'Payment not found');
  if (existing.status !== 'PENDING') return { status: existing.status, paymentId: existing.payment_id };

  const intent = await stripeClient.retrievePaymentIntent(intentId, deps);

  return withTransaction(async (client) => {
    const { rows } = await client.query<PaymentRow>(
      `SELECT id, org_id, statement_send_id, customer_id, currency_code, amount_cents::text AS amount_cents,
              status, payment_id
         FROM online_payments
        WHERE provider = 'stripe' AND provider_intent_id = $1
          FOR UPDATE`,
      [intent.id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Payment not found');
    if (row.status !== 'PENDING') return { status: row.status, paymentId: row.payment_id };

    if (intent.status === 'canceled') {
      await transition(client, row.org_id, row.id, 'CANCELED');
      return { status: 'CANCELED', paymentId: null };
    }
    if (intent.status !== 'succeeded') {
      // requires_payment_method after a decline, processing, …: still open.
      if (intent.lastErrorMessage !== null) {
        await client.query('UPDATE online_payments SET failure_reason = $3 WHERE org_id = $1 AND id = $2', [
          row.org_id,
          row.id,
          intent.lastErrorMessage.slice(0, 500),
        ]);
      }
      return { status: 'PENDING', paymentId: null };
    }

    if (intent.amount !== parseCents(row.amount_cents) || intent.currency !== row.currency_code) {
      await transition(client, row.org_id, row.id, 'NEEDS_REVIEW', {
        failureReason: `Stripe charged ${String(intent.amount)} ${intent.currency}, expected ${row.amount_cents} ${row.currency_code}`,
      });
      return { status: 'NEEDS_REVIEW', paymentId: null };
    }

    const { rows: lines } = await client.query<{ invoice_id: string; amount_cents: string }>(
      `SELECT invoice_id, amount_cents::text AS amount_cents
         FROM online_payment_invoices WHERE org_id = $1 AND online_payment_id = $2 ORDER BY invoice_id`,
      [row.org_id, row.id],
    );
    const { rows: sendRows } = await client.query<{ sent_by: string }>(
      'SELECT sent_by FROM statement_sends WHERE org_id = $1 AND id = $2',
      [row.org_id, row.statement_send_id],
    );
    const settings = await readSettings(client, row.org_id);
    const sentBy = sendRows[0]?.sent_by;

    // A savepoint, with the payment's deferred constraint triggers forced to
    // run inside it: if this receipt cannot be recorded, only it is undone and
    // the row still moves to NEEDS_REVIEW in the same transaction.
    await client.query('SAVEPOINT record_online_payment');
    try {
      if (sentBy === undefined || settings.deposit_account_id === null) {
        throw new ApiError(422, 'Online payments have no deposit account');
      }
      const today = todayIso();
      const paymentId = await createPaymentOnClient(client, row.org_id, sentBy, {
        direction: 'RECEIVE',
        paymentDate: today,
        amountCents: parseCents(row.amount_cents),
        currencyCode: row.currency_code,
        cashAccountId: settings.deposit_account_id,
        customerId: row.customer_id,
        vendorId: null,
        method: 'CARD',
        reference: intent.id,
        notes: 'Paid online from an emailed statement',
        allocations: lines.map((l) => ({ invoiceId: l.invoice_id, billId: null, amountCents: parseCents(l.amount_cents) })),
        entryDate: null,
      });
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('RELEASE SAVEPOINT record_online_payment');
      await transition(client, row.org_id, row.id, 'RECORDED', { paymentId });
      return { status: 'RECORDED', paymentId };
    } catch (err) {
      if (!(err instanceof ApiError) && !(typeof err === 'object' && err !== null && 'code' in err && err.code === PG_RAISE_EXCEPTION)) {
        throw err;
      }
      await client.query('ROLLBACK TO SAVEPOINT record_online_payment');
      logger.warn({ onlinePaymentId: row.id }, 'online payment succeeded but could not be recorded');
      await transition(client, row.org_id, row.id, 'NEEDS_REVIEW', { failureReason: errorMessage(err).slice(0, 500) });
      return { status: 'NEEDS_REVIEW', paymentId: null };
    }
  });
}

/** POST /public/statements/:token/payments/:intentId/confirm — the browser's "I think it worked". */
export async function confirmFromLink(token: string, intentId: string, deps?: StripeDeps): Promise<SettleResult> {
  const send = await resolveLiveSend(token);
  // The intent must belong to this link — a token cannot settle another org's intent.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM online_payments
      WHERE org_id = $1 AND statement_send_id = $2 AND provider = 'stripe' AND provider_intent_id = $3`,
    [send.orgId, send.id, intentId],
  );
  if (rows[0] === undefined) throw new ApiError(404, 'Payment not found');
  return settleIntent(intentId, deps);
}

/** POST /public/stripe/webhook. Unknown intents (another integration's) are acknowledged and ignored. */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined, deps?: StripeDeps): Promise<void> {
  const event = stripeClient.verifyWebhook(rawBody, signature, deps);
  const handled = ['payment_intent.succeeded', 'payment_intent.canceled', 'payment_intent.payment_failed'];
  if (!handled.includes(event.type) || event.objectId === null) return;
  try {
    await settleIntent(event.objectId, deps);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

// --------------------------------------------------------------------- listing

interface ListRow {
  id: string;
  customer_id: string;
  customer_name: string;
  provider_intent_id: string | null;
  currency_code: string;
  amount_cents: string;
  status: OnlinePaymentStatus;
  payment_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  invoices: { invoiceId: string; invoiceNumber: string | null; amountCents: string }[];
}

/** GET /online-payments?status= — newest first, at most 200. */
export async function listOnlinePayments(orgId: string, status: OnlinePaymentStatus | null): Promise<OnlinePayment[]> {
  const { rows } = await pool.query<ListRow>(
    `SELECT op.id, op.customer_id, c.name AS customer_name, op.provider_intent_id, op.currency_code,
            op.amount_cents::text AS amount_cents, op.status, op.payment_id, op.failure_reason,
            op.created_at, op.updated_at,
            COALESCE((SELECT json_agg(json_build_object(
                        'invoiceId', i.id, 'invoiceNumber', i.invoice_number, 'amountCents', opi.amount_cents::text)
                        ORDER BY i.invoice_number)
                        FROM online_payment_invoices opi
                        JOIN invoices i ON i.org_id = opi.org_id AND i.id = opi.invoice_id
                       WHERE opi.org_id = op.org_id AND opi.online_payment_id = op.id), '[]'::json) AS invoices
       FROM online_payments op
       JOIN customers c ON c.org_id = op.org_id AND c.id = op.customer_id
      WHERE op.org_id = $1 AND ($2::text IS NULL OR op.status = $2)
      ORDER BY op.created_at DESC, op.id DESC
      LIMIT 200`,
    [orgId, status],
  );
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    providerIntentId: r.provider_intent_id,
    currencyCode: r.currency_code,
    amountCents: parseCents(r.amount_cents),
    status: r.status,
    paymentId: r.payment_id,
    failureReason: r.failure_reason,
    invoices: r.invoices.map((i) => ({ ...i, amountCents: parseCents(i.amountCents) })),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}
