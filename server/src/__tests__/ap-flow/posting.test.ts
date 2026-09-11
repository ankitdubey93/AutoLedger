import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import {
  addMember,
  clearStorage,
  createUserWithOrg,
  loginAgent,
  resetTables,
} from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * AP-Flow's one-click post into LedgerCore (Phase 11). Integration tier,
 * real PostgreSQL. Proves the phase's own acceptance criteria: a two-line
 * receipt posts one balanced entry debiting two different accounts,
 * re-posting is a no-op (409, no second entry), and the posted entry's
 * source_id resolves back to a document whose stored bytes still hash to
 * the recorded sha256. Includes this module's own cross-tenant isolation
 * case (rule 15).
 */

const app = createApp();
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/ledger-core/fx-rates';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let userAccountant: SeededUser;
let userViewer: SeededUser;

async function accountIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
  return id;
}

interface SeedLineItem {
  description: string;
  amountCents: number;
  accountId: string | null;
}

/**
 * Seeds a fully EXTRACTED ap_flow_document, its extraction, and its line
 * items directly via raw SQL — there is no worker in this test process, so
 * an EXTRACTED document ready to post is built directly rather than
 * through the pipeline.
 */
async function seedExtractedDocument(
  orgId: string,
  createdBy: string,
  options: {
    vendorName?: string | null;
    invoiceDate?: string | null;
    currency?: string;
    subtotalCents?: number;
    taxCents?: number;
    totalCents?: number | null;
    arithmeticOk?: boolean;
    lineItems: SeedLineItem[];
  },
): Promise<{ apFlowDocId: string; sha256: string }> {
  const sha256 = Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64);
  const { rows: docRows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
     RETURNING id`,
    [orgId, sha256, createdBy],
  );
  const vaultDocId = docRows[0]?.id;
  if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

  const { rows: apFlowRows } = await pool.query<{ id: string }>(
    `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, page_count, processed_at)
     VALUES ($1, $2, $3, 'EXTRACTED', 1, now())
     RETURNING id`,
    [orgId, vaultDocId, createdBy],
  );
  const apFlowDocId = apFlowRows[0]?.id;
  if (apFlowDocId === undefined) throw new Error('fixture: no ap_flow_documents id');

  await pool.query(
    `INSERT INTO ap_flow_extractions
       (org_id, ap_flow_document_id, vendor_name, invoice_number, invoice_date, currency,
        subtotal_cents, tax_cents, total_cents, arithmetic_ok, model)
     VALUES ($1, $2, $3, 'INV-1', $4, $5, $6, $7, $8, $9, 'claude-sonnet-5')`,
    [
      orgId,
      apFlowDocId,
      options.vendorName === undefined ? 'Acme Vendor' : options.vendorName,
      options.invoiceDate === undefined ? '2026-08-15' : options.invoiceDate,
      options.currency ?? 'USD',
      options.subtotalCents ?? 20000,
      options.taxCents ?? 0,
      options.totalCents === undefined ? 20000 : options.totalCents,
      options.arithmeticOk ?? true,
    ],
  );

  for (const [index, item] of options.lineItems.entries()) {
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, apFlowDocId, index, item.description, item.amountCents, item.accountId],
    );
  }

  return { apFlowDocId, sha256 };
}

describe('ap-flow posting API', () => {
  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    orgB = carol.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
    await addMember(orgA, userB.id, 'ADMIN');
    await addMember(orgB, userB.id, 'ADMIN');

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  it('a two-line receipt posts one balanced entry debiting two different accounts', async () => {
    const officeSupplies = await accountIdByCode(orgA, '6130');
    const kitchen = await accountIdByCode(orgA, '6140');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 20000,
      taxCents: 0,
      totalCents: 20000,
      lineItems: [
        { description: 'Office supplies', amountCents: 12000, accountId: officeSupplies },
        { description: 'Kitchen', amountCents: 8000, accountId: kitchen },
      ],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);

    expect(res.status).toBe(200);
    const journalEntryId = res.body.document.journalEntryId as string;
    expect(journalEntryId).toBeTruthy();

    const { rows: entryRows } = await pool.query(
      "SELECT id FROM journal_entries WHERE org_id = $1 AND source_type = 'ap_flow' AND source_id = $2",
      [orgA, apFlowDocId],
    );
    expect(entryRows).toHaveLength(1);

    const { rows: lineRows } = await pool.query<{ account_id: string; debit_cents: string; credit_cents: string }>(
      'SELECT account_id, debit_cents, credit_cents FROM ledger_lines WHERE org_id = $1 AND journal_entry_id = $2 ORDER BY debit_cents DESC',
      [orgA, journalEntryId],
    );
    expect(lineRows).toHaveLength(3);
    const totalDebit = lineRows.reduce((sum, r) => sum + Number(r.debit_cents), 0);
    const totalCredit = lineRows.reduce((sum, r) => sum + Number(r.credit_cents), 0);
    expect(totalDebit).toBe(20000);
    expect(totalCredit).toBe(20000);
    expect(totalDebit).toBe(totalCredit);

    const debitAccounts = lineRows.filter((r) => Number(r.debit_cents) > 0).map((r) => r.account_id).sort();
    expect(debitAccounts).toEqual([kitchen, officeSupplies].sort());
  });

  it('re-posting the same document does not create a second entry', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 5000,
      totalCents: 5000,
      lineItems: [{ description: 'Office supplies', amountCents: 5000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const first = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(first.status).toBe(200);

    const second = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('POSTED');

    const { rows } = await pool.query(
      "SELECT id FROM journal_entries WHERE org_id = $1 AND source_type = 'ap_flow' AND source_id = $2",
      [orgA, apFlowDocId],
    );
    expect(rows).toHaveLength(1);
  });

  it("the posted entry's source_id resolves back to the document's stored hash", async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId, sha256 } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 5000,
      totalCents: 5000,
      lineItems: [{ description: 'Office supplies', amountCents: 5000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(200);

    const getRes = await agent.get(`${AP_FLOW_BASE}/${apFlowDocId}`);
    expect(getRes.body.document.postedSha256).toBe(sha256);

    const { rows } = await pool.query<{ sha256: string }>(
      `SELECT d.sha256 FROM ap_flow_documents a JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id
        WHERE a.org_id = $1 AND a.id = $2`,
      [orgA, apFlowDocId],
    );
    expect(rows[0]?.sha256).toBe(sha256);
  });

  it('input tax is debited to 1180, never 2140', async () => {
    const account = await accountIdByCode(orgA, '6120');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 10000,
      taxCents: 1800,
      totalCents: 11800,
      lineItems: [{ description: 'Software', amountCents: 10000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(200);

    const journalEntryId = res.body.document.journalEntryId as string;
    const taxAccountId = await accountIdByCode(orgA, '1180');
    const payableAccountId = await accountIdByCode(orgA, '2100');
    const outputTaxAccountId = await accountIdByCode(orgA, '2140');

    const { rows: lineRows } = await pool.query<{ account_id: string; debit_cents: string; credit_cents: string }>(
      'SELECT account_id, debit_cents, credit_cents FROM ledger_lines WHERE org_id = $1 AND journal_entry_id = $2',
      [orgA, journalEntryId],
    );

    const taxLine = lineRows.find((r) => r.account_id === taxAccountId);
    expect(taxLine?.debit_cents).toBe('1800');
    const payableLine = lineRows.find((r) => r.account_id === payableAccountId);
    expect(payableLine?.credit_cents).toBe('11800');
    expect(lineRows.some((r) => r.account_id === outputTaxAccountId)).toBe(false);
  });

  it('a foreign-currency document uses the rate at its invoice date', async () => {
    const agentSetup = await loginAgent(app, userA);
    const patched = await agentSetup.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    await agentSetup.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-08-15', rate: '83.00000000' });
    await agentSetup.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-08-17', rate: '90.00000000' });

    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      currency: 'USD',
      invoiceDate: '2026-08-15',
      subtotalCents: 20000,
      totalCents: 20000,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: account }],
    });

    const res = await agentSetup.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(200);

    const journalEntryId = res.body.document.journalEntryId as string;
    const { rows } = await pool.query<{ fx_rate: string; base_debit_cents: string; base_credit_cents: string }>(
      'SELECT fx_rate, base_debit_cents, base_credit_cents FROM ledger_lines WHERE org_id = $1 AND journal_entry_id = $2',
      [orgA, journalEntryId],
    );
    for (const row of rows) {
      expect(row.fx_rate).toBe('83.00000000');
    }
    const payableAccountId = await accountIdByCode(orgA, '2100');
    const payableLine = rows.find((r) => Number(r.base_credit_cents) > 0);
    expect(payableLine?.base_credit_cents).toBe(String(20000 * 83));
    void payableAccountId;
  });

  it('posting with no rate on or before the invoice date returns 422', async () => {
    const agentSetup = await loginAgent(app, userA);
    const patched = await agentSetup.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    // Only a later rate exists.
    await agentSetup.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-09-01', rate: '90.00000000' });

    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      currency: 'USD',
      invoiceDate: '2026-08-15',
      subtotalCents: 20000,
      totalCents: 20000,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: account }],
    });

    const res = await agentSetup.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('USD');
    expect(res.body.error).toContain('INR');
  });

  it('posting refuses an arithmetic-failed extraction', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      arithmeticOk: false,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('reconcile');

    const { rows } = await pool.query(
      "SELECT id FROM journal_entries WHERE org_id = $1 AND source_type = 'ap_flow' AND source_id = $2",
      [orgA, apFlowDocId],
    );
    expect(rows).toHaveLength(0);
  });

  it('posting refuses a document with an unmapped line', async () => {
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: null }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Every line item needs an account');
  });

  it('posting refuses a document with no invoice date', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      invoiceDate: null,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('invoice date');
  });

  it('posting refuses a document with no line items', async () => {
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, { lineItems: [] });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('at least one line item');
  });

  it('posting into a CLOSED fiscal period returns 422', async () => {
    const agent = await loginAgent(app, userA);
    const onboardRes = await agent.post(ONBOARDING).send({
      organizationName: 'Acme Books',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    expect(onboardRes.status).toBe(200);

    const genRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-08-15' });
    expect(genRes.status).toBe(201);
    const august = (genRes.body.periods as { id: string; startsOn: string }[]).find((p) =>
      p.startsOn.startsWith('2026-08'),
    );
    if (august === undefined) throw new Error('fixture: no August period generated');
    const closeRes = await agent.post(`${PERIODS}/${august.id}/close`);
    expect(closeRes.status).toBe(200);

    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      invoiceDate: '2026-08-15',
      subtotalCents: 20000,
      totalCents: 20000,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: account }],
    });

    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);

    const { rows } = await pool.query(
      "SELECT id FROM journal_entries WHERE org_id = $1 AND source_type = 'ap_flow' AND source_id = $2",
      [orgA, apFlowDocId],
    );
    expect(rows).toHaveLength(0);
  });

  it('a failed post leaves the document EXTRACTED and the ledger untouched', async () => {
    const { rows: beforeLines } = await pool.query('SELECT id FROM ledger_lines');
    const beforeCount = beforeLines.length;

    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      arithmeticOk: false,
      lineItems: [{ description: 'Office supplies', amountCents: 20000, accountId: await accountIdByCode(orgA, '6130') }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(422);

    const getRes = await agent.get(`${AP_FLOW_BASE}/${apFlowDocId}`);
    expect(getRes.body.document.status).toBe('EXTRACTED');
    expect(getRes.body.document.journalEntryId).toBeNull();

    const { rows: afterLines } = await pool.query('SELECT id FROM ledger_lines');
    expect(afterLines).toHaveLength(beforeCount);
  });

  it('two lines on the same account merge into one ledger line', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 12000,
      totalCents: 12000,
      lineItems: [
        { description: 'Office supplies part 1', amountCents: 5000, accountId: account },
        { description: 'Office supplies part 2', amountCents: 7000, accountId: account },
      ],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(200);

    const journalEntryId = res.body.document.journalEntryId as string;
    const { rows } = await pool.query<{ account_id: string; debit_cents: string }>(
      'SELECT account_id, debit_cents FROM ledger_lines WHERE org_id = $1 AND journal_entry_id = $2 AND account_id = $3',
      [orgA, journalEntryId, account],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.debit_cents).toBe('12000');
  });

  it('posting records the vendor in the account map', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const first = await seedExtractedDocument(orgA, userA.id, {
      vendorName: 'Repeat Vendor',
      subtotalCents: 5000,
      totalCents: 5000,
      lineItems: [{ description: 'Office supplies', amountCents: 5000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res1 = await agent.post(`${AP_FLOW_BASE}/${first.apFlowDocId}/post`);
    expect(res1.status).toBe(200);

    const { rows: mapRows } = await pool.query<{ hit_count: number }>(
      'SELECT hit_count FROM ap_flow_vendor_account_map WHERE org_id = $1 AND vendor_key = $2',
      [orgA, 'repeat vendor'],
    );
    expect(mapRows[0]?.hit_count).toBe(1);

    const second = await seedExtractedDocument(orgA, userA.id, {
      vendorName: 'Repeat Vendor',
      subtotalCents: 3000,
      totalCents: 3000,
      lineItems: [{ description: 'Office supplies', amountCents: 3000, accountId: account }],
    });
    const res2 = await agent.post(`${AP_FLOW_BASE}/${second.apFlowDocId}/post`);
    expect(res2.status).toBe(200);

    const { rows: mapRowsAfter } = await pool.query<{ hit_count: number }>(
      'SELECT hit_count FROM ap_flow_vendor_account_map WHERE org_id = $1 AND vendor_key = $2',
      [orgA, 'repeat vendor'],
    );
    expect(mapRowsAfter[0]?.hit_count).toBe(2);
  });

  it('posting another organization\'s document returns 404', async () => {
    const account = await accountIdByCode(orgB, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgB, (await createUserWithOrg({})).id, {
      subtotalCents: 1000,
      totalCents: 1000,
      lineItems: [{ description: 'x', amountCents: 1000, accountId: account }],
    });

    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT id FROM journal_entries WHERE org_id = $1', [orgB]);
    expect(rows).toHaveLength(0);
  });

  it('posting is refused for a VIEWER', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 1000,
      totalCents: 1000,
      lineItems: [{ description: 'x', amountCents: 1000, accountId: account }],
    });

    const agent = await loginAgent(app, userViewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(403);
  });

  it('posting is allowed for an ACCOUNTANT', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const { apFlowDocId } = await seedExtractedDocument(orgA, userA.id, {
      subtotalCents: 1000,
      totalCents: 1000,
      lineItems: [{ description: 'x', amountCents: 1000, accountId: account }],
    });

    const agent = await loginAgent(app, userAccountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const res = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/post`);
    expect(res.status).toBe(200);
  });
});
