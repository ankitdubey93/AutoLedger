import {
  WALKTHROUGH_DATASET,
  allVendors,
  documentLines,
  resolveTokens,
  type DatasetDocument,
  type DatasetLine,
  type DatasetNote,
  type DatasetOrder,
} from './walkthroughDataset.js';
import { resolveSettlementLines } from './walkthroughTiers.js';
import { statement1, statement2, statement3, statement4, statement5, statement6 } from './walkthroughStatements.js';
import { vendorsCsv, customersCsv } from './walkthroughParties.js';
import { accountsCsv, billsCsv, invoicesCsv, payrollJournalCsv, productsCsv, stockItemsCsv } from './walkthroughCsv.js';
import { resolveDate, shiftIsoDate, type AnchorMonth, type WalkthroughMonth } from './walkthroughDates.js';
import { parseMoneyText } from '../utils/money.js';

/**
 * Replays the walkthrough scenario (Harbor Point Fabrication) through the
 * real HTTP API — the one implementation both consumers share:
 *
 *   - `__tests__/accounting/walkthrough.test.ts` drives it with a supertest
 *     agent and asserts every month's reports equal `computeExpectedResults`,
 *     cent for cent;
 *   - `seedDemo.ts` drives it with a fetch client against a locally started
 *     app to build the demo organization.
 *
 * So the demo company is, by construction, the data the answer-key test
 * proves. Everything goes through routes — never SQL — so the same
 * validation, FSMs, triggers and GL posting a person would hit apply here.
 */

export interface ReplayResponse {
  status: number;
  // Route handlers return many shapes; each caller reads the fields it needs,
  // exactly as the supertest-based test always has.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

/** The two verbs the replay needs; a supertest agent or a fetch wrapper both fit. */
export interface ReplayClient {
  get(path: string): Promise<ReplayResponse>;
  post(path: string, body?: unknown): Promise<ReplayResponse>;
}

export interface ReplayHooks {
  /** Runs after a note is issued (and auto-applied), before it is applied elsewhere. */
  afterNoteIssued?: (note: DatasetNote, noteId: string) => Promise<void>;
}

const ACCOUNTS = '/api/v1/accounts';
const CUSTOMERS = '/api/v1/customers';
const VENDORS = '/api/v1/vendors';
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';
const BANK_IMPORTS = '/api/v1/bank-imports';
const MIGRATION_IMPORTS = '/api/v1/migration-imports';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';
const CREDIT_NOTES = '/api/v1/credit-notes';
const DEBIT_NOTES = '/api/v1/debit-notes';
const SETTINGS = '/api/v1/settings';
const ITEMS = '/api/v1/items';
const BANK_RULES = '/api/v1/bank-rules';
const PURCHASE_ORDERS = '/api/v1/purchase-orders';
const SALES_ORDERS = '/api/v1/orders';
const QUOTES = '/api/v1/quotes';
const RECURRING = '/api/v1/recurring-schedules';
const MANUAL_JOURNALS = '/api/v1/manual-journals';
const FISCAL_PERIODS = '/api/v1/fiscal-periods';

export function createWalkthroughReplay(api: ReplayClient, anchor: AnchorMonth) {
  const accountIdByCode = new Map<string, string>();
  const customerIdByKey = new Map<string, string>();
  const vendorIdByKey = new Map<string, string>();
  const documentIdByRef = new Map<string, string>();
  const itemIdByCode = new Map<string, string>();
  const orderIdByRef = new Map<string, string>();
  /** Sales/purchase order line ids, keyed `<orderRef>:<itemCode>`. */
  const orderLineIdByKey = new Map<string, string>();
  const scheduleIdByRef = new Map<string, string>();
  const bankRuleIds: string[] = [];

  /** Throws `walkthrough: <what> failed <status> <text>` unless the response has one of the expected statuses. */
  function check(res: ReplayResponse, statuses: number | number[], what: string): void {
    const ok = Array.isArray(statuses) ? statuses : [statuses];
    if (!ok.includes(res.status)) throw new Error(`walkthrough: ${what} failed ${String(res.status)} ${res.text}`);
  }

  function dateOf(month: WalkthroughMonth, day: number): string {
    return resolveDate(anchor, month, day);
  }

  async function accountId(code: string): Promise<string> {
    const cached = accountIdByCode.get(code);
    if (cached !== undefined) return cached;
    const res = await api.get(ACCOUNTS);
    if (res.status !== 200) throw new Error(`walkthrough: could not list accounts: ${String(res.status)} ${res.text}`);
    for (const a of res.body.accounts as Array<{ id: string; code: string }>) accountIdByCode.set(a.code, a.id);
    const id = accountIdByCode.get(code);
    if (id === undefined) throw new Error(`walkthrough: no account ${code}`);
    return id;
  }

  /** The setup wizard's one call — the same body `TUTORIAL.md` Step 0 has a person fill in. */
  async function completeSetup(orgName: string): Promise<void> {
    const res = await api.post(`${SETTINGS}/onboarding`, {
      organizationName: orgName,
      legalName: `${orgName} LLC`,
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: dateOf(1, 1),
      industry: 'Manufacturing',
      timezone: 'UTC',
      cashAccountId: await accountId('1110'),
    });
    check(res, 200, 'setup wizard');
  }

  /**
   * Stages a CSV through the migration importer, requires it to validate, commits it, and
   * returns the commit response body. `commitBody` is e.g. `{mode:'POST'}` for documents.
   */
  async function stageAndCommit(kind: string, fileName: string, content: string, commitBody?: object) {
    const staged = await api.post(MIGRATION_IMPORTS, { kind, fileName, content, dateFormat: 'ISO' });
    check(staged, 201, `${kind} import stage`);
    if (staged.body.import.status !== 'VALIDATED') {
      throw new Error(`walkthrough: ${kind} import did not validate: ${JSON.stringify(staged.body)}`);
    }
    const committed = await api.post(`${MIGRATION_IMPORTS}/${staged.body.import.id as string}/commit`, commitBody ?? {});
    check(committed, 200, `${kind} import commit`);
    return committed.body;
  }

  /** Creates 4300 Interest Income through the chart-of-accounts importer (`accounts.csv`). */
  async function importAccounts(): Promise<void> {
    const body = await stageAndCommit('CHART_OF_ACCOUNTS', 'accounts.csv', accountsCsv());
    if (body.result.createdCount !== 1) {
      throw new Error(`walkthrough: accounts import created ${String(body.result.createdCount)}, expected 1`);
    }
    accountIdByCode.clear();
  }

  /**
   * Imports the vendors and customers through the Phase 24 party importer —
   * the exact `vendors.csv`/`customers.csv` bytes that ship in `walkthrough/`,
   * staged then committed, never a direct `POST /vendors` or `POST /customers`
   * — replaying what `TUTORIAL.md`'s Step 1 instructs a person to click through.
   */
  async function importParties(kind: 'VENDORS' | 'CUSTOMERS', fileName: string, content: string, expected: number): Promise<void> {
    const body = await stageAndCommit(kind, fileName, content);
    if (body.result.createdCount !== expected) {
      throw new Error(`walkthrough: ${kind} import created ${String(body.result.createdCount)}, expected ${String(expected)}`);
    }
  }

  async function createVendorsAndCustomers(): Promise<void> {
    await importParties('VENDORS', 'vendors.csv', vendorsCsv(), WALKTHROUGH_DATASET.vendors.length);
    await importParties('CUSTOMERS', 'customers.csv', customersCsv(), WALKTHROUGH_DATASET.customers.length);

    const vendorList = await api.get(VENDORS);
    if (vendorList.status !== 200) throw new Error('walkthrough: could not list vendors after import');
    for (const v of WALKTHROUGH_DATASET.vendors) {
      const match = (vendorList.body.vendors as { id: string; name: string }[]).find((r) => r.name === v.name);
      if (match === undefined) throw new Error(`walkthrough: vendor "${v.name}" not found after import`);
      vendorIdByKey.set(v.key, match.id);
    }

    const customerList = await api.get(CUSTOMERS);
    if (customerList.status !== 200) throw new Error('walkthrough: could not list customers after import');
    for (const c of WALKTHROUGH_DATASET.customers) {
      const match = (customerList.body.customers as { id: string; name: string }[]).find((r) => r.name === c.name);
      if (match === undefined) throw new Error(`walkthrough: customer "${c.name}" not found after import`);
      customerIdByKey.set(c.key, match.id);
    }
  }

  function vendorId(key: string): string {
    const id = vendorIdByKey.get(key);
    if (id === undefined) throw new Error(`walkthrough: no vendor ${key}`);
    return id;
  }

  function customerId(key: string): string {
    const id = customerIdByKey.get(key);
    if (id === undefined) throw new Error(`walkthrough: no customer ${key}`);
    return id;
  }

  /** Quantity text ("200", "1.5") to thousandths. */
  function toMilli(quantity: string): number {
    return Math.round(Number(quantity) * 1000);
  }

  function dueDateOf(doc: DatasetDocument, date: string): string {
    return doc.dueDate === undefined ? date : resolveDate(anchor, doc.dueDate.month, doc.dueDate.day);
  }

  async function enterBill(doc: DatasetDocument): Promise<void> {
    const date = dateOf(doc.month, doc.day);
    const lines = [];
    for (const line of documentLines(doc)) {
      const itemId = line.itemCode === null ? undefined : itemIdByCode.get(line.itemCode);
      lines.push({
        description: resolveTokens(anchor, line.description),
        quantityMilli: toMilli(line.quantity),
        unitPriceCents: parseMoneyText(line.unitPrice),
        expenseAccountId: await accountId(line.accountCode),
        ...(itemId === undefined ? {} : { itemId }),
      });
    }
    const created = await api.post(BILLS, {
      vendorId: vendorId(doc.counterpartyKey),
      vendorReference: doc.vendorReference === null ? null : resolveTokens(anchor, doc.vendorReference),
      billDate: date,
      dueDate: dueDateOf(doc, date),
      lines,
    });
    check(created, 201, `bill create ${doc.ref}`);
    const billId = created.body.bill.id as string;
    check(await api.post(`${BILLS}/${billId}/submit`, {}), 200, `bill submit ${doc.ref}`);
    check(await api.post(`${BILLS}/${billId}/approve`, {}), 200, `bill approve ${doc.ref}`);
    documentIdByRef.set(doc.ref, billId);
  }

  async function enterInvoice(doc: DatasetDocument): Promise<void> {
    const date = dateOf(doc.month, doc.day);
    const lines = [];
    for (const line of documentLines(doc)) {
      const itemId = line.itemCode === null ? undefined : itemIdByCode.get(line.itemCode);
      lines.push({
        description: resolveTokens(anchor, line.description),
        quantityMilli: toMilli(line.quantity),
        unitPriceCents: parseMoneyText(line.unitPrice),
        revenueAccountId: await accountId(line.accountCode),
        ...(itemId === undefined ? {} : { itemId }),
      });
    }
    const created = await api.post(INVOICES, {
      customerId: customerId(doc.counterpartyKey),
      issueDate: date,
      dueDate: dueDateOf(doc, date),
      lines,
    });
    check(created, 201, `invoice create ${doc.ref}`);
    const invoiceId = created.body.invoice.id as string;
    check(await api.post(`${INVOICES}/${invoiceId}/issue`, {}), 200, `invoice issue ${doc.ref}`);
    documentIdByRef.set(doc.ref, invoiceId);
  }

  async function importStatement(month: WalkthroughMonth): Promise<void> {
    const resolved = resolveSettlementLines(anchor);
    const cashAccountId = await accountId('1110');
    type Body = { fileName: string; content: string; dateFormat: 'ISO' | 'DMY' | 'MDY'; columnMap: object | null };
    const threeMap = { date: 'Posted', description: 'Memo', amount: 'Net', debit: null, credit: null, reference: 'Check No' };
    const bodies: Record<WalkthroughMonth, Body> = {
      1: { fileName: 'month-1.csv', content: statement1(anchor, resolved), dateFormat: 'ISO', columnMap: null },
      2: { fileName: 'month-2.csv', content: statement2(anchor, resolved), dateFormat: 'DMY', columnMap: null },
      3: { fileName: 'month-3.csv', content: statement3(anchor, resolved), dateFormat: 'MDY', columnMap: threeMap },
      4: { fileName: 'month-4.csv', content: statement4(anchor, resolved), dateFormat: 'ISO', columnMap: null },
      5: { fileName: 'month-5.csv', content: statement5(anchor, resolved), dateFormat: 'ISO', columnMap: null },
      6: { fileName: 'month-6.csv', content: statement6(anchor, resolved), dateFormat: 'DMY', columnMap: null },
    };
    const res = await api.post(BANK_IMPORTS, { accountId: cashAccountId, ...bodies[month] });
    check(res, 201, `bank statement import month ${String(month)}`);
  }

  /**
   * Phase 26 — issues one credit or debit note against its original document,
   * checks that issuing auto-applied exactly what the dataset says it should
   * to that original, and returns the note id. Applying to any *other*
   * document is `applyNote`, a separate step so a caller can observe the
   * unapplied-credit state in between.
   */
  async function issueNote(note: DatasetNote): Promise<string> {
    const originalId = documentIdByRef.get(note.againstRef);
    if (originalId === undefined) throw new Error(`walkthrough: no document for ${note.againstRef}`);
    const noteAccountId = await accountId(note.accountCode);
    const line = { description: note.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(note.total), taxRateBp: 0 };
    const isCredit = note.kind === 'CREDIT_NOTE';
    const base = isCredit ? CREDIT_NOTES : DEBIT_NOTES;
    const issueDate = resolveDate(anchor, note.month, note.day);
    const body = isCredit
      ? { invoiceId: originalId, issueDate, reasonCode: note.reasonCode, reason: null, notes: null, lines: [{ ...line, revenueAccountId: noteAccountId }] }
      : {
          billId: originalId,
          issueDate,
          reasonCode: note.reasonCode,
          reason: null,
          vendorCreditReference: note.vendorCreditReference,
          notes: null,
          lines: [{ ...line, expenseAccountId: noteAccountId }],
        };
    const created = await api.post(base, body);
    if (created.status !== 201) throw new Error(`walkthrough: ${note.ref} create failed ${String(created.status)} ${created.text}`);
    const noteId = (isCredit ? created.body.creditNote.id : created.body.debitNote.id) as string;
    const issued = await api.post(`${base}/${noteId}/issue`, {});
    if (issued.status !== 200) throw new Error(`walkthrough: ${note.ref} issue failed ${String(issued.status)} ${issued.text}`);

    const autoApplied = ((isCredit ? issued.body.creditNote : issued.body.debitNote).allocations as Array<{ amountCents: number }>)
      .reduce((sum, a) => sum + a.amountCents, 0);
    const expectedAuto = note.allocations
      .filter((a) => a.documentRef === note.againstRef)
      .reduce((sum, a) => sum + parseMoneyText(a.amount), 0);
    if (autoApplied !== expectedAuto) {
      throw new Error(`walkthrough: ${note.ref} auto-applied ${String(autoApplied)} to ${note.againstRef}, expected ${String(expectedAuto)}`);
    }
    return noteId;
  }

  async function applyNote(note: DatasetNote, noteId: string): Promise<void> {
    const base = note.kind === 'CREDIT_NOTE' ? CREDIT_NOTES : DEBIT_NOTES;
    for (const allocation of note.allocations.filter((a) => a.documentRef !== note.againstRef)) {
      const targetId = documentIdByRef.get(allocation.documentRef);
      if (targetId === undefined) throw new Error(`walkthrough: no document for ${allocation.documentRef}`);
      const res = await api.post(`${base}/${noteId}/allocations`, {
        ...(note.kind === 'CREDIT_NOTE' ? { invoiceId: targetId } : { billId: targetId }),
        amountCents: parseMoneyText(allocation.amount),
        allocationDate: resolveDate(anchor, note.month, allocation.day),
      });
      if (res.status !== 201) throw new Error(`walkthrough: ${note.ref} apply failed ${String(res.status)} ${res.text}`);
    }
  }

  /** Matches every settlement line to its document's suggestion, then posts or ignores the noise lines. */
  async function resolveMonth(month: WalkthroughMonth): Promise<void> {
    const resolved = resolveSettlementLines(anchor);
    const cashAccountId = await accountId('1110');
    const listRes = await api.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
    const transactions = listRes.body.transactions as Array<{
      id: string;
      description: string;
      amountCents: number;
      suggestions: Array<{ id: string; invoiceId: string | null; billId: string | null; score: number }>;
    }>;

    for (const line of resolved.filter((l) => l.month === month)) {
      const targetDocId = documentIdByRef.get(line.documentRef);
      if (targetDocId === undefined) throw new Error(`walkthrough: no document id for ${line.documentRef}`);
      const candidates = transactions.filter((t) => t.description === line.description && t.amountCents === line.amountCents);
      const txn = candidates.find((t) => t.suggestions.some((s) => s.invoiceId === targetDocId || s.billId === targetDocId));
      if (txn === undefined) {
        throw new Error(`walkthrough: no bank transaction with a suggestion for ${line.lineRef} (${line.description}, ${String(line.amountCents)})`);
      }
      const suggestion = txn.suggestions.find((s) => s.invoiceId === targetDocId || s.billId === targetDocId);
      if (suggestion === undefined) throw new Error(`walkthrough: suggestion vanished for ${line.lineRef}`);
      const res = await api.post(`${BANK_TRANSACTIONS}/${txn.id}/match`, { suggestionId: suggestion.id });
      if (res.status !== 200) throw new Error(`walkthrough: match failed for ${line.lineRef}: ${String(res.status)} ${res.text}`);
    }

    // A RULE line is settled by the bank rule on import — look it up among all
    // lines (it is no longer UNMATCHED) and require it to be MATCHED; never post it here.
    const allRes = await api.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&limit=100`);
    check(allRes, 200, 'bank transaction list');
    const allTransactions = allRes.body.transactions as Array<{ id: string; description: string; amountCents: number; status: string }>;

    for (const n of WALKTHROUGH_DATASET.noise.filter((x) => x.month === month)) {
      const amountCents = parseMoneyText(n.amount);
      if (n.resolution.kind === 'RULE') {
        const ruled = allTransactions.find(
          (t) => t.description === n.description && t.amountCents === amountCents && t.status === 'MATCHED',
        );
        if (ruled === undefined) {
          throw new Error(`walkthrough: bank rule did not settle "${n.description}" on ${resolveDate(anchor, month, n.day)}`);
        }
        continue;
      }
      const txn = transactions.find((t) => t.description === n.description && t.amountCents === amountCents);
      if (txn === undefined) {
        throw new Error(`walkthrough: no bank transaction for noise line "${n.description}" on ${resolveDate(anchor, month, n.day)}`);
      }
      if (n.resolution.kind === 'IGNORE') {
        const res = await api.post(`${BANK_TRANSACTIONS}/${txn.id}/ignore`, {});
        if (res.status !== 200) throw new Error(`walkthrough: ignore failed for "${n.description}": ${String(res.status)} ${res.text}`);
      } else {
        const res = await api.post(`${BANK_TRANSACTIONS}/${txn.id}/post-journal`, {
          accountId: await accountId(n.resolution.accountCode),
          description: null,
        });
        if (res.status !== 200) throw new Error(`walkthrough: post-journal failed for "${n.description}": ${String(res.status)} ${res.text}`);
      }
    }
  }

  // ------------------------------------------------------------ month 5 & 6 additions

  async function importProducts(): Promise<void> {
    const body = await stageAndCommit('ITEMS', 'products.csv', productsCsv());
    const expected = WALKTHROUGH_DATASET.products.length;
    if (body.result.createdCount !== expected) {
      throw new Error(`walkthrough: products import created ${String(body.result.createdCount)}, expected ${String(expected)}`);
    }
    await cacheItems();
  }

  /** Amendment A1 — the stock-items import validates Category against configured categories; Manufacturing seeds CMP. */
  async function setupInventory(): Promise<void> {
    check(await api.post('/api/v1/inventory/setup', { industryProfile: 'MANUFACTURING' }), 200, 'inventory setup');
  }

  async function importStockItems(): Promise<void> {
    const body = await stageAndCommit('INVENTORY_ITEMS', 'stock-items.csv', stockItemsCsv());
    const expected = WALKTHROUGH_DATASET.stockItems.length;
    if (body.result.createdCount !== expected) {
      throw new Error(`walkthrough: stock items import created ${String(body.result.createdCount)}, expected ${String(expected)}`);
    }
    await cacheItems();
  }

  async function cacheItems(): Promise<void> {
    const res = await api.get(ITEMS);
    check(res, 200, 'item list');
    for (const item of res.body.items as Array<{ id: string; code: string | null }>) {
      if (item.code !== null) itemIdByCode.set(item.code, item.id);
    }
  }

  function itemId(code: string): string {
    const id = itemIdByCode.get(code);
    if (id === undefined) throw new Error(`walkthrough: no item ${code}`);
    return id;
  }

  async function createBankRules(): Promise<void> {
    for (const rule of WALKTHROUGH_DATASET.bankRules) {
      const res = await api.post(BANK_RULES, {
        name: rule.name,
        priority: rule.priority,
        direction: rule.direction,
        memoContains: rule.memoContains,
        amountMinCents: rule.amountMinCents,
        amountMaxCents: rule.amountMaxCents,
        bankAccountId: await accountId(rule.bankAccountCode),
        targetAccountId: await accountId(rule.targetAccountCode),
        description: rule.description,
      });
      check(res, 201, `bank rule ${rule.name}`);
      bankRuleIds.push(res.body.bankRule.id as string);
    }
  }

  async function orderLinePayload(lines: DatasetLine[]) {
    const out = [];
    for (const line of lines) {
      out.push({
        description: line.description,
        quantityMilli: toMilli(line.quantity),
        unitPriceCents: parseMoneyText(line.unitPrice),
        accountId: await accountId(line.accountCode),
        taxRateBp: 0,
        itemId: itemId(line.itemCode ?? ''),
      });
    }
    return out;
  }

  function datasetOrder(ref: string): DatasetOrder {
    const order = WALKTHROUGH_DATASET.orders.find((o) => o.ref === ref);
    if (order === undefined) throw new Error(`walkthrough: no order ${ref}`);
    return order;
  }

  function datasetDocument(ref: string): DatasetDocument {
    const doc = [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].find((d) => d.ref === ref);
    if (doc === undefined) throw new Error(`walkthrough: no document ${ref}`);
    return doc;
  }

  /** PO1: create, confirm, convert (all lines) to the bill B13, submit and approve — receives the stock. */
  async function enterPurchaseOrder(orderRef: string): Promise<void> {
    const order = datasetOrder(orderRef);
    const bill = WALKTHROUGH_DATASET.bills.find((b) => b.orderRef === orderRef);
    if (bill === undefined) throw new Error(`walkthrough: no bill raised from ${orderRef}`);
    const created = await api.post(PURCHASE_ORDERS, {
      partyId: vendorId(order.counterpartyKey),
      orderDate: dateOf(order.month, order.day),
      expectedDate: null,
      partyReference: null,
      notes: null,
      terms: null,
      paymentTerms: null,
      paymentTermsCode: null,
      lines: await orderLinePayload(order.lines),
    });
    check(created, 201, `purchase order ${orderRef} create`);
    const id = created.body.order.id as string;
    check(await api.post(`${PURCHASE_ORDERS}/${id}/confirm`, {}), 200, `purchase order ${orderRef} confirm`);
    orderIdByRef.set(orderRef, id);
    const date = dateOf(bill.month, bill.day);
    const converted = await api.post(`${PURCHASE_ORDERS}/${id}/convert`, {
      documentDate: date,
      dueDate: dueDateOf(bill, date),
      vendorReference: bill.vendorReference === null ? null : resolveTokens(anchor, bill.vendorReference),
      lines: null,
    });
    check(converted, 201, `purchase order ${orderRef} convert`);
    const billId = converted.body.document.id as string;
    check(await api.post(`${BILLS}/${billId}/submit`, {}), 200, `bill submit ${bill.ref}`);
    check(await api.post(`${BILLS}/${billId}/approve`, {}), 200, `bill approve ${bill.ref}`);
    documentIdByRef.set(bill.ref, billId);
  }

  /** QU1: create, send (manual), accept, convert to the sales order SO1. */
  async function enterSalesQuoteToOrder(orderRef: string): Promise<void> {
    const order = datasetOrder(orderRef);
    const quoteDate = dateOf(order.month, order.quoteDay ?? order.day);
    const created = await api.post(QUOTES, {
      partyId: customerId(order.counterpartyKey),
      quoteDate,
      validUntil: shiftIsoDate(quoteDate, 400),
      partyReference: null,
      title: 'Caster and fitting supply with installation',
      notes: null,
      paymentTerms: null,
      paymentTermsCode: null,
      depositPercentBp: null,
      lines: await orderLinePayload(order.lines),
    });
    check(created, 201, `quote ${order.quoteRef ?? ''} create`);
    const quoteId = created.body.quote.id as string;
    check(await api.post(`${QUOTES}/${quoteId}/send`, { delivery: 'MANUAL', toEmail: null, message: null, templateId: null }), 200, 'quote send');
    check(await api.post(`${QUOTES}/${quoteId}/accept`, { signerName: 'Morgan Reyes', note: null }), 200, 'quote accept');
    const converted = await api.post(`${QUOTES}/${quoteId}/convert`, {
      documentDate: null,
      dueDate: null,
      vendorReference: null,
      target: 'ORDER',
    });
    check(converted, 201, `quote ${order.quoteRef ?? ''} convert to order`);
    const orderId = converted.body.document.id as string;
    orderIdByRef.set(orderRef, orderId);
    const fetched = await api.get(`${SALES_ORDERS}/${orderId}`);
    check(fetched, 200, `sales order ${orderRef} read`);
    for (const line of fetched.body.order.lines as Array<{ id: string; itemId: string | null }>) {
      const code = [...itemIdByCode].find(([, id]) => id === line.itemId)?.[0];
      if (code !== undefined) orderLineIdByKey.set(`${orderRef}:${code}`, line.id);
    }
  }

  function salesOrderId(ref: string): string {
    const id = orderIdByRef.get(ref);
    if (id === undefined) throw new Error(`walkthrough: order ${ref} has not been created`);
    return id;
  }

  /** D1: a 25% deposit invoice against SO1, issued. */
  async function raiseDeposit(docRef: string): Promise<void> {
    const doc = datasetDocument(docRef);
    if (doc.orderRef === undefined) throw new Error(`walkthrough: ${docRef} has no order`);
    const date = dateOf(doc.month, doc.day);
    const created = await api.post(`${SALES_ORDERS}/${salesOrderId(doc.orderRef)}/deposit`, {
      percentBp: 2500,
      amountCents: null,
      documentDate: date,
      dueDate: dueDateOf(doc, date),
      vendorReference: null,
    });
    check(created, 201, `deposit ${docRef} create`);
    const id = created.body.document.id as string;
    const issued = await api.post(`${INVOICES}/${id}/issue`, {});
    check(issued, 200, `deposit ${docRef} issue`);
    if (issued.body.invoice.totalCents !== parseMoneyText(doc.total)) {
      throw new Error(`walkthrough: ${docRef} total ${String(issued.body.invoice.totalCents)}, expected ${String(parseMoneyText(doc.total))}`);
    }
    documentIdByRef.set(docRef, id);
  }

  /** I17 / I20: an invoice raised from SO1, issued (I20 applying its deposit on issue). */
  async function invoiceFromOrder(docRef: string): Promise<void> {
    const doc = datasetDocument(docRef);
    if (doc.orderRef === undefined) throw new Error(`walkthrough: ${docRef} has no order`);
    const date = dateOf(doc.month, doc.day);
    const orderId = salesOrderId(doc.orderRef);
    const lines =
      doc.orderLines === undefined || doc.orderLines === null
        ? null
        : doc.orderLines.map((l) => {
            const orderLineId = orderLineIdByKey.get(`${doc.orderRef ?? ''}:${l.itemCode}`);
            if (orderLineId === undefined) throw new Error(`walkthrough: no order line for ${l.itemCode}`);
            return { orderLineId, quantityMilli: toMilli(l.quantity) };
          });
    const converted = await api.post(`${SALES_ORDERS}/${orderId}/convert`, {
      documentDate: date,
      dueDate: doc.dueDate === undefined ? date : shiftIsoDate(date, 30),
      vendorReference: null,
      lines,
    });
    check(converted, 201, `invoice ${docRef} from order`);
    const invoiceId = converted.body.document.id as string;

    const applications = WALKTHROUGH_DATASET.depositApplications.filter((a) => a.documentRef === docRef);
    const applyCredits = applications.map((a) => {
      const depositId = documentIdByRef.get(a.depositRef);
      if (depositId === undefined) throw new Error(`walkthrough: no deposit ${a.depositRef}`);
      return { kind: 'DEPOSIT', id: depositId, amountCents: parseMoneyText(a.amount) };
    });
    const issued = await api.post(`${INVOICES}/${invoiceId}/issue`, applyCredits.length > 0 ? { applyCredits } : {});
    check(issued, 200, `invoice ${docRef} issue`);
    const totalCents = parseMoneyText(doc.total);
    const appliedCents = applyCredits.reduce((sum, c) => sum + c.amountCents, 0);
    if (issued.body.invoice.totalCents !== totalCents) {
      throw new Error(`walkthrough: ${docRef} total ${String(issued.body.invoice.totalCents)}, expected ${String(totalCents)}`);
    }
    if (applyCredits.length > 0 && issued.body.invoice.amountDueCents !== totalCents - appliedCents) {
      throw new Error(`walkthrough: ${docRef} amount due ${String(issued.body.invoice.amountDueCents)}, expected ${String(totalCents - appliedCents)}`);
    }
    documentIdByRef.set(docRef, invoiceId);
  }

  /** B14: the rent bill becomes a monthly schedule (one more run, in month 6). */
  async function makeRecurring(billRef: string): Promise<void> {
    const billId = documentIdByRef.get(billRef);
    if (billId === undefined) throw new Error(`walkthrough: no bill ${billRef}`);
    const res = await api.post(RECURRING, {
      kind: 'BILL',
      sourceId: billId,
      name: 'Shop rent',
      frequency: 'MONTHLY',
      intervalCount: 1,
      startDate: dateOf(6, 1),
      endDate: dateOf(6, 1),
      mode: 'DRAFT',
      autoReverse: false,
    });
    check(res, 201, `recurring schedule for ${billRef}`);
    scheduleIdByRef.set(billRef, res.body.schedule.id as string);
  }

  /** B15: run the rent schedule, take the generated draft, submit and approve it. */
  async function approveRecurringBill(billRef: string): Promise<void> {
    const doc = datasetDocument(billRef);
    const scheduleId = scheduleIdByRef.get('B14');
    if (scheduleId === undefined) throw new Error('walkthrough: the rent schedule has not been created');
    const ran = await api.post(`${RECURRING}/${scheduleId}/run`, {});
    check(ran, 200, 'rent schedule run');
    if (ran.body.generated !== 1) throw new Error(`walkthrough: rent schedule generated ${String(ran.body.generated)}, expected 1`);
    const fetched = await api.get(`${RECURRING}/${scheduleId}`);
    check(fetched, 200, 'rent schedule read');
    const runDate = dateOf(doc.month, doc.day);
    const run = (fetched.body.schedule.runs as Array<{ runDate: string; billId: string | null }>).find((r) => r.runDate === runDate);
    if (run === undefined || run.billId === null) throw new Error(`walkthrough: no generated bill for ${runDate}`);
    check(await api.post(`${BILLS}/${run.billId}/submit`, {}), 200, `bill submit ${billRef}`);
    check(await api.post(`${BILLS}/${run.billId}/approve`, {}), 200, `bill approve ${billRef}`);
    documentIdByRef.set(billRef, run.billId);
  }

  /** ACC1: a repeating, auto-reversing utilities accrual; the sweep is run by hand. */
  async function createRepeatingAccrual(journalRef: string): Promise<void> {
    const journal = WALKTHROUGH_DATASET.journals.find((j) => j.ref === journalRef);
    if (journal === undefined || journal.repeat === null) throw new Error(`walkthrough: no repeating journal ${journalRef}`);
    const lines = [];
    for (const l of journal.lines) {
      lines.push({
        accountId: await accountId(l.accountCode),
        description: l.description,
        debitCents: parseMoneyText(l.debit),
        creditCents: parseMoneyText(l.credit),
      });
    }
    const start = dateOf(journal.month, journal.day);
    const created = await api.post(`${MANUAL_JOURNALS}/repeating`, {
      narration: journal.narration,
      entryDate: start,
      lines,
      name: 'Utilities accrual',
      frequency: 'MONTHLY',
      intervalCount: 1,
      startDate: start,
      endDate: dateOf(journal.repeat.endMonth, journal.repeat.endDay),
      autoReverse: journal.repeat.autoReverse,
    });
    check(created, 201, `repeating journal ${journalRef}`);
    const scheduleId = created.body.schedule.id as string;
    const ran = await api.post(`${RECURRING}/${scheduleId}/run`, {});
    check(ran, 200, `repeating journal ${journalRef} run`);
    if (ran.body.generated !== 2) {
      throw new Error(`walkthrough: ${journalRef} generated ${String(ran.body.generated)} occurrences, expected 2: ${ran.text}`);
    }
  }

  async function createExtraVendors(): Promise<void> {
    for (const v of WALKTHROUGH_DATASET.extraVendors) {
      const res = await api.post(VENDORS, {
        name: v.name,
        email: v.email,
        phone: v.phone,
        billingAddress: v.address,
        taxNumber: v.taxNumber,
        paymentTerms: null,
        notes: null,
        defaultPaymentTermId: null,
      });
      check(res, 201, `vendor ${v.name} create`);
      vendorIdByKey.set(v.key, res.body.vendor.id as string);
    }
  }

  /** Imports month-6 invoices or bills (commit mode POST) and learns their ids by party, total and date. */
  async function importDocuments(kind: 'INVOICES' | 'BILLS', month: WalkthroughMonth): Promise<void> {
    const isInvoice = kind === 'INVOICES';
    await stageAndCommit(
      kind,
      isInvoice ? `invoices-month-${String(month)}.csv` : `bills-month-${String(month)}.csv`,
      isInvoice ? invoicesCsv(anchor, month) : billsCsv(anchor, month),
      { mode: 'POST' },
    );
    const listed = await api.get(`${isInvoice ? INVOICES : BILLS}?limit=100`);
    check(listed, 200, `${kind} list`);
    const rows = (isInvoice ? listed.body.invoices : listed.body.bills) as Array<{
      id: string;
      customerName?: string;
      vendorName?: string;
      issueDate?: string;
      billDate?: string;
      totalCents: number;
    }>;
    const docs = isInvoice ? WALKTHROUGH_DATASET.invoices : WALKTHROUGH_DATASET.bills;
    for (const doc of docs.filter((d) => d.entry === 'IMPORT' && d.month === month)) {
      const partyName = isInvoice
        ? WALKTHROUGH_DATASET.customers.find((c) => c.key === doc.counterpartyKey)?.name
        : allVendors().find((v) => v.key === doc.counterpartyKey)?.name;
      const date = dateOf(doc.month, doc.day);
      const match = rows.find(
        (r) =>
          (isInvoice ? r.customerName : r.vendorName) === partyName &&
          (isInvoice ? r.issueDate : r.billDate) === date &&
          r.totalCents === parseMoneyText(doc.total),
      );
      if (match === undefined) throw new Error(`walkthrough: imported ${doc.ref} not found in the ${kind} list`);
      documentIdByRef.set(doc.ref, match.id);
    }
  }

  async function importPayroll(): Promise<void> {
    const body = await stageAndCommit('JOURNALS', 'payroll-month-6.csv', payrollJournalCsv(anchor));
    if (body.result.entryCount !== 1) {
      throw new Error(`walkthrough: payroll import created ${String(body.result.entryCount)} entries, expected 1`);
    }
  }

  /** Generates the fiscal periods, then closes the ones this point in the story closes. */
  async function closePeriods(afterMonth: WalkthroughMonth): Promise<void> {
    for (const containingDate of [dateOf(1, 1), dateOf(6, 1)]) {
      check(await api.post(`${FISCAL_PERIODS}/generate`, { containingDate }), [200, 201], 'fiscal period generate');
    }
    const listed = await api.get(FISCAL_PERIODS);
    check(listed, 200, 'fiscal period list');
    const periods = listed.body.periods as Array<{ id: string; startsOn: string }>;
    for (const plan of WALKTHROUGH_DATASET.periodCloses.filter((p) => p.afterMonth === afterMonth)) {
      for (const m of plan.closeMonths) {
        const start = dateOf(m, 1);
        const period = periods.find((p) => p.startsOn === start);
        if (period === undefined) throw new Error(`walkthrough: no fiscal period starting ${start}`);
        check(await api.post(`${FISCAL_PERIODS}/${period.id}/close`, {}), 200, `fiscal period ${start} close`);
      }
    }
  }

  /**
   * One month end to end: bills, invoices, then (month 4) the notes — issued
   * before the statement is imported, so the matcher scores against the
   * credited amounts due — then the statement import and its resolution.
   * Months 5 and 6 run their own scripted order (products, orders, imports).
   */
  async function replayMonth(month: WalkthroughMonth, hooks: ReplayHooks = {}): Promise<void> {
    if (month === 5) {
      await importProducts();
      await setupInventory();
      await importStockItems();
      await createBankRules();
      await enterBill(datasetDocument('B14'));
      await makeRecurring('B14');
      await enterPurchaseOrder('PO1');
      await enterSalesQuoteToOrder('SO1');
      await raiseDeposit('D1');
      await invoiceFromOrder('I17');
      await createRepeatingAccrual('ACC1');
      await importStatement(5);
      await resolveMonth(5);
      await closePeriods(5);
      return;
    }
    if (month === 6) {
      await createExtraVendors();
      await approveRecurringBill('B15');
      await importDocuments('INVOICES', 6);
      await importDocuments('BILLS', 6);
      await importPayroll();
      await invoiceFromOrder('I20');
      await importStatement(6);
      await resolveMonth(6);
      await closePeriods(6);
      return;
    }
    for (const bill of WALKTHROUGH_DATASET.bills.filter((b) => b.month === month)) await enterBill(bill);
    for (const invoice of WALKTHROUGH_DATASET.invoices.filter((i) => i.month === month)) await enterInvoice(invoice);
    for (const note of WALKTHROUGH_DATASET.notes.filter((n) => n.month === month)) {
      const noteId = await issueNote(note);
      if (hooks.afterNoteIssued !== undefined) await hooks.afterNoteIssued(note, noteId);
      await applyNote(note, noteId);
    }
    await importStatement(month);
    await resolveMonth(month);
  }

  function documentId(ref: string): string {
    const id = documentIdByRef.get(ref);
    if (id === undefined) throw new Error(`walkthrough: no document ${ref}`);
    return id;
  }

  return {
    accountId,
    customerId,
    vendorId,
    completeSetup,
    importAccounts,
    importProducts,
    setupInventory,
    importStockItems,
    createBankRules,
    enterPurchaseOrder,
    enterSalesQuoteToOrder,
    raiseDeposit,
    invoiceFromOrder,
    makeRecurring,
    approveRecurringBill,
    createRepeatingAccrual,
    importDocuments,
    importPayroll,
    createExtraVendors,
    closePeriods,
    bankRuleIds,
    documentId,
    createVendorsAndCustomers,
    enterBill,
    enterInvoice,
    importStatement,
    replayMonth,
  };
}

export type WalkthroughReplay = ReturnType<typeof createWalkthroughReplay>;
