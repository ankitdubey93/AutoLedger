import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import { parseCsv } from '../../utils/csv.js';
import { parseMoneyText } from '../../utils/money.js';
import { parseFlexibleDate } from '../../utils/dateParse.js';
import { scoreMatch } from '../../utils/matchScore.js';
import { WALKTHROUGH_DATASET, documentLines, type DatasetDocument } from '../../scripts/walkthroughDataset.js';
import { createWalkthroughReplay, type ReplayClient, type WalkthroughReplay } from '../../scripts/walkthroughReplay.js';
import { resolveSettlementLines, verifyExpectedScores } from '../../scripts/walkthroughTiers.js';
import { computeExpectedResults } from '../../scripts/walkthroughExpected.js';
import { statement1, statement2, statement3, statement5, statement6 } from '../../scripts/walkthroughStatements.js';
import { accountsCsv, billsCsv, invoicesCsv, payrollJournalCsv, productsCsv, stockItemsCsv } from '../../scripts/walkthroughCsv.js';
import {
  WALKTHROUGH_MONTHS,
  lastDayOfWalkthroughMonth,
  monthName,
  resolveDate,
  type AnchorMonth,
} from '../../scripts/walkthroughDates.js';

/**
 * The walkthrough scenario (Phase 6.1), Harbor Point Fabrication.
 *
 * The critical case here is the end-to-end replay: the same dataset that
 * drives `07-expected-results.md` is replayed through the real HTTP API —
 * customers, vendors, bills, invoices, six bank statement imports, the
 * match/post-journal/ignore resolutions, and (Phase 26, month 4) credit and
 * debit notes issued and applied — and the *real* reports
 * are asserted to equal `computeExpectedResults`'s output, cent for cent.
 * That is what makes the answer key trustworthy: it has been checked
 * against the product, not just against its own arithmetic.
 */

const app = createApp();
// April 2026 start: the recurring schedules and the auto-reversing accrual only
// generate occurrences dated on or before today, so every scenario date must be past.
const ANCHOR: AnchorMonth = { year: 2026, month: 4 };

const CUSTOMERS = '/api/v1/customers';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';
const REPORTS = '/api/v1/reports';
// Everything else the replay posts lives in scripts/walkthroughReplay.ts.

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
    expect(months).toHaveLength(6);
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

  it("every multi-line document's lines sum to its total", () => {
    for (const doc of [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills]) {
      if (doc.entry === 'DEPOSIT') continue;
      const sum = documentLines(doc).reduce((acc, l) => acc + Math.round(Number(l.quantity) * parseMoneyText(l.unitPrice)), 0);
      expect(sum, doc.ref).toBe(parseMoneyText(doc.total));
    }
  });

  it('every product and stock item is sold at least once', () => {
    const sold = new Set(
      WALKTHROUGH_DATASET.invoices.flatMap((i) => documentLines(i).map((l) => l.itemCode)).filter((c) => c !== null),
    );
    for (const p of WALKTHROUGH_DATASET.products) expect(sold.has(p.code), p.code).toBe(true);
    for (const s of WALKTHROUGH_DATASET.stockItems) expect(sold.has(s.code), s.code).toBe(true);
  });

  it("month 6 matches the plan's hand-checked balances", () => {
    const month6 = computeExpectedResults(ANCHOR).find((m) => m.month === 6);
    if (month6 === undefined) throw new Error('no month 6');
    const bs = (code: string) =>
      [...month6.balanceSheet.assets, ...month6.balanceSheet.liabilities].find((r) => r.code === code)?.amountCents ?? 0;
    expect(bs('1140')).toBe(743000);
    expect(bs('2130')).toBe(0);
    expect(bs('2120')).toBe(85000);
    expect(bs('2160')).toBe(160000);
    expect(bs('1120')).toBe(477000);
    expect(month6.apAging.reduce((sum, b) => sum + b.amountCents, 0)).toBe(0);
    expect(month6.arAging.find((b) => b.bucket === 'CURRENT')?.amountCents).toBe(477000);
    expect(month6.profitAndLoss.costOfSales.find((r) => r.code === '5050')?.amountCents).toBe(652000);
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

describe('walkthrough statements 5 and 6 and the import CSVs', () => {
  const resolved = resolveSettlementLines(ANCHOR);

  it('statements 5 and 6 parse with the real utilities (ISO and DMY)', () => {
    const five = parseCsv(statement5(ANCHOR, resolved));
    expect(five.rows.length).toBeGreaterThan(0);
    const fiveDate = five.headers.findIndex((h) => h.toLowerCase().includes('date'));
    const fiveAmount = five.headers.findIndex((h) => h.toLowerCase().includes('amount'));
    for (const row of five.rows) {
      expect(parseFlexibleDate(row[fiveDate] ?? '', 'ISO')).not.toBeNull();
      expect(() => parseMoneyText(row[fiveAmount] ?? '')).not.toThrow();
    }
    const six = parseCsv(statement6(ANCHOR, resolved));
    expect(six.rows.length).toBeGreaterThan(0);
    const sixDate = six.headers.findIndex((h) => h.toLowerCase().includes('date'));
    for (const row of six.rows) expect(parseFlexibleDate(row[sixDate] ?? '', 'DMY')).not.toBeNull();
  });

  it('the import CSVs parse with parseCsv and carry the template headers', () => {
    const headers = (csv: string) => parseCsv(csv).headers;
    expect(headers(accountsCsv())).toEqual(['*Code', '*Name', '*Type', 'Parent', 'Description']);
    expect(headers(productsCsv()).filter((h) => h.startsWith('*'))).toEqual(['*ItemCode', '*ItemName']);
    expect(headers(stockItemsCsv()).filter((h) => h.startsWith('*'))).toEqual(['*ItemName']);
    expect(headers(invoicesCsv(ANCHOR, 6)).filter((h) => h.startsWith('*'))).toEqual(['*ContactName', '*InvoiceDate', '*Description']);
    expect(headers(billsCsv(ANCHOR, 6)).filter((h) => h.startsWith('*'))).toEqual([
      '*ContactName', '*InvoiceNumber', '*InvoiceDate', '*Description',
    ]);
    expect(headers(payrollJournalCsv(ANCHOR)).filter((h) => h.startsWith('*'))).toEqual(['*Date', '*Narration', '*AccountCode']);
    expect(parseCsv(billsCsv(ANCHOR, 6)).rows).toHaveLength(3);
    expect(parseCsv(invoicesCsv(ANCHOR, 6)).rows).toHaveLength(2);
    expect(parseCsv(payrollJournalCsv(ANCHOR)).rows).toHaveLength(3);
  });
});

// -------------------------------------------------------------- end-to-end

let replay: WalkthroughReplay;
let agent: Agent;

/** The supertest agent, adapted to the replay's two-verb client. */
function replayClient(a: Agent): ReplayClient {
  return {
    get: async (path) => await a.get(path),
    post: async (path, body) => await a.post(path).send((body ?? {}) as object),
  };
}

beforeEach(async () => {
  await resetTables();
  const user = await createUserWithOrg({ label: 'walkthrough', orgName: 'Harbor Point Fabrication' });
  agent = await loginAgent(app, user);
  replay = createWalkthroughReplay(replayClient(agent), ANCHOR);
});

afterAll(closePool);

describe('walkthrough — end-to-end replay through the real API', () => {
  it('reproduces the computed answer key for all six months, cent for cent', async () => {
    await replay.completeSetup('Harbor Point Fabrication');
    await replay.importAccounts();
    await replay.createVendorsAndCustomers();

    const expected = computeExpectedResults(ANCHOR);

    for (const month of WALKTHROUGH_MONTHS) {
      await replay.replayMonth(month, {
        afterNoteIssued: async (note) => {
          if (note.ref !== 'CN2') return;
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
          const ferrousId = replay.customerId('ferrous-works');
          const checkpointDate = resolveDate(ANCHOR, 4, 10);
          const open = await agent.get(`${CUSTOMERS}/${ferrousId}/open-items?asOf=${checkpointDate}`);
          expect(open.body.items.some((i: { documentKind: string; baseOutstandingCents: number }) =>
            i.documentKind === 'CREDIT_NOTE' && i.baseOutstandingCents === -50000)).toBe(true);
          const aging = await agent.get(`${REPORTS}/ar-aging?asOf=${checkpointDate}`);
          expect(aging.body.reconciles).toBe(true);
        },
      });

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
      expect(plRes.body.costOfSales.totalCents).toBe(monthExpected.profitAndLoss.costOfSalesTotalCents);
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
      const cashAccountId = await replay.accountId('1110');
      const brRes = await agent.get(`${REPORTS}/bank-reconciliation?accountId=${cashAccountId}&asOf=${monthExpected.asOf}`);
      expect(brRes.status).toBe(200);
      expect(brRes.body.differenceCents).toBe(0);
      expect(brRes.body.glBalanceCents).toBe(monthExpected.bankReconciliation.glBalanceCents);
      expect(brRes.body.statementBalanceCents).toBe(monthExpected.bankReconciliation.statementBalanceCents);
      expect(brRes.body.matchedCount).toBe(monthExpected.bankReconciliation.matchedCount);
      expect(brRes.body.unmatchedCount).toBe(0);
      expect(brRes.body.ignoredCount).toBe(monthExpected.bankReconciliation.ignoredCount);

      if (month === 5) {
        // Months 1-4 are now closed: a late adjustment into one of them is refused.
        const late = await agent.post('/api/v1/manual-journals').send({
          narration: 'Late adjustment',
          entryDate: resolveDate(ANCHOR, 4, 15),
          lines: [
            { accountId: await replay.accountId('6600'), debitCents: 1000, creditCents: 0 },
            { accountId: await replay.accountId('3100'), debitCents: 0, creditCents: 1000 },
          ],
          action: 'post',
        });
        expect(late.status, late.text).toBe(422);
      }
    }

    // ---- month 6 checkpoints the tutorial points at ----
    const lastDay = lastDayOfWalkthroughMonth(ANCHOR, 6);
    const valuation = await agent.get(`/api/v1/inventory/valuation?asOf=${lastDay}`);
    expect(valuation.status, valuation.text).toBe(200);
    expect(valuation.body.valuation.tiesOut).toBe(true);
    const inventoryRow = (valuation.body.valuation.accounts as Array<{ code: string; glCents: number }>).find((a) => a.code === '1140');
    expect(inventoryRow?.glCents).toBe(743000);

    const kestrelId = replay.customerId('kestrel-logistics');
    const statementRes = await agent.get(`/api/v1/statements/customers/${kestrelId}?type=OUTSTANDING&asOf=${lastDay}`);
    expect(statementRes.status, statementRes.text).toBe(200);
    expect(statementRes.body.statement.outstandingCents).toBe(477000);

    const rentBill = await agent.get(`/api/v1/bills/${replay.documentId('B15')}`);
    expect(rentBill.status, rentBill.text).toBe(200);
    expect(rentBill.body.bill.lines[0].description).toBe(`Shop rent — ${monthName(ANCHOR, 6)}`);

    // Every bank line, across all four months, ends up MATCHED or IGNORED —
    // never left UNMATCHED, and every document was entered.
    const cashAccountId = await replay.accountId('1110');
    const unmatchedRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
    expect(unmatchedRes.body.transactions).toEqual([]);
  }, 240_000);

  it("org B cannot see or match into org A's walkthrough bank lines (cross-tenant isolation)", async () => {
    await replay.completeSetup('Harbor Point Fabrication');
    await replay.importAccounts();
    await replay.createVendorsAndCustomers();
    await replay.enterBill(WALKTHROUGH_DATASET.bills[0] as DatasetDocument);
    await replay.importStatement(1);

    const cashAccountId = await replay.accountId('1110');
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
