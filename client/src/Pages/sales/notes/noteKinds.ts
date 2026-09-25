import {
  applyCreditNote,
  applyDebitNote,
  createCreditNote,
  createDebitNote,
  deleteCreditNote,
  deleteDebitNote,
  getBill,
  getCreditNote,
  getDebitNote,
  getInvoice,
  issueCreditNote,
  issueDebitNote,
  listBills,
  listCreditNotes,
  listDebitNotes,
  listInvoices,
  updateCreditNote,
  updateDebitNote,
  voidCreditNote,
  voidDebitNote,
  type AccountType,
  type Bill,
  type CreditNote,
  type DebitNote,
  type Invoice,
  type NoteReasonCode,
  type NoteStatus,
} from '../../../services/fetchServices';

/**
 * Phase 26 — credit notes (AR) and debit notes (AP) share one set of pages.
 * Every difference between the two lives here, as a `NoteKindConfig`: which
 * API functions to call, what the original document is called, which
 * accounts a line may use. The pages only ever see the normalised
 * `NoteView` / `OriginalView` shapes below, so no page branches on the kind.
 */

export type NoteKind = 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface NoteLineView {
  id: string;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export interface NoteAllocationView {
  id: string;
  documentId: string;
  documentLabel: string;
  amountCents: number;
  allocationDate: string;
}

export interface NoteView {
  id: string;
  number: string | null;
  status: NoteStatus;
  partyId: string;
  partyName: string;
  originalId: string;
  originalLabel: string;
  issueDate: string;
  currencyCode: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  vendorCreditReference: string | null;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  lines: NoteLineView[];
  allocations: NoteAllocationView[];
  appliedCents: number;
  unappliedCents: number;
}

/** The invoice or bill a note corrects — or a candidate to apply leftover credit to. */
export interface OriginalView {
  id: string;
  label: string;
  /** True for an ISSUED invoice / POSTED bill — the only state a note can be raised against. */
  isOpen: boolean;
  partyId: string;
  partyName: string;
  date: string;
  currencyCode: string;
  totalCents: number;
  amountDueCents: number;
  /** Already credited (invoice) / debited (bill) by earlier notes. */
  adjustedCents: number;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; accountId: string; taxRateBp: number }[];
}

export interface NoteInputView {
  originalId: string;
  issueDate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  vendorCreditReference: string | null;
  notes: string | null;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; accountId: string; taxRateBp: number }[];
}

export interface NoteKindConfig {
  kind: NoteKind;
  title: string;
  plural: string;
  /** Route segment under the app base path. */
  path: string;
  /** Route segment of the original document. */
  originalPath: string;
  /** Query param the "new" page is reached with (`?invoiceId=` / `?billId=`). */
  originalParam: string;
  originalNoun: string;
  partyNoun: string;
  /** Account types a line may post to — mirrors the server's assert*Accounts. */
  lineAccountTypes: readonly AccountType[];
  lineAccountLabel: string;
  adjustedLabel: string;
  hasVendorCreditReference: boolean;
  notOpenMessage: string;
  listHint: string;
  postingHint: string;
  list: (params: { page: number; limit: number; status: NoteStatus | ''; originalId?: string }) => Promise<{
    notes: NoteView[];
    totalCount: number;
    totalPages: number;
  }>;
  get: (id: string) => Promise<NoteView>;
  create: (input: NoteInputView) => Promise<NoteView>;
  update: (id: string, input: NoteInputView) => Promise<NoteView>;
  remove: (id: string) => Promise<void>;
  issue: (id: string) => Promise<NoteView>;
  void: (id: string) => Promise<NoteView>;
  apply: (id: string, body: { targetId: string; amountCents: number; allocationDate: string }) => Promise<NoteView>;
  getOriginal: (id: string) => Promise<OriginalView>;
  /** The party's other open documents, for applying leftover credit. */
  listOpenTargets: (partyId: string) => Promise<OriginalView[]>;
}

function fromCreditNote(n: CreditNote): NoteView {
  return {
    id: n.id,
    number: n.creditNoteNumber,
    status: n.status,
    partyId: n.customerId,
    partyName: n.customerNameSnapshot,
    originalId: n.invoiceId,
    originalLabel: n.invoiceNumber ?? n.invoiceId.slice(0, 8),
    issueDate: n.issueDate,
    currencyCode: n.currencyCode,
    reasonCode: n.reasonCode,
    reason: n.reason,
    vendorCreditReference: null,
    notes: n.notes,
    subtotalCents: n.subtotalCents,
    taxCents: n.taxCents,
    totalCents: n.totalCents,
    journalEntryId: n.journalEntryId,
    voidJournalEntryId: n.voidJournalEntryId,
    lines: n.lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      accountId: l.revenueAccountId,
      accountCode: l.revenueAccountCode,
      accountName: l.revenueAccountName,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    allocations: n.allocations.map((a) => ({
      id: a.id,
      documentId: a.invoiceId,
      documentLabel: a.invoiceNumber ?? a.invoiceId.slice(0, 8),
      amountCents: a.amountCents,
      allocationDate: a.allocationDate,
    })),
    appliedCents: n.appliedCents,
    unappliedCents: n.unappliedCents,
  };
}

function fromDebitNote(n: DebitNote): NoteView {
  return {
    id: n.id,
    number: n.debitNoteNumber,
    status: n.status,
    partyId: n.vendorId,
    partyName: n.vendorNameSnapshot,
    originalId: n.billId,
    originalLabel: n.billVendorReference,
    issueDate: n.issueDate,
    currencyCode: n.currencyCode,
    reasonCode: n.reasonCode,
    reason: n.reason,
    vendorCreditReference: n.vendorCreditReference,
    notes: n.notes,
    subtotalCents: n.subtotalCents,
    taxCents: n.taxCents,
    totalCents: n.totalCents,
    journalEntryId: n.journalEntryId,
    voidJournalEntryId: n.voidJournalEntryId,
    lines: n.lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      accountId: l.expenseAccountId,
      accountCode: l.expenseAccountCode,
      accountName: l.expenseAccountName,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    allocations: n.allocations.map((a) => ({
      id: a.id,
      documentId: a.billId,
      documentLabel: a.billVendorReference,
      amountCents: a.amountCents,
      allocationDate: a.allocationDate,
    })),
    appliedCents: n.appliedCents,
    unappliedCents: n.unappliedCents,
  };
}

function fromInvoice(i: Invoice): OriginalView {
  return {
    id: i.id,
    label: i.invoiceNumber ?? 'Draft invoice',
    isOpen: i.status === 'ISSUED',
    partyId: i.customerId,
    partyName: i.customerNameSnapshot,
    date: i.issueDate,
    currencyCode: i.currencyCode,
    totalCents: i.totalCents,
    amountDueCents: i.amountDueCents,
    adjustedCents: i.creditedCents,
    lines: i.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      accountId: l.revenueAccountId,
      taxRateBp: l.taxRateBp,
    })),
  };
}

function fromBill(b: Bill): OriginalView {
  return {
    id: b.id,
    label: b.vendorReference,
    isOpen: b.status === 'POSTED',
    partyId: b.vendorId,
    partyName: b.vendorNameSnapshot,
    date: b.billDate,
    currencyCode: b.currencyCode,
    totalCents: b.totalCents,
    amountDueCents: b.amountDueCents,
    adjustedCents: b.debitedCents,
    lines: b.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      accountId: l.expenseAccountId,
      taxRateBp: l.taxRateBp,
    })),
  };
}

function creditInput(input: NoteInputView) {
  return {
    invoiceId: input.originalId,
    issueDate: input.issueDate,
    reasonCode: input.reasonCode,
    reason: input.reason,
    notes: input.notes,
    lines: input.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      revenueAccountId: l.accountId,
      taxRateBp: l.taxRateBp,
    })),
  };
}

function debitInput(input: NoteInputView) {
  return {
    billId: input.originalId,
    issueDate: input.issueDate,
    reasonCode: input.reasonCode,
    reason: input.reason,
    vendorCreditReference: input.vendorCreditReference,
    notes: input.notes,
    lines: input.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      expenseAccountId: l.accountId,
      taxRateBp: l.taxRateBp,
    })),
  };
}

export const CREDIT_NOTE_KIND: NoteKindConfig = {
  kind: 'CREDIT_NOTE',
  title: 'Credit note',
  plural: 'Credit notes',
  path: 'credit-notes',
  originalPath: 'invoices',
  originalParam: 'invoiceId',
  originalNoun: 'invoice',
  partyNoun: 'Customer',
  lineAccountTypes: ['Revenue'],
  lineAccountLabel: 'Revenue account',
  adjustedLabel: 'Credits applied',
  hasVendorCreditReference: false,
  notOpenMessage: 'Only an issued invoice can be credited.',
  listHint: 'Raise a credit note from an issued invoice (Invoices → open one → Create credit note).',
  postingHint:
    'Issuing posts DR the line accounts (usually 4800 Sales Returns & Allowances) and DR sales tax / CR Accounts Receivable, then applies the note to its invoice up to the amount still due.',
  async list({ page, limit, status, originalId }) {
    const res = await listCreditNotes({ page, limit, status, ...(originalId !== undefined ? { originalId } : {}) });
    return { notes: res.creditNotes.map(fromCreditNote), totalCount: res.totalCount, totalPages: res.totalPages };
  },
  async get(id) {
    return fromCreditNote((await getCreditNote(id)).creditNote);
  },
  async create(input) {
    return fromCreditNote((await createCreditNote(creditInput(input))).creditNote);
  },
  async update(id, input) {
    return fromCreditNote((await updateCreditNote(id, creditInput(input))).creditNote);
  },
  remove: deleteCreditNote,
  async issue(id) {
    return fromCreditNote((await issueCreditNote(id)).creditNote);
  },
  async void(id) {
    return fromCreditNote((await voidCreditNote(id)).creditNote);
  },
  async apply(id, body) {
    return fromCreditNote(
      (await applyCreditNote(id, { invoiceId: body.targetId, amountCents: body.amountCents, allocationDate: body.allocationDate }))
        .creditNote,
    );
  },
  async getOriginal(id) {
    return fromInvoice((await getInvoice(id)).invoice);
  },
  async listOpenTargets(partyId) {
    const res = await listInvoices({ customerId: partyId, settlement: 'OUTSTANDING', limit: 100 });
    return res.invoices.map(fromInvoice);
  },
};

export const DEBIT_NOTE_KIND: NoteKindConfig = {
  kind: 'DEBIT_NOTE',
  title: 'Debit note',
  plural: 'Debit notes',
  path: 'debit-notes',
  originalPath: 'expenses',
  originalParam: 'billId',
  originalNoun: 'expense',
  partyNoun: 'Vendor',
  lineAccountTypes: ['Expense', 'Asset'],
  lineAccountLabel: 'Expense account',
  adjustedLabel: 'Debits applied',
  hasVendorCreditReference: true,
  notOpenMessage: 'Only an approved expense can be debited.',
  listHint: 'Raise a debit note from an approved expense (Expenses → open one → Create debit note).',
  postingHint:
    'Issuing posts DR Accounts Payable / CR the line accounts and CR input tax, then applies the note to its expense up to the amount still owed.',
  async list({ page, limit, status, originalId }) {
    const res = await listDebitNotes({ page, limit, status, ...(originalId !== undefined ? { originalId } : {}) });
    return { notes: res.debitNotes.map(fromDebitNote), totalCount: res.totalCount, totalPages: res.totalPages };
  },
  async get(id) {
    return fromDebitNote((await getDebitNote(id)).debitNote);
  },
  async create(input) {
    return fromDebitNote((await createDebitNote(debitInput(input))).debitNote);
  },
  async update(id, input) {
    return fromDebitNote((await updateDebitNote(id, debitInput(input))).debitNote);
  },
  remove: deleteDebitNote,
  async issue(id) {
    return fromDebitNote((await issueDebitNote(id)).debitNote);
  },
  async void(id) {
    return fromDebitNote((await voidDebitNote(id)).debitNote);
  },
  async apply(id, body) {
    return fromDebitNote(
      (await applyDebitNote(id, { billId: body.targetId, amountCents: body.amountCents, allocationDate: body.allocationDate }))
        .debitNote,
    );
  },
  async getOriginal(id) {
    return fromBill((await getBill(id)).bill);
  },
  async listOpenTargets(partyId) {
    const res = await listBills({ vendorId: partyId, settlement: 'OUTSTANDING', limit: 100 });
    return res.bills.map(fromBill);
  },
};

export const REASON_LABELS: Record<NoteReasonCode, string> = {
  RETURN: 'Goods returned',
  PRICE_ADJUSTMENT: 'Price adjustment',
  DISCOUNT: 'Discount',
  DAMAGED: 'Damaged goods',
  OTHER: 'Other',
};
