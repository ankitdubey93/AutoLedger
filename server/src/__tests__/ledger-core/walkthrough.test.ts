import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { parseCsv } from '../../utils/csv.js';
import { parseMoneyText } from '../../utils/money.js';
import { parseFlexibleDate } from '../../utils/dateParse.js';
import { scoreMatch } from '../../utils/matchScore.js';
import { WALKTHROUGH_DATASET, type DatasetDocument, type DatasetNote } from '../../scripts/walkthroughDataset.js';
import { resolveSettlementLines, verifyExpectedScores, type ResolvedSettlementLine } from '../../scripts/walkthroughTiers.js';
import { computeExpectedResults } from '../../scripts/walkthroughExpected.js';
import { statement1, statement2, statement3, statement4 } from '../../scripts/walkthroughStatements.js';
import { vendorsCsv, customersCsv } from '../../scripts/walkthroughParties.js';
import { resolveDate, type AnchorMonth, type WalkthroughMonth } from '../../scripts/walkthroughDates.js';

/**
 * The walkthrough scenario (Phase 6.1), Harbor Point Fabrication.
 *
 * The critical case here is the end-to-end replay: the same dataset that
 * drives `07-expected-results.md` is replayed through the real HTTP API —
 * customers, vendors, bills, invoices, four bank statement imports, the
 * match/post-journal/ignore resolutions, and (Phase 26, month 4) credit and
 * debit notes issued and applied — and the *real* reports
 * are asserted to equal `computeExpectedResults`'s output, cent for cent.
 * That is what makes the answer key trustworthy: it has been checked
 * against the product, not just against its own arithmetic.
 */

const app = createApp();
const ANCHOR: AnchorMonth = { year: 2026, month: 6 };

const ACCOUNTS = '/api/v1/ledger-core/accounts';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const MIGRATION_IMPORTS = '/api/v1/ledger-core/migration-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';
const CREDIT_NOTES = '/api/v1/ledger-core/credit-notes';
const DEBIT_NOTES = '/api/v1/ledger-core/debit-notes';
const REPORTS = '/api/v1/ledger-core/reports';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

describe('walkthrough dataset — internal checks', () => {
  it('every vendor and every customer is used by at least one document', () => {
    const usedVendorKeys = new Set(WALKTHROUGH_DATASET.bills.map((b) => b.counterpartyKey));
    const usedCustomerKeys = new Set(WALKTHROUGH_DATASET.invoices.map((i) => i.counterpartyKey));
    for (const v of WALKTHROUGH_DATASET.vendors) expect(usedVendorKeys.has(v.key)).toBe(true);
    for (const c of WALKTHROUGH_DATASET.customers) expect(usedCustomerKeys.has(c.key)).toBe(true);
  });

  it('every revenue and expense account named in a master record is posted to at least once', () => {
    const usedRevenue = new Set(WALKTHROUGH_DATASET.invoices.map((i) => i.accountCode));
    expect(usedRevenue.has('4100')).toBe(true);
    expect(usedRevenue.has('4200')).toBe(true);
    const usedExpense = new Set(WALKTHROUGH_DATASET.bills.map((b) => b.accountCode));
    for (const v of WALKTHROUGH_DATASET.vendors) expect(usedExpense.has(v.expenseAccount)).toBe(true);
  });

  it('every document day is between 1 and 28', () => {
    for (const doc of [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills]) {
      expect(doc.day).toBeGreaterThanOrEqual(1);
      expect(doc.day).toBeLessThanOrEqual(28);
      if (doc.remainder !== null) {
        expect(doc.remainder.day).toBeGreaterThanOrEqual(1);
        expect(doc.remainder.day).toBeLessThanOrEqual(28);
      }
    }
    for (const n of WALKTHROUGH_DATASET.noise) {
      expect(n.day).toBeGreaterThanOrEqual(1);
      expect(n.day).toBeLessThanOrEqual(28);
    }
  });

  it('every hand-derived tier score matches the real scoreMatch engine exactly', () => {
    expect(verifyExpectedScores(ANCHOR)).toEqual([]);
  });

  it('every month is internally balanced: trial balance, balance sheet and reconciliation', () => {
    const months = computeExpectedResults(ANCHOR);
    expect(months).toHaveLength(4);
    for (const m of months) {
      expect(m.trialBalance.isBalanced).toBe(true);
      expect(m.balanceSheet.balances).toBe(true);
      expect(m.bankReconciliation.differenceCents).toBe(0);
    }
  });

  it("month 4 (returns & adjustments) matches the plan's hand-computed figures", () => {
    const month4 = computeExpectedResults(ANCHOR).find((m) => m.month === 4);
    if (month4 === undefined) throw new Error('no month 4');
    // Cumulative net income 98,783.30 + month 4's 5,378.20 (revenue 12,000 +
    // 6,200 − 2,300 returns/allowances + 16.20 interest − 10,500 net steel −
    // 38 fees).
    expect(month4.profitAndLoss.netIncomeCents).toBe(10416150);
    expect(month4.balanceSheet.assets.find((r) => r.code === '1110')?.amountCents).toBe(17916150);
    expect(month4.profitAndLoss.revenue.find((r) => r.code === '4800')?.amountCents).toBe(-230000);
    expect(month4.arAging.reduce((sum, b) => sum + b.amountCents, 0)).toBe(0);
    expect(month4.apAging.reduce((sum, b) => sum + b.amountCents, 0)).toBe(0);
    expect(month4.bankReconciliation.ignoredCount).toBe(4);
  });

  it('every note is dated inside its month and applies no more than its total', () => {
    for (const note of WALKTHROUGH_DATASET.notes) {
      expect(note.day).toBeGreaterThanOrEqual(1);
      expect(note.day).toBeLessThanOrEqual(28);
      const applied = note.allocations.reduce((sum, a) => sum + parseMoneyText(a.amount), 0);
      expect(applied).toBeLessThanOrEqual(parseMoneyText(note.total));
    }
  });

  it('regenerating the answer key with the same anchor is deterministic', () => {
    const first = computeExpectedResults(ANCHOR);
    const second = computeExpectedResults(ANCHOR);
    expect(second).toEqual(first);
  });
});

describe('walkthrough statements — parse with the real CSV/date/money utilities', () => {
  const resolved = resolveSettlementLines(ANCHOR);

  it('statement 1 (comma, ISO) auto-detects headers and every row parses', () => {
    const content = statement1(ANCHOR, resolved);
    const table = parseCsv(content);
    expect(table.delimiter).toBe(',');
    expect(table.headers).toEqual(['Date', 'Description', 'Reference', 'Amount']);
    for (const row of table.rows) {
      const date = parseFlexibleDate(row[table.headers.indexOf('Date')] ?? '', 'ISO');
      expect(date).not.toBeNull();
      expect(() => parseMoneyText(row[table.headers.indexOf('Amount')] ?? '')).not.toThrow();
    }
  });

  it('statement 2 (semicolon, DMY) auto-detects headers despite comma-formatted amounts', () => {
    const content = statement2(ANCHOR, resolved);
    const table = parseCsv(content);
    expect(table.delimiter).toBe(';');
    expect(table.headers).toEqual(['Value Date', 'Narrative', 'Debit', 'Credit']);
    for (const row of table.rows) {
      const date = parseFlexibleDate(row[table.headers.indexOf('Value Date')] ?? '', 'DMY');
      expect(date).not.toBeNull();
    }
  });

  it('statement 3 (comma, MDY) headers do not auto-detect as a date/description pair', () => {
    const content = statement3(ANCHOR, resolved);
    const table = parseCsv(content);
    expect(table.delimiter).toBe(',');
    expect(table.headers).toEqual(['Posted', 'Memo', 'Check No', 'Net']);
    // None of these headers are in the importer's synonym lists — proven by
    // asserting no header equals any known synonym, mirroring what the real
    // resolveColumns() would fail to find.
    const synonyms = new Set(['date', 'description', 'amount', 'debit', 'credit', 'reference']);
    for (const h of table.headers) expect(synonyms.has(h.toLowerCase())).toBe(false);
  });

  it('statement 3 amounts and dates round-trip through the real parsers with the documented column map', () => {
    const content = statement3(ANCHOR, resolved);
    const table = parseCsv(content);
    const dateIdx = table.headers.indexOf('Posted');
    const amountIdx = table.headers.indexOf('Net');
    for (const row of table.rows) {
      expect(parseFlexibleDate(row[dateIdx] ?? '', 'MDY')).not.toBeNull();
      expect(() => parseMoneyText(row[amountIdx] ?? '')).not.toThrow();
    }
  });
});

// -------------------------------------------------------------- end-to-end

let user: SeededUser;
let orgId: string;
let agent: Agent;
const accountIdByCode = new Map<string, string>();
const customerIdByKey = new Map<string, string>();
const vendorIdByKey = new Map<string, string>();
const documentIdByRef = new Map<string, string>();

async function loadAccountId(code: string): Promise<string> {
  const cached = accountIdByCode.get(code);
  if (cached !== undefined) return cached;
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`walkthrough test fixture: no account ${code}`);
  accountIdByCode.set(code, id);
  return id;
}

async function createInterestAccount(): Promise<void> {
  const parentId = await loadAccountId('4000');
  const res = await agent.post(ACCOUNTS).send({
    code: '4300',
    name: 'Interest Income',
    type: 'Revenue',
    parentId,
    isPostable: true,
  });
  if (res.status !== 201) throw new Error(`fixture: could not create 4300: ${res.status} ${res.text}`);
  accountIdByCode.set('4300', res.body.account.id as string);
}

/**
 * Imports the walkthrough's vendors and customers through the Phase 24
 * party importer — the exact `vendors.csv`/`customers.csv` bytes that ship
 * in `walkthrough/`, staged then committed, never a direct `POST /vendors`
 * or `POST /customers` — replaying what `TUTORIAL.md`'s Step 1 actually
 * instructs a person to click through.
 */
async function createVendorsAndCustomers(): Promise<void> {
  const vendorImport = await agent
    .post(MIGRATION_IMPORTS)
    .send({ kind: 'VENDORS', fileName: 'vendors.csv', content: vendorsCsv() });
  if (vendorImport.status !== 201) {
    throw new Error(`fixture: vendor import stage failed ${vendorImport.status} ${vendorImport.text}`);
  }
  if (vendorImport.body.import.status !== 'VALIDATED') {
    throw new Error(`fixture: vendor import did not validate: ${JSON.stringify(vendorImport.body)}`);
  }
  const vendorImportId = vendorImport.body.import.id as string;
  const vendorCommit = await agent.post(`${MIGRATION_IMPORTS}/${vendorImportId}/commit`);
  if (vendorCommit.status !== 200) {
    throw new Error(`fixture: vendor import commit failed ${vendorCommit.status} ${vendorCommit.text}`);
  }
  if (vendorCommit.body.result.createdCount !== WALKTHROUGH_DATASET.vendors.length) {
    throw new Error(`fixture: vendor import created ${String(vendorCommit.body.result.createdCount)}, expected ${String(WALKTHROUGH_DATASET.vendors.length)}`);
  }

  const customerImport = await agent
    .post(MIGRATION_IMPORTS)
    .send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content: customersCsv() });
  if (customerImport.status !== 201) {
    throw new Error(`fixture: customer import stage failed ${customerImport.status} ${customerImport.text}`);
  }
  if (customerImport.body.import.status !== 'VALIDATED') {
    throw new Error(`fixture: customer import did not validate: ${JSON.stringify(customerImport.body)}`);
  }
  const customerImportId = customerImport.body.import.id as string;
  const customerCommit = await agent.post(`${MIGRATION_IMPORTS}/${customerImportId}/commit`);
  if (customerCommit.status !== 200) {
    throw new Error(`fixture: customer import commit failed ${customerCommit.status} ${customerCommit.text}`);
  }
  if (customerCommit.body.result.createdCount !== WALKTHROUGH_DATASET.customers.length) {
    throw new Error(`fixture: customer import created ${String(customerCommit.body.result.createdCount)}, expected ${String(WALKTHROUGH_DATASET.customers.length)}`);
  }

  const vendorList = await agent.get(VENDORS);
  if (vendorList.status !== 200) throw new Error(`fixture: could not list vendors after import`);
  for (const v of WALKTHROUGH_DATASET.vendors) {
    const match = (vendorList.body.vendors as { id: string; name: string }[]).find((r) => r.name === v.name);
    if (match === undefined) throw new Error(`fixture: vendor "${v.name}" not found after import`);
    vendorIdByKey.set(v.key, match.id);
  }

  const customerList = await agent.get(CUSTOMERS);
  if (customerList.status !== 200) throw new Error(`fixture: could not list customers after import`);
  for (const c of WALKTHROUGH_DATASET.customers) {
    const match = (customerList.body.customers as { id: string; name: string }[]).find((r) => r.name === c.name);
    if (match === undefined) throw new Error(`fixture: customer "${c.name}" not found after import`);
    customerIdByKey.set(c.key, match.id);
  }
}

async function enterBill(doc: DatasetDocument): Promise<void> {
  const vendorId = vendorIdByKey.get(doc.counterpartyKey);
  if (vendorId === undefined) throw new Error(`fixture: no vendor for ${doc.ref}`);
  const accountId = await loadAccountId(doc.accountCode);
  const date = resolveDate(ANCHOR, doc.month, doc.day);
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: doc.vendorReference,
    billDate: date,
    dueDate: date,
    lines: [{ description: doc.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(doc.total), expenseAccountId: accountId }],
  });
  if (created.status !== 201) throw new Error(`fixture: bill create failed ${doc.ref}: ${created.status} ${created.text}`);
  const billId = created.body.bill.id as string;
  const submitted = await agent.post(`${BILLS}/${billId}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit failed ${doc.ref}: ${submitted.status} ${submitted.text}`);
  const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${doc.ref}: ${approved.status} ${approved.text}`);
  documentIdByRef.set(doc.ref, billId);
}

async function enterInvoice(doc: DatasetDocument): Promise<void> {
  const customerId = customerIdByKey.get(doc.counterpartyKey);
  if (customerId === undefined) throw new Error(`fixture: no customer for ${doc.ref}`);
  const accountId = await loadAccountId(doc.accountCode);
  const date = resolveDate(ANCHOR, doc.month, doc.day);
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate: date,
    dueDate: date,
    lines: [{ description: doc.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(doc.total), revenueAccountId: accountId }],
  });
  if (created.status !== 201) throw new Error(`fixture: invoice create failed ${doc.ref}: ${created.status} ${created.text}`);
  const invoiceId = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${doc.ref}: ${issued.status} ${issued.text}`);
  documentIdByRef.set(doc.ref, invoiceId);
}

async function importStatement(month: WalkthroughMonth): Promise<void> {
  const resolved = resolveSettlementLines(ANCHOR);
  const cashAccountId = await loadAccountId('1110');
  const body =
    month === 1
      ? { fileName: 'month-1.csv', content: statement1(ANCHOR, resolved), dateFormat: 'ISO' as const, columnMap: null }
      : month === 2
        ? { fileName: 'month-2.csv', content: statement2(ANCHOR, resolved), dateFormat: 'DMY' as const, columnMap: null }
        : month === 4
          ? { fileName: 'month-4.csv', content: statement4(ANCHOR, resolved), dateFormat: 'ISO' as const, columnMap: null }
          : {
            fileName: 'month-3.csv',
            content: statement3(ANCHOR, resolved),
            dateFormat: 'MDY' as const,
            columnMap: { date: 'Posted', description: 'Memo', amount: 'Net', debit: null, credit: null, reference: 'Check No' },
          };
  const res = await agent.post(BANK_IMPORTS).send({ accountId: cashAccountId, ...body });
  if (res.status !== 201) throw new Error(`fixture: import failed month ${String(month)}: ${res.status} ${res.text}`);
}

/**
 * Phase 26 — issues one credit or debit note against its original document,
 * asserts that issuing auto-applied exactly what the dataset says it should
 * to that original, and returns the note id. Applying to any *other*
 * document is `applyNote`, a separate step so the test can observe the
 * unapplied-credit state in between.
 */
async function issueNote(note: DatasetNote): Promise<string> {
  const originalId = documentIdByRef.get(note.againstRef);
  if (originalId === undefined) throw new Error(`fixture: no document for ${note.againstRef}`);
  const accountId = await loadAccountId(note.accountCode);
  const line = { description: note.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(note.total), taxRateBp: 0 };
  const isCredit = note.kind === 'CREDIT_NOTE';
  const base = isCredit ? CREDIT_NOTES : DEBIT_NOTES;
  const body = isCredit
    ? { invoiceId: originalId, issueDate: resolveDate(ANCHOR, note.month, note.day), reasonCode: note.reasonCode, reason: null, notes: null, lines: [{ ...line, revenueAccountId: accountId }] }
    : {
        billId: originalId,
        issueDate: resolveDate(ANCHOR, note.month, note.day),
        reasonCode: note.reasonCode,
        reason: null,
        vendorCreditReference: note.vendorCreditReference,
        notes: null,
        lines: [{ ...line, expenseAccountId: accountId }],
      };
  const created = await agent.post(base).send(body);
  if (created.status !== 201) throw new Error(`fixture: ${note.ref} create failed ${created.status} ${created.text}`);
  const noteId = (isCredit ? created.body.creditNote.id : created.body.debitNote.id) as string;
  const issued = await agent.post(`${base}/${noteId}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: ${note.ref} issue failed ${issued.status} ${issued.text}`);

  const autoApplied = ((isCredit ? issued.body.creditNote : issued.body.debitNote).allocations as Array<{ amountCents: number }>)
    .reduce((sum, a) => sum + a.amountCents, 0);
  const expectedAuto = note.allocations
    .filter((a) => a.documentRef === note.againstRef)
    .reduce((sum, a) => sum + parseMoneyText(a.amount), 0);
  expect(autoApplied, `${note.ref} auto-applied to ${note.againstRef}`).toBe(expectedAuto);
  return noteId;
}

async function applyNote(note: DatasetNote, noteId: string): Promise<void> {
  const base = note.kind === 'CREDIT_NOTE' ? CREDIT_NOTES : DEBIT_NOTES;
  for (const allocation of note.allocations.filter((a) => a.documentRef !== note.againstRef)) {
    const targetId = documentIdByRef.get(allocation.documentRef);
    if (targetId === undefined) throw new Error(`fixture: no document for ${allocation.documentRef}`);
    const res = await agent.post(`${base}/${noteId}/allocations`).send({
      ...(note.kind === 'CREDIT_NOTE' ? { invoiceId: targetId } : { billId: targetId }),
      amountCents: parseMoneyText(allocation.amount),
      allocationDate: resolveDate(ANCHOR, note.month, allocation.day),
    });
    if (res.status !== 201) throw new Error(`fixture: ${note.ref} apply failed ${res.status} ${res.text}`);
  }
}

async function resolveMonth(month: WalkthroughMonth, resolved: ResolvedSettlementLine[]): Promise<void> {
  const cashAccountId = await loadAccountId('1110');
  const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
  const transactions = listRes.body.transactions as Array<{
    id: string;
    description: string;
    amountCents: number;
    suggestions: Array<{ id: string; invoiceId: string | null; billId: string | null; score: number }>;
  }>;

  const monthLines = resolved.filter((l) => l.month === month);
  for (const line of monthLines) {
    const targetDocId = documentIdByRef.get(line.documentRef);
    if (targetDocId === undefined) throw new Error(`fixture: no document id for ${line.documentRef}`);
    const candidates = transactions.filter((t) => t.description === line.description && t.amountCents === line.amountCents);
    const txn = candidates.find((t) => t.suggestions.some((s) => s.invoiceId === targetDocId || s.billId === targetDocId));
    if (txn === undefined) {
      throw new Error(`fixture: no bank transaction with a suggestion for ${line.lineRef} (${line.description}, ${String(line.amountCents)})`);
    }
    const suggestion = txn.suggestions.find((s) => s.invoiceId === targetDocId || s.billId === targetDocId);
    if (suggestion === undefined) throw new Error(`fixture: suggestion vanished for ${line.lineRef}`);
    const res = await agent.post(`${BANK_TRANSACTIONS}/${txn.id}/match`).send({ suggestionId: suggestion.id });
    if (res.status !== 200) throw new Error(`fixture: match failed for ${line.lineRef}: ${res.status} ${res.text}`);
  }

  const noiseThisMonth = WALKTHROUGH_DATASET.noise.filter((n) => n.month === month);
  for (const n of noiseThisMonth) {
    const isoDate = resolveDate(ANCHOR, month, n.day);
    const amountCents = parseMoneyText(n.amount);
    const txn = transactions.find((t) => t.description === n.description && t.amountCents === amountCents);
    if (txn === undefined) throw new Error(`fixture: no bank transaction for noise line "${n.description}" on ${isoDate}`);
    if (n.resolution.kind === 'IGNORE') {
      const res = await agent.post(`${BANK_TRANSACTIONS}/${txn.id}/ignore`).send({});
      if (res.status !== 200) throw new Error(`fixture: ignore failed for "${n.description}": ${res.status} ${res.text}`);
    } else {
      const accId = await loadAccountId(n.resolution.accountCode);
      const res = await agent.post(`${BANK_TRANSACTIONS}/${txn.id}/post-journal`).send({ accountId: accId, description: null });
      if (res.status !== 200) throw new Error(`fixture: post-journal failed for "${n.description}": ${res.status} ${res.text}`);
    }
  }
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'walkthrough', orgName: 'Harbor Point Fabrication' });
  orgId = user.orgId;
  agent = await loginAgent(app, user);
  accountIdByCode.clear();
  customerIdByKey.clear();
  vendorIdByKey.clear();
  documentIdByRef.clear();
});

afterAll(closePool);

describe('walkthrough — end-to-end replay through the real API', () => {
  it('reproduces the computed answer key for all four months, cent for cent', async () => {
    await createInterestAccount();
    await createVendorsAndCustomers();

    const expected = computeExpectedResults(ANCHOR);
    const resolved = resolveSettlementLines(ANCHOR);

    for (const month of [1, 2, 3, 4] as const) {
      for (const bill of WALKTHROUGH_DATASET.bills.filter((b) => b.month === month)) await enterBill(bill);
      for (const invoice of WALKTHROUGH_DATASET.invoices.filter((i) => i.month === month)) await enterInvoice(invoice);

      // Month 4 — issue the notes (in dataset order) before the statement is
      // imported, so the matcher scores against the credited amounts due.
      for (const note of WALKTHROUGH_DATASET.notes.filter((n) => n.month === month)) {
        const noteId = await issueNote(note);
        if (note.ref === 'CN2') {
          // The checkpoint the tutorial tells the user to look at: CN2 is
          // against I13, paid in full in month 3, so none of it applies —
          // Ferrous Works' account shows a 500.00 credit balance, and AR
          // still reconciles to the control account.
          //
          // asOf is I16's date, not CN2's: the aging report's open-document
          // set is today's state (it does not filter documents by their own
          // date — a pre-Phase-26 property of agingService), and I16 is
          // already entered, so only an asOf on/after I16's date lines up with
          // the GL control balance. A user checks this "as of today".
          const ferrousId = customerIdByKey.get('ferrous-works');
          const checkpointDate = resolveDate(ANCHOR, 4, 10);
          const open = await agent.get(`${CUSTOMERS}/${ferrousId ?? ''}/open-items?asOf=${checkpointDate}`);
          expect(open.body.items.some((i: { documentKind: string; baseOutstandingCents: number }) =>
            i.documentKind === 'CREDIT_NOTE' && i.baseOutstandingCents === -50000)).toBe(true);
          const aging = await agent.get(`${REPORTS}/ar-aging?asOf=${checkpointDate}`);
          expect(aging.body.reconciles).toBe(true);
        }
        await applyNote(note, noteId);
      }

      await importStatement(month);
      await resolveMonth(month, resolved);

      const monthExpected = expected.find((e) => e.month === month);
      if (monthExpected === undefined) throw new Error('no expected result for month');

      // ---- trial balance ----
      const tbRes = await agent.get(`${REPORTS}/trial-balance?asOf=${monthExpected.asOf}`);
      expect(tbRes.status).toBe(200);
      expect(tbRes.body.isBalanced).toBe(true);
      expect(tbRes.body.totalDebitCents).toBe(monthExpected.trialBalance.totalDebitCents);
      expect(tbRes.body.totalCreditCents).toBe(monthExpected.trialBalance.totalCreditCents);
      const tbByCode = new Map((tbRes.body.rows as Array<{ code: string; debitCents: number; creditCents: number }>).map((r) => [r.code, r]));
      for (const row of monthExpected.trialBalance.rows) {
        const actual = tbByCode.get(row.code);
        expect(actual, `trial balance row ${row.code} at month ${String(month)}`).toBeDefined();
        expect(actual?.debitCents).toBe(row.debitCents);
        expect(actual?.creditCents).toBe(row.creditCents);
      }

      // ---- profit & loss, explicit window from month 1's start ----
      const monthOneStart = resolveDate(ANCHOR, 1, 1);
      const plRes = await agent.get(`${REPORTS}/profit-and-loss?from=${monthOneStart}&to=${monthExpected.asOf}`);
      expect(plRes.status).toBe(200);
      expect(plRes.body.netIncomeCents).toBe(monthExpected.profitAndLoss.netIncomeCents);
      expect(plRes.body.grossProfitCents).toBe(monthExpected.profitAndLoss.grossProfitCents);
      expect(plRes.body.revenue.totalCents).toBe(monthExpected.profitAndLoss.revenueTotalCents);
      expect(plRes.body.operatingExpenses.totalCents).toBe(monthExpected.profitAndLoss.operatingExpensesTotalCents);

      // ---- balance sheet ----
      const bsRes = await agent.get(`${REPORTS}/balance-sheet?asOf=${monthExpected.asOf}`);
      expect(bsRes.status).toBe(200);
      expect(bsRes.body.balances).toBe(true);
      expect(bsRes.body.assets.totalCents).toBe(monthExpected.balanceSheet.assetsTotalCents);
      expect(bsRes.body.liabilities.totalCents).toBe(monthExpected.balanceSheet.liabilitiesTotalCents);
      expect(bsRes.body.totalLiabilitiesAndEquityCents).toBe(monthExpected.balanceSheet.totalLiabilitiesAndEquityCents);
      // retainedEarningsCents + currentEarningsCents must sum to the expected
      // cumulative net income — the dataset never crosses a fiscal year
      // boundary, so this is the invariant the answer key relies on.
      expect(bsRes.body.equity.retainedEarningsCents + bsRes.body.equity.currentEarningsCents).toBe(
        monthExpected.balanceSheet.cumulativeNetIncomeCents,
      );

      // ---- AR / AP aging ----
      const arRes = await agent.get(`${REPORTS}/ar-aging?asOf=${monthExpected.asOf}`);
      const arByBucket = new Map((arRes.body.buckets as Array<{ bucket: string; amountCents: number }>).map((b) => [b.bucket, b.amountCents]));
      for (const b of monthExpected.arAging) expect(arByBucket.get(b.bucket)).toBe(b.amountCents);

      const apRes = await agent.get(`${REPORTS}/ap-aging?asOf=${monthExpected.asOf}`);
      const apByBucket = new Map((apRes.body.buckets as Array<{ bucket: string; amountCents: number }>).map((b) => [b.bucket, b.amountCents]));
      for (const b of monthExpected.apAging) expect(apByBucket.get(b.bucket)).toBe(b.amountCents);

      // ---- bank reconciliation ----
      const cashAccountId = await loadAccountId('1110');
      const brRes = await agent.get(`${REPORTS}/bank-reconciliation?accountId=${cashAccountId}&asOf=${monthExpected.asOf}`);
      expect(brRes.status).toBe(200);
      expect(brRes.body.differenceCents).toBe(0);
      expect(brRes.body.glBalanceCents).toBe(monthExpected.bankReconciliation.glBalanceCents);
      expect(brRes.body.statementBalanceCents).toBe(monthExpected.bankReconciliation.statementBalanceCents);
      expect(brRes.body.matchedCount).toBe(monthExpected.bankReconciliation.matchedCount);
      expect(brRes.body.unmatchedCount).toBe(0);
      expect(brRes.body.ignoredCount).toBe(monthExpected.bankReconciliation.ignoredCount);
    }

    // Every bank line, across all four months, ends up MATCHED or IGNORED —
    // never left UNMATCHED, and every document was entered.
    const cashAccountId = await loadAccountId('1110');
    const unmatchedRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
    expect(unmatchedRes.body.transactions).toEqual([]);
  }, 120_000);

  it("org B cannot see or match into org A's walkthrough bank lines (cross-tenant isolation)", async () => {
    await createInterestAccount();
    await createVendorsAndCustomers();
    await enterBill(WALKTHROUGH_DATASET.bills[0] as DatasetDocument);
    await importStatement(1);

    const cashAccountId = await loadAccountId('1110');
    const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&limit=100`);
    const txnId = (listRes.body.transactions as Array<{ id: string }>)[0]?.id;
    if (txnId === undefined) throw new Error('fixture: no bank transaction imported');

    const userB = await createUserWithOrg({ label: 'walkthrough-b', orgName: 'Org B' });
    const agentB = await loginAgent(app, userB);
    const getRes = await agentB.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(getRes.status).toBe(404);
    const matchRes = await agentB.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: txnId });
    expect(matchRes.status).toBe(404);
  });
});

describe('walkthrough scoring sanity — one line scored the way the real engine would', () => {
  it("I1's line scores 100 against I1's own candidate shape", () => {
    const doc = WALKTHROUGH_DATASET.invoices.find((i) => i.ref === 'I1');
    if (doc === undefined) throw new Error('fixture: no I1');
    const totalCents = parseMoneyText(doc.total);
    const date = resolveDate(ANCHOR, doc.month, doc.day);
    const breakdown = scoreMatch(
      { amountCents: totalCents, txnDate: date, description: 'ACH CREDIT BRIGHTLINE ANALYTICS', externalReference: null },
      { documentAmountDueCents: totalCents, documentDate: date, counterpartyName: 'Brightline Analytics', documentReference: '' },
    );
    expect(breakdown.total).toBe(100);
  });
});
