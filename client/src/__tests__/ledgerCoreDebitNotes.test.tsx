import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DebitNotesPage from '../Pages/ledger-core/DebitNotesPage';
import NewDebitNotePage from '../Pages/ledger-core/NewDebitNotePage';
import DebitNoteDetailPage from '../Pages/ledger-core/DebitNoteDetailPage';
import type { Account, Bill, DebitNote } from '../services/fetchServices';

/**
 * Phase 26 — the purchase-side mirror of ledgerCoreCreditNotes.test.tsx:
 * the debit-note register, the draft form reached from an approved expense
 * (with the vendor's own credit-note number), and the detail page's issue
 * and apply-credit flows.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const account5100: Account = {
  id: 'acc-5100',
  code: '5100',
  name: 'Direct Materials',
  type: 'Expense',
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 'bill-12',
    vendorReference: 'INV-IC-9120',
    status: 'POSTED',
    vendorId: 'ven-1',
    vendorName: 'Ironclad Supply Co',
    billDate: '2026-09-04',
    dueDate: '2026-09-04',
    currencyCode: 'USD',
    vendorNameSnapshot: 'Ironclad Supply Co',
    vendorAddressSnapshot: null,
    vendorTaxNumberSnapshot: null,
    notes: null,
    paymentTerms: null,
    paymentTermsCode: null,
    subtotalCents: 1200000,
    taxCents: 0,
    totalCents: 1200000,
    fxRate: '1.00000000',
    baseSubtotalCents: 1200000,
    baseTaxCents: 0,
    baseTotalCents: 1200000,
    journalEntryId: 'je-1',
    voidJournalEntryId: null,
    submittedAt: null,
    postedAt: new Date().toISOString(),
    voidedAt: null,
    approvedBy: 'u1',
    approvedByName: 'Ada',
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'bl1',
        lineNumber: 1,
        description: 'Steel stock, 40mm',
        quantityMilli: 80000,
        unitPriceCents: 15000,
        expenseAccountId: account5100.id,
        expenseAccountCode: '5100',
        expenseAccountName: 'Direct Materials',
        taxRateBp: 0,
        netCents: 1200000,
        taxCents: 0,
        itemId: null,
      },
    ],
    allocatedCents: 0,
    debitedCents: 0,
    amountDueCents: 1200000,
    settlementStatus: 'UNPAID',
    ...overrides,
  };
}

function debitNote(overrides: Partial<DebitNote> = {}): DebitNote {
  return {
    id: 'dn-1',
    debitNoteNumber: 'DN-000001',
    status: 'ISSUED',
    vendorId: 'ven-1',
    vendorName: 'Ironclad Supply Co',
    billId: 'bill-12',
    billVendorReference: 'INV-IC-9120',
    vendorCreditReference: 'IC-CR-0231',
    issueDate: '2026-09-05',
    currencyCode: 'USD',
    fxRate: '1.00000000',
    reasonCode: 'RETURN',
    reason: null,
    vendorNameSnapshot: 'Ironclad Supply Co',
    vendorAddressSnapshot: null,
    vendorTaxNumberSnapshot: null,
    notes: null,
    subtotalCents: 150000,
    taxCents: 0,
    totalCents: 150000,
    baseSubtotalCents: 150000,
    baseTaxCents: 0,
    baseTotalCents: 150000,
    journalEntryId: 'je-5',
    voidJournalEntryId: null,
    issuedAt: new Date().toISOString(),
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'dl1',
        lineNumber: 1,
        description: '10 bars returned',
        quantityMilli: 10000,
        unitPriceCents: 15000,
        expenseAccountId: account5100.id,
        expenseAccountCode: '5100',
        expenseAccountName: 'Direct Materials',
        taxRateBp: 0,
        netCents: 150000,
        taxCents: 0,
      },
    ],
    allocations: [],
    appliedCents: 0,
    unappliedCents: 150000,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DebitNotesPage', () => {
  it('renders the list with number, against-expense and unapplied amount', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, debitNotes: [debitNote()] }),
      ),
    );

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/debit-notes']}>
        <Routes>
          <Route path="/app/:appSlug/debit-notes" element={<DebitNotesPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const number = await screen.findByRole('link', { name: 'DN-000001' });
    expect(screen.getByRole('link', { name: 'INV-IC-9120' })).toHaveAttribute('href', '/app/ledger-core/expenses/bill-12');
    const row = number.closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getAllByText('1500.00')).toHaveLength(2);
  });
});

describe('NewDebitNotePage', () => {
  it("pre-fills lines from the expense and asks for the vendor's credit note number", async () => {
    let created: unknown = null;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.endsWith('/ledger-core/debit-notes')) {
        created = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse(201, { success: true, debitNote: debitNote({ status: 'DRAFT', debitNoteNumber: null }) }));
      }
      if (url.includes('/ledger-core/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account5100] }));
      }
      if (url.endsWith('/ledger-core/bills/bill-12')) {
        return Promise.resolve(jsonResponse(200, { success: true, bill: bill() }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/debit-notes/new?billId=bill-12']}>
        <Routes>
          <Route path="/app/:appSlug/debit-notes/new" element={<NewDebitNotePage />} />
          <Route path="/app/:appSlug/debit-notes/:noteId" element={<p>detail page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('Line 1 description')).toHaveValue('Steel stock, 40mm');
    expect(screen.getByLabelText('Line 1 account')).toHaveValue('acc-5100');
    const quantity = screen.getByLabelText('Line 1 quantity');
    await user.clear(quantity);
    await user.type(quantity, '10');
    await user.type(screen.getByLabelText("Vendor's credit note no."), 'IC-CR-0231');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('detail page')).toBeInTheDocument();
    expect(created).toMatchObject({
      billId: 'bill-12',
      vendorCreditReference: 'IC-CR-0231',
      lines: [{ quantityMilli: 10000, unitPriceCents: 15000, expenseAccountId: 'acc-5100' }],
    });
  });
});

describe('DebitNoteDetailPage', () => {
  it('apply dialog defaults the amount to min(unapplied, due) and posts it', async () => {
    const note = debitNote();
    const target = bill({ id: 'bill-13', vendorReference: 'INV-IC-9200', totalCents: 100000, amountDueCents: 100000 });
    let appliedBody: unknown = null;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.endsWith('/debit-notes/dn-1/allocations')) {
        appliedBody = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse(201, { success: true, debitNote: { ...note, appliedCents: 100000, unappliedCents: 50000 } }));
      }
      if (url.includes('/ledger-core/bills?')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, bills: [target] }));
      }
      if (url.endsWith('/debit-notes/dn-1')) return Promise.resolve(jsonResponse(200, { success: true, debitNote: note }));
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/debit-notes/dn-1']}>
        <Routes>
          <Route path="/app/:appSlug/debit-notes/:noteId" element={<DebitNoteDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('IC-CR-0231')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    expect(await screen.findByLabelText('Amount to apply')).toHaveValue('1000.00');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByTestId('unapplied')).toHaveTextContent('500.00'));
    expect(appliedBody).toMatchObject({ billId: 'bill-13', amountCents: 100000 });
  });
});
