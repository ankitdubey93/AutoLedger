import { pool } from '../../db/connect.js';
import type { loginAgent } from './factories.js';

/**
 * API-driven accounting fixtures shared by the Phase 39 statement tests.
 * Everything goes through the real routes, so a fixture can never produce a
 * state the product could not.
 */

export type Agent = Awaited<ReturnType<typeof loginAgent>>;

export async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

export async function createCustomer(
  agent: Agent,
  name: string,
  email: string | null = null,
): Promise<string> {
  const res = await agent.post('/api/v1/customers').send({ name, email });
  if (res.status !== 201) throw new Error(`fixture: customer create failed ${res.status}`);
  return res.body.customer.id as string;
}

export async function issueInvoice(
  agent: Agent,
  orgId: string,
  customerId: string,
  totalCents: number,
  issueDate: string,
  dueDate: string,
  currencyCode?: string,
): Promise<{ id: string; number: string }> {
  const revenueAccountId = await accountId(orgId, '4100');
  const created = await agent.post('/api/v1/invoices').send({
    customerId,
    issueDate,
    dueDate,
    notes: null,
    paymentTerms: null,
    ...(currencyCode === undefined ? {} : { currencyCode }),
    lines: [
      { description: 'x', quantityMilli: 1000, unitPriceCents: totalCents, revenueAccountId, taxRateBp: 0 },
    ],
  });
  if (created.status !== 201) {
    throw new Error(`fixture: invoice create failed ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.invoice.id as string;
  const issued = await agent.post(`/api/v1/invoices/${id}/issue`).send({});
  if (issued.status !== 200) {
    throw new Error(`fixture: invoice issue failed ${issued.status} ${JSON.stringify(issued.body)}`);
  }
  return { id, number: issued.body.invoice.invoiceNumber as string };
}

export async function receivePayment(
  agent: Agent,
  orgId: string,
  customerId: string,
  paymentDate: string,
  allocations: { invoiceId: string; amountCents: number }[],
): Promise<string> {
  const res = await agent.post('/api/v1/payments').send({
    direction: 'RECEIVE',
    paymentDate,
    amountCents: allocations.reduce((sum, a) => sum + a.amountCents, 0),
    cashAccountId: await accountId(orgId, '1110'),
    customerId,
    reference: `RCPT-${paymentDate}`,
    allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, billId: null, amountCents: a.amountCents })),
  });
  if (res.status !== 201) throw new Error(`fixture: payment failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.payment.id as string;
}

/** Creates and issues a credit note against `invoiceId`; issue auto-applies it (Phase 26). */
export async function issueCreditNote(
  agent: Agent,
  orgId: string,
  invoiceId: string,
  amountCents: number,
  issueDate: string,
): Promise<string> {
  const revenueAccountId = await accountId(orgId, '4100');
  const created = await agent.post('/api/v1/credit-notes').send({
    invoiceId,
    issueDate,
    reasonCode: 'PRICE_ADJUSTMENT',
    lines: [{ description: 'credit', quantityMilli: 1000, unitPriceCents: amountCents, revenueAccountId, taxRateBp: 0 }],
  });
  if (created.status !== 201) {
    throw new Error(`fixture: credit note create failed ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.creditNote.id as string;
  const issued = await agent.post(`/api/v1/credit-notes/${id}/issue`).send({});
  if (issued.status !== 200) {
    throw new Error(`fixture: credit note issue failed ${issued.status} ${JSON.stringify(issued.body)}`);
  }
  return id;
}

/** Creates, submits and approves (posts) a one-line bill. The caller must be OWNER. */
export async function postBill(agent: Agent, orgId: string, vendorId: string, opts: {
  billDate: string; unitPriceCents: number; taxRateBp?: number; expenseCode?: string; vendorReference?: string; itemId?: string | null;
}): Promise<{ id: string; journalEntryId: string; lineId: string }> {
  const expenseAccountId = await accountId(orgId, opts.expenseCode ?? '6130');
  const created = await agent.post('/api/v1/bills').send({
    vendorId,
    vendorReference: opts.vendorReference ?? `REF-${opts.billDate}-${opts.unitPriceCents}`,
    billDate: opts.billDate,
    dueDate: opts.billDate,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'x',
        quantityMilli: 1000,
        unitPriceCents: opts.unitPriceCents,
        expenseAccountId,
        taxRateBp: opts.taxRateBp ?? 0,
        ...(opts.itemId === undefined ? {} : { itemId: opts.itemId }),
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: bill create failed ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.bill.id as string;
  const submitted = await agent.post(`/api/v1/bills/${id}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit failed ${submitted.status} ${JSON.stringify(submitted.body)}`);
  const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status} ${JSON.stringify(approved.body)}`);
  return {
    id,
    journalEntryId: approved.body.bill.journalEntryId as string,
    lineId: approved.body.bill.lines[0].id as string,
  };
}
