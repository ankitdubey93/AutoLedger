import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, postBill } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';

/**
 * Tax summary (Phase 45). Integration tier, real PostgreSQL.
 *
 * The central claim: the document-derived output/input tax, allocated per line
 * in base currency, ties to the movement on the tax accounts in the ledger; a
 * journal the documents did not produce shows as a difference, and nothing
 * crosses tenants.
 */

const app = createApp();
const TAX_SUMMARY = '/api/v1/reports/tax-summary';
const INVOICES = '/api/v1/invoices';
const CREDIT_NOTES = '/api/v1/credit-notes';
const MANUAL_JOURNALS = '/api/v1/manual-journals';

const FROM = '2026-09-01';
const TO = '2026-09-30';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;
let customerA: string;

async function issueTaxedInvoice(
  issueDate: string,
  lines: Array<{ unitPriceCents: number; taxRateBp: number }>,
): Promise<string> {
  const revenueAccountId = await accountId(orgA, '4100');
  const created = await agentA.post(INVOICES).send({
    customerId: customerA,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: lines.map((l) => ({
      description: 'Bracket kits',
      quantityMilli: 1000,
      unitPriceCents: l.unitPriceCents,
      revenueAccountId,
      taxRateBp: l.taxRateBp,
    })),
  });
  if (created.status !== 201) throw new Error(`fixture: invoice create failed ${created.status} ${created.text}`);
  const id = created.body.invoice.id as string;
  const issued = await agentA.post(`${INVOICES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status} ${issued.text}`);
  return id;
}

async function issueCreditNote(invoiceId: string, issueDate: string, unitPriceCents: number, taxRateBp: number) {
  const created = await agentA.post(CREDIT_NOTES).send({
    invoiceId,
    issueDate,
    reasonCode: 'PRICE_ADJUSTMENT',
    lines: [
      {
        description: 'credit',
        quantityMilli: 1000,
        unitPriceCents,
        revenueAccountId: await accountId(orgA, '4100'),
        taxRateBp,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: credit note create failed ${created.status} ${created.text}`);
  const issued = await agentA.post(`${CREDIT_NOTES}/${created.body.creditNote.id as string}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: credit note issue failed ${issued.status} ${issued.text}`);
}

async function summary(agent: Agent) {
  const res = await agent.get(TAX_SUMMARY).query({ from: FROM, to: TO });
  expect(res.status).toBe(200);
  return res.body as {
    output: { rows: Array<{ rateBp: number; netCents: number; taxCents: number }>; taxCents: number };
    input: { rows: Array<{ rateBp: number; netCents: number; taxCents: number }>; taxCents: number };
    netTaxPayableCents: number;
    outputCheck: { differenceCents: number };
    inputCheck: { differenceCents: number };
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fabrication');
  const vendorA = await createVendor(agentA, 'Steel Supply');

  // I1: 100.00 @ 10% and 200.00 @ 0%, in the window.
  const i1 = await issueTaxedInvoice('2026-09-05', [
    { unitPriceCents: 10000, taxRateBp: 1000 },
    { unitPriceCents: 20000, taxRateBp: 0 },
  ]);
  // B1: 50.00 @ 18%, in the window.
  await postBill(agentA, orgA, vendorA, { billDate: '2026-09-08', unitPriceCents: 5000, taxRateBp: 1800 });
  // Credit note against I1, 20.00 @ 10%.
  await issueCreditNote(i1, '2026-09-20', 2000, 1000);
  // I2: issued before the window, voided inside it. The void request carries
  // its own entryDate, so the void entry can be placed in September.
  const i2 = await issueTaxedInvoice('2026-08-25', [{ unitPriceCents: 4000, taxRateBp: 1000 }]);
  const voided = await agentA.post(`${INVOICES}/${i2}/void`).send({ entryDate: '2026-09-12' });
  if (voided.status !== 200) throw new Error(`fixture: invoice void failed ${voided.status} ${voided.text}`);
});

afterAll(closePool);

describe('GET /reports/tax-summary', () => {
  it('output by rate', async () => {
    const report = await summary(agentA);
    const r1000 = report.output.rows.find((r) => r.rateBp === 1000);
    const r0 = report.output.rows.find((r) => r.rateBp === 0);
    // net 10000 - 2000 (credit note) - 4000 (I2 void); tax 1000 - 200 - 400.
    expect(r1000).toMatchObject({ netCents: 4000, taxCents: 400 });
    expect(r0).toMatchObject({ netCents: 20000, taxCents: 0 });
    expect(report.output.taxCents).toBe(400);
  });

  it('input by rate', async () => {
    const report = await summary(agentA);
    expect(report.input.rows).toHaveLength(1);
    expect(report.input.rows[0]).toMatchObject({ rateBp: 1800, netCents: 5000, taxCents: 900 });
  });

  it('net payable', async () => {
    const report = await summary(agentA);
    expect(report.netTaxPayableCents).toBe(report.output.taxCents - report.input.taxCents);
    expect(report.netTaxPayableCents).toBe(400 - 900);
  });

  it('ties to the GL', async () => {
    const report = await summary(agentA);
    expect(report.outputCheck.differenceCents).toBe(0);
    expect(report.inputCheck.differenceCents).toBe(0);
  });

  it('manual journal shows as a difference', async () => {
    const res = await agentA.post(MANUAL_JOURNALS).send({
      narration: 'Tax adjustment',
      entryDate: '2026-09-15',
      lines: [
        { accountId: await accountId(orgA, '6200'), description: null, debitCents: 1500, creditCents: 0 },
        { accountId: await accountId(orgA, '2140'), description: null, debitCents: 0, creditCents: 1500 },
      ],
      action: 'post',
    });
    // No guard refuses 2140 for manual journals today; if one is added this
    // assertion fails loudly and the case must be rewritten.
    expect(res.status).toBe(201);
    const report = await summary(agentA);
    expect(report.outputCheck.differenceCents).toBe(1500);
    expect(report.inputCheck.differenceCents).toBe(0);
  });

  it('cross-tenant', async () => {
    const report = await summary(agentB);
    expect(report.output.rows).toEqual([]);
    expect(report.input.rows).toEqual([]);
  });

  it('csv export', async () => {
    const res = await agentA.get(TAX_SUMMARY).query({ from: FROM, to: TO, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Total output tax');
  });
});
