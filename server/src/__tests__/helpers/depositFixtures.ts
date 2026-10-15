import { pool } from '../../db/connect.js';
import { accountId, type Agent } from './accountingFixtures.js';

/**
 * API-driven fixtures for the Phase 42 (Slice G) deposit tests. Everything goes
 * through the real routes so a fixture can never produce a state the product
 * could not.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const TODAY = new Date(Date.now()).toISOString().slice(0, 10);
export function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

export interface FixtureOrder {
  id: string;
  orderNumber: string;
  lines: { id: string }[];
}

/** Creates and confirms an order of one line, `totalCents` (no tax). */
export async function confirmedOrder(
  agent: Agent,
  orgId: string,
  direction: 'SALES' | 'PURCHASE',
  partyId: string,
  totalCents = 100_000,
  currencyCode?: string,
): Promise<FixtureOrder> {
  const base = direction === 'SALES' ? '/api/v1/orders' : '/api/v1/purchase-orders';
  const created = await agent.post(base).send({
    partyId,
    orderDate: TODAY,
    ...(currencyCode === undefined ? {} : { currencyCode }),
    lines: [
      {
        description: 'Goods',
        quantityMilli: 1000,
        unitPriceCents: totalCents,
        accountId: await accountId(orgId, direction === 'SALES' ? '4100' : '6130'),
        taxRateBp: 0,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: order create failed ${created.status} ${created.text}`);
  const confirmed = await agent.post(`${base}/${created.body.order.id as string}/confirm`).send({});
  if (confirmed.status !== 200) throw new Error(`fixture: order confirm failed ${confirmed.status} ${confirmed.text}`);
  return confirmed.body.order as FixtureOrder;
}

export async function createVendor(agent: Agent, name: string): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send({ name });
  if (res.status !== 201) throw new Error(`fixture: vendor create failed ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

/** Requests a deposit on a confirmed order and returns the new DRAFT document id. */
export async function requestDeposit(
  agent: Agent,
  direction: 'SALES' | 'PURCHASE',
  orderId: string,
  body: { percentBp?: number; amountCents?: number },
) {
  const base = direction === 'SALES' ? '/api/v1/orders' : '/api/v1/purchase-orders';
  return agent.post(`${base}/${orderId}/deposit`).send(body);
}

/** Request + issue (or submit + approve) a deposit document; returns its id. */
export async function issuedDeposit(
  agent: Agent,
  direction: 'SALES' | 'PURCHASE',
  orderId: string,
  body: { percentBp?: number; amountCents?: number },
): Promise<string> {
  const res = await requestDeposit(agent, direction, orderId, body);
  if (res.status !== 201) throw new Error(`fixture: deposit request failed ${res.status} ${res.text}`);
  const id = res.body.document.id as string;
  if (direction === 'SALES') {
    const issued = await agent.post(`/api/v1/invoices/${id}/issue`).send({});
    if (issued.status !== 200) throw new Error(`fixture: deposit issue failed ${issued.status} ${issued.text}`);
  } else {
    await agent.post(`/api/v1/bills/${id}/submit`).send({});
    const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
    if (approved.status !== 200) throw new Error(`fixture: prepayment approve failed ${approved.status} ${approved.text}`);
  }
  return id;
}

/** Bills the whole order into a draft invoice/bill, then issues/approves it. Returns its id. */
export async function issuedFinalDocument(
  agent: Agent,
  direction: 'SALES' | 'PURCHASE',
  orderId: string,
): Promise<string> {
  const base = direction === 'SALES' ? '/api/v1/orders' : '/api/v1/purchase-orders';
  const converted = await agent.post(`${base}/${orderId}/convert`).send({});
  if (converted.status !== 201) throw new Error(`fixture: order convert failed ${converted.status} ${converted.text}`);
  const id = converted.body.document.id as string;
  if (direction === 'SALES') {
    const issued = await agent.post(`/api/v1/invoices/${id}/issue`).send({});
    if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status} ${issued.text}`);
  } else {
    await agent.post(`/api/v1/bills/${id}/submit`).send({});
    const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
    if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status} ${approved.text}`);
  }
  return id;
}

/** Records a payment against one document and returns the payment id. */
export async function payDocument(
  agent: Agent,
  orgId: string,
  direction: 'SALES' | 'PURCHASE',
  partyId: string,
  documentId: string,
  amountCents: number,
): Promise<string> {
  const res = await agent.post('/api/v1/payments').send({
    direction: direction === 'SALES' ? 'RECEIVE' : 'PAY',
    paymentDate: TODAY,
    amountCents,
    cashAccountId: await accountId(orgId, '1110'),
    ...(direction === 'SALES' ? { customerId: partyId } : { vendorId: partyId }),
    reference: 'DEP-PAY',
    allocations: [
      {
        invoiceId: direction === 'SALES' ? documentId : null,
        billId: direction === 'PURCHASE' ? documentId : null,
        amountCents,
      },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: payment failed ${res.status} ${res.text}`);
  return res.body.payment.id as string;
}

export function applyDepositRequest(
  agent: Agent,
  direction: 'SALES' | 'PURCHASE',
  targetId: string,
  depositDocumentId: string,
  amountCents: number,
  applicationDate: string = TODAY,
) {
  const path =
    direction === 'SALES' ? `/api/v1/invoices/${targetId}/apply-deposit` : `/api/v1/bills/${targetId}/apply-prepayment`;
  return agent.post(path).send({ depositDocumentId, amountCents, applicationDate });
}

export async function journalLines(
  orgId: string,
  journalEntryId: string,
): Promise<{ code: string; debit: number; credit: number }[]> {
  const { rows } = await pool.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit_cents::text AS debit, l.credit_cents::text AS credit
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1 AND l.journal_entry_id = $2
      ORDER BY a.code`,
    [orgId, journalEntryId],
  );
  return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }));
}

export async function accountOwnBalance(agent: Agent, orgId: string, code: string): Promise<number> {
  const id = await accountId(orgId, code);
  const res = await agent.get('/api/v1/accounts/balances');
  const row = (res.body.balances as { accountId: string; ownBalanceCents: number }[]).find((b) => b.accountId === id);
  if (row === undefined) throw new Error(`fixture: no balance row for ${code}`);
  return row.ownBalanceCents;
}
