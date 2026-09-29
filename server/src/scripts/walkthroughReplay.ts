import { WALKTHROUGH_DATASET, type DatasetDocument, type DatasetNote } from './walkthroughDataset.js';
import { resolveSettlementLines } from './walkthroughTiers.js';
import { statement1, statement2, statement3, statement4 } from './walkthroughStatements.js';
import { vendorsCsv, customersCsv } from './walkthroughParties.js';
import { resolveDate, type AnchorMonth, type WalkthroughMonth } from './walkthroughDates.js';
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

export function createWalkthroughReplay(api: ReplayClient, anchor: AnchorMonth) {
  const accountIdByCode = new Map<string, string>();
  const customerIdByKey = new Map<string, string>();
  const vendorIdByKey = new Map<string, string>();
  const documentIdByRef = new Map<string, string>();

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

  async function createInterestAccount(): Promise<void> {
    const parentId = await accountId('4000');
    const res = await api.post(ACCOUNTS, {
      code: '4300',
      name: 'Interest Income',
      type: 'Revenue',
      parentId,
      isPostable: true,
    });
    if (res.status !== 201) throw new Error(`walkthrough: could not create 4300: ${String(res.status)} ${res.text}`);
    accountIdByCode.set('4300', res.body.account.id as string);
  }

  /**
   * Imports the vendors and customers through the Phase 24 party importer —
   * the exact `vendors.csv`/`customers.csv` bytes that ship in `walkthrough/`,
   * staged then committed, never a direct `POST /vendors` or `POST /customers`
   * — replaying what `TUTORIAL.md`'s Step 1 instructs a person to click through.
   */
  async function importParties(kind: 'VENDORS' | 'CUSTOMERS', fileName: string, content: string, expected: number): Promise<void> {
    const staged = await api.post(MIGRATION_IMPORTS, { kind, fileName, content });
    if (staged.status !== 201) throw new Error(`walkthrough: ${kind} import stage failed ${String(staged.status)} ${staged.text}`);
    if (staged.body.import.status !== 'VALIDATED') {
      throw new Error(`walkthrough: ${kind} import did not validate: ${JSON.stringify(staged.body)}`);
    }
    const committed = await api.post(`${MIGRATION_IMPORTS}/${staged.body.import.id as string}/commit`);
    if (committed.status !== 200) throw new Error(`walkthrough: ${kind} import commit failed ${String(committed.status)} ${committed.text}`);
    if (committed.body.result.createdCount !== expected) {
      throw new Error(`walkthrough: ${kind} import created ${String(committed.body.result.createdCount)}, expected ${String(expected)}`);
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

  async function enterBill(doc: DatasetDocument): Promise<void> {
    const expenseAccountId = await accountId(doc.accountCode);
    const date = resolveDate(anchor, doc.month, doc.day);
    const created = await api.post(BILLS, {
      vendorId: vendorId(doc.counterpartyKey),
      vendorReference: doc.vendorReference,
      billDate: date,
      dueDate: date,
      lines: [{ description: doc.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(doc.total), expenseAccountId }],
    });
    if (created.status !== 201) throw new Error(`walkthrough: bill create failed ${doc.ref}: ${String(created.status)} ${created.text}`);
    const billId = created.body.bill.id as string;
    const submitted = await api.post(`${BILLS}/${billId}/submit`, {});
    if (submitted.status !== 200) throw new Error(`walkthrough: bill submit failed ${doc.ref}: ${String(submitted.status)} ${submitted.text}`);
    const approved = await api.post(`${BILLS}/${billId}/approve`, {});
    if (approved.status !== 200) throw new Error(`walkthrough: bill approve failed ${doc.ref}: ${String(approved.status)} ${approved.text}`);
    documentIdByRef.set(doc.ref, billId);
  }

  async function enterInvoice(doc: DatasetDocument): Promise<void> {
    const revenueAccountId = await accountId(doc.accountCode);
    const date = resolveDate(anchor, doc.month, doc.day);
    const created = await api.post(INVOICES, {
      customerId: customerId(doc.counterpartyKey),
      issueDate: date,
      dueDate: date,
      lines: [{ description: doc.lineDescription, quantityMilli: 1000, unitPriceCents: parseMoneyText(doc.total), revenueAccountId }],
    });
    if (created.status !== 201) throw new Error(`walkthrough: invoice create failed ${doc.ref}: ${String(created.status)} ${created.text}`);
    const invoiceId = created.body.invoice.id as string;
    const issued = await api.post(`${INVOICES}/${invoiceId}/issue`, {});
    if (issued.status !== 200) throw new Error(`walkthrough: invoice issue failed ${doc.ref}: ${String(issued.status)} ${issued.text}`);
    documentIdByRef.set(doc.ref, invoiceId);
  }

  async function importStatement(month: WalkthroughMonth): Promise<void> {
    const resolved = resolveSettlementLines(anchor);
    const cashAccountId = await accountId('1110');
    const body =
      month === 1
        ? { fileName: 'month-1.csv', content: statement1(anchor, resolved), dateFormat: 'ISO' as const, columnMap: null }
        : month === 2
          ? { fileName: 'month-2.csv', content: statement2(anchor, resolved), dateFormat: 'DMY' as const, columnMap: null }
          : month === 4
            ? { fileName: 'month-4.csv', content: statement4(anchor, resolved), dateFormat: 'ISO' as const, columnMap: null }
            : {
                fileName: 'month-3.csv',
                content: statement3(anchor, resolved),
                dateFormat: 'MDY' as const,
                columnMap: { date: 'Posted', description: 'Memo', amount: 'Net', debit: null, credit: null, reference: 'Check No' },
              };
    const res = await api.post(BANK_IMPORTS, { accountId: cashAccountId, ...body });
    if (res.status !== 201) throw new Error(`walkthrough: import failed month ${String(month)}: ${String(res.status)} ${res.text}`);
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

    for (const n of WALKTHROUGH_DATASET.noise.filter((x) => x.month === month)) {
      const amountCents = parseMoneyText(n.amount);
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

  /**
   * One month end to end: bills, invoices, then (month 4) the notes — issued
   * before the statement is imported, so the matcher scores against the
   * credited amounts due — then the statement import and its resolution.
   */
  async function replayMonth(month: WalkthroughMonth, hooks: ReplayHooks = {}): Promise<void> {
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

  return {
    accountId,
    customerId,
    vendorId,
    createInterestAccount,
    createVendorsAndCustomers,
    enterBill,
    enterInvoice,
    importStatement,
    replayMonth,
  };
}

export type WalkthroughReplay = ReturnType<typeof createWalkthroughReplay>;
