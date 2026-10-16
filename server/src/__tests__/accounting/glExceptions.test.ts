import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import {
  accountId,
  createCustomer,
  issueCreditNote,
  issueInvoice,
  postBill,
} from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';

/**
 * Phase 45 — GL exception report. Integration tier, real PostgreSQL.
 *
 * Org Alpha (OWNER agent) with vendor Office Co; report window 2026-09. Org
 * Bravo holds nothing and must never see, review or reopen anything of
 * Alpha's.
 */

const app = createApp();
const URL_ = '/api/v1/reports/exceptions';
const REVIEWS = `${URL_}/reviews`;
const WINDOW = 'from=2026-09-01&to=2026-09-30';

let userA: SeededUser;
let agentA: Agent;
let agentB: Agent;
let orgA: string;
let vendorId: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  orgA = userA.orgId;
  vendorId = await createVendor(agentA, 'Office Co');
});

afterAll(closePool);

interface Found {
  rule: string;
  subjectType: string;
  subjectId: string;
  accountCode: string | null;
  amountCents: number;
  expected: string;
  actual: string;
  reason: string;
  review: { id: string; note: string; reviewedByName: string } | null;
}

async function list(agent: Agent, query = WINDOW): Promise<{ exceptions: Found[]; counts: Record<string, { open: number; reviewed: number }> }> {
  const res = await agent.get(`${URL_}?${query}`);
  if (res.status !== 200) throw new Error(`list failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** `count` prior bills on 6130, one per month going back from 2026-08, each with a distinct reference. */
async function seedHistory(amountsCents: number[]): Promise<void> {
  for (let i = 0; i < amountsCents.length; i += 1) {
    const monthIndex = 2026 * 12 + 7 - i; // 2026-08 going back one month per bill (stays inside the 12-month baseline)
    const year = Math.floor(monthIndex / 12);
    const mm = String((monthIndex % 12) + 1).padStart(2, '0');
    const day = '05';
    await postBill(agentA, orgA, vendorId, {
      billDate: `${year}-${mm}-${day}`,
      unitPriceCents: amountsCents[i] as number,
      vendorReference: `HIST-${i}`,
    });
  }
}

const TYPICAL = [10000, 11000, 9000, 10000, 10500, 9500, 10000, 10000, 9800, 10200];

describe('UNUSUAL_AMOUNT', () => {
  it('flags an amount far above the account history', async () => {
    await seedHistory(TYPICAL);
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-15', unitPriceCents: 500000, vendorReference: 'BIG' });
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-16', unitPriceCents: 10400, vendorReference: 'NORMAL' });

    const report = await list(agentA);
    // The bill's AP credit line is also an outlier against AP history; the 6130 expense line is the subject here.
    const flagged = report.exceptions.filter((e) => e.rule === 'UNUSUAL_AMOUNT' && e.accountCode === '6130');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.amountCents).toBe(500000);
  });

  it('needs the minimum history', async () => {
    await seedHistory(TYPICAL.slice(0, 5));
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-15', unitPriceCents: 500000, vendorReference: 'BIG' });

    const report = await list(agentA);
    expect(report.exceptions.filter((e) => e.rule === 'UNUSUAL_AMOUNT')).toHaveLength(0);
  });

  it('uses the twice-the-usual rule when the spread is zero', async () => {
    await seedHistory(Array.from({ length: 10 }, () => 10000));
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-10', unitPriceCents: 25000, vendorReference: 'TWICE' });
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-11', unitPriceCents: 15000, vendorReference: 'MILD' });

    const report = await list(agentA);
    const flagged = report.exceptions.filter((e) => e.rule === 'UNUSUAL_AMOUNT' && e.accountCode === '6130');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.amountCents).toBe(25000);
    expect(flagged[0]?.reason).toContain('More than twice');
  });
});

describe('UNEXPECTED_SIDE', () => {
  it('flags a debit to a revenue account', async () => {
    const res = await agentA.post('/api/v1/manual-journals').send({
      narration: 'Odd entry',
      entryDate: '2026-09-10',
      action: 'post',
      lines: [
        { accountId: await accountId(orgA, '4100'), description: null, debitCents: 5000, creditCents: 0 },
        { accountId: await accountId(orgA, '3100'), description: null, debitCents: 0, creditCents: 5000 },
      ],
    });
    expect(res.status).toBe(201);

    const report = await list(agentA);
    const flagged = report.exceptions.filter((e) => e.rule === 'UNEXPECTED_SIDE');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.accountCode).toBe('4100');
    expect(flagged[0]?.expected).toBe('Credit');
    expect(flagged[0]?.actual).toBe('Debit');
  });

  it('exempts the reversal lines of a voided invoice', async () => {
    const customerId = await createCustomer(agentA, 'Acme');
    const inv = await issueInvoice(agentA, orgA, customerId, 10000, '2026-09-05', '2026-10-05');
    expect((await agentA.post(`/api/v1/invoices/${inv.id}/void`).send({})).status).toBe(200);

    const report = await list(agentA, WINDOW);
    expect(report.exceptions.filter((e) => e.rule === 'UNEXPECTED_SIDE')).toHaveLength(0);
  });

  it('exempts credit notes', async () => {
    const customerId = await createCustomer(agentA, 'Acme');
    const inv = await issueInvoice(agentA, orgA, customerId, 10000, '2026-09-05', '2026-10-05');
    await issueCreditNote(agentA, orgA, inv.id, 2000, '2026-09-10');

    const report = await list(agentA);
    expect(report.exceptions.filter((e) => e.rule === 'UNEXPECTED_SIDE')).toHaveLength(0);
  });
});

describe('NON_DEFAULT_TAX', () => {
  it('flags an invoice line differing from the organization default', async () => {
    const patch = await agentA.patch('/api/v1/settings/invoicing').send({ defaultTaxRateBp: 1000 });
    expect(patch.status).toBe(200);
    const customerId = await createCustomer(agentA, 'Acme');
    await issueInvoice(agentA, orgA, customerId, 10000, '2026-09-05', '2026-10-05');

    const report = await list(agentA);
    const flagged = report.exceptions.filter((e) => e.rule === 'NON_DEFAULT_TAX');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.subjectType).toBe('INVOICE_LINE');
    expect(flagged[0]?.expected.startsWith('10% (organization default)')).toBe(true);
    expect(flagged[0]?.actual).toBe('0%');
  });

  it('flags a bill line differing from the item default', async () => {
    const item = await agentA.post('/api/v1/items').send({
      code: 'PAPER',
      name: 'Paper',
      kind: 'GOODS',
      purchaseTaxRateBp: 1800,
    });
    expect(item.status).toBe(201);
    await postBill(agentA, orgA, vendorId, {
      billDate: '2026-09-10',
      unitPriceCents: 10000,
      taxRateBp: 500,
      itemId: item.body.item.id as string,
    });

    const report = await list(agentA);
    const flagged = report.exceptions.filter((e) => e.rule === 'NON_DEFAULT_TAX');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.subjectType).toBe('BILL_LINE');
    expect(flagged[0]?.expected).toBe('18% (item default)');
    expect(flagged[0]?.actual).toBe('5%');
  });
});

describe('POSSIBLE_DUPLICATE and reviews', () => {
  async function seedDuplicate(): Promise<string> {
    await postBill(agentA, orgA, vendorId, { billDate: '2026-09-03', unitPriceCents: 30000, vendorReference: 'D-1' });
    const later = await postBill(agentA, orgA, vendorId, { billDate: '2026-09-10', unitPriceCents: 30000, vendorReference: 'D-2' });
    await postBill(agentA, orgA, vendorId, { billDate: '2026-10-20', unitPriceCents: 30000, vendorReference: 'D-3' });
    return later.journalEntryId;
  }

  it('flags the later bill within the window only', async () => {
    const entryId = await seedDuplicate();

    const report = await list(agentA);
    const flagged = report.exceptions.filter((e) => e.rule === 'POSSIBLE_DUPLICATE');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.subjectType).toBe('JOURNAL_ENTRY');
    expect(flagged[0]?.subjectId).toBe(entryId);
  });

  it('a review hides the flag and reopening restores it', async () => {
    const entryId = await seedDuplicate();
    const body = { rule: 'POSSIBLE_DUPLICATE', subjectType: 'JOURNAL_ENTRY', subjectId: entryId, note: 'Two deliveries' };

    const created = await agentA.post(REVIEWS).send(body);
    expect(created.status).toBe(201);
    expect(created.body.review.reviewedByName).toBe('alice');

    const hidden = await list(agentA);
    expect(hidden.exceptions.filter((e) => e.rule === 'POSSIBLE_DUPLICATE')).toHaveLength(0);
    expect(hidden.counts.POSSIBLE_DUPLICATE).toEqual({ open: 0, reviewed: 1 });

    const shown = await list(agentA, `${WINDOW}&includeReviewed=true`);
    const dup = shown.exceptions.find((e) => e.rule === 'POSSIBLE_DUPLICATE');
    expect(dup?.review?.note).toBe('Two deliveries');

    const deleted = await agentA.delete(`${REVIEWS}/${created.body.review.id as string}`);
    expect(deleted.status).toBe(204);
    const back = await list(agentA);
    expect(back.exceptions.filter((e) => e.rule === 'POSSIBLE_DUPLICATE')).toHaveLength(1);
  });

  it('refuses a repeated review, a mismatched rule and an empty note', async () => {
    const entryId = await seedDuplicate();
    const body = { rule: 'POSSIBLE_DUPLICATE', subjectType: 'JOURNAL_ENTRY', subjectId: entryId, note: 'ok' };
    expect((await agentA.post(REVIEWS).send(body)).status).toBe(201);

    const again = await agentA.post(REVIEWS).send(body);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This exception is already marked reviewed');

    const wrong = await agentA.post(REVIEWS).send({ ...body, rule: 'UNUSUAL_AMOUNT' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('Rule UNUSUAL_AMOUNT does not apply to a JOURNAL_ENTRY');

    const empty = await agentA.post(REVIEWS).send({ ...body, note: '   ' });
    expect(empty.status).toBe(400);
  });

  it('a VIEWER can read but not review', async () => {
    const entryId = await seedDuplicate();
    const viewer = await createUserWithOrg({ label: 'eve', orgName: 'Org Eve' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const post = await agent.post(REVIEWS).send({
      rule: 'POSSIBLE_DUPLICATE',
      subjectType: 'JOURNAL_ENTRY',
      subjectId: entryId,
      note: 'nope',
    });
    expect(post.status).toBe(403);
    expect((await agent.get(`${URL_}?${WINDOW}`)).status).toBe(200);
  });

  it('is tenant-isolated', async () => {
    const entryId = await seedDuplicate();
    const created = await agentA.post(REVIEWS).send({
      rule: 'POSSIBLE_DUPLICATE',
      subjectType: 'JOURNAL_ENTRY',
      subjectId: entryId,
      note: 'mine',
    });
    expect(created.status).toBe(201);

    const bravo = await agentB.get(`${URL_}?${WINDOW}&includeReviewed=true`);
    expect(bravo.status).toBe(200);
    expect(bravo.body.exceptions).toEqual([]);

    const foreign = await agentB.post(REVIEWS).send({
      rule: 'POSSIBLE_DUPLICATE',
      subjectType: 'JOURNAL_ENTRY',
      subjectId: entryId,
      note: 'steal',
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('Exception subject not found');

    const del = await agentB.delete(`${REVIEWS}/${created.body.review.id as string}`);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('Review not found');
  });

  it('the database refuses a review with two subjects', async () => {
    const entryId = await seedDuplicate();
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ledger_lines WHERE org_id = $1 LIMIT 1', [orgA]);
    const lineId = rows[0]?.id;
    await expect(
      pool.query(
        `INSERT INTO gl_exception_reviews (org_id, rule_code, ledger_line_id, journal_entry_id, note, reviewed_by)
         VALUES ($1, 'POSSIBLE_DUPLICATE', $2, $3, 'x', $4)`,
        [orgA, lineId, entryId, userA.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('range cap', () => {
  it('refuses a window longer than 366 days', async () => {
    const res = await agentA.get(`${URL_}?from=2025-01-01&to=2026-09-30`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('The exception report covers at most 366 days');
  });
});
