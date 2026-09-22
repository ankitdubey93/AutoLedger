import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreditNotesPage from '../Pages/ledger-core/CreditNotesPage';
import NewCreditNotePage from '../Pages/ledger-core/NewCreditNotePage';
import CreditNoteDetailPage from '../Pages/ledger-core/CreditNoteDetailPage';
import type { Account, CreditNote, Invoice } from '../services/fetchServices';

/**
 * Phase 26 — the credit-note register, the draft form (reached from an
 * invoice), and the detail page's issue and apply-credit flows. The pages
 * talk to fetchServices directly, so `fetch` is the only thing mocked.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function account(id: string, code: string, name: string): Account {
  return {
    id,
    code,
    name,
    type: 'Revenue',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const account4100 = account('acc-4100', '4100', 'Product Revenue');
const account4800 = account('acc-4800', '4800', 'Sales Returns & Allowances');

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-15',
    invoiceNumber: 'INV-000015',
    status: 'ISSUED',
    customerId: 'cust-1',
    customerName: 'Brightline Analytics',
    issueDate: '2026-09-02',
    dueDate: '2026-09-02',
    currencyCode: 'USD',
    customerNameSnapshot: 'Brightline Analytics',
    customerAddressSnapshot: null,
    customerTaxNumberSnapshot: null,
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
    issuedAt: new Date().toISOString(),
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'l1',
        lineNumber: 1,
        description: 'Bracket kits',
        quantityMilli: 20000,
        unitPriceCents: 60000,
        revenueAccountId: account4100.id,
        revenueAccountCode: '4100',
        revenueAccountName: 'Product Revenue',
        taxRateBp: 0,
        netCents: 1200000,
        taxCents: 0,
        itemId: null,
      },
    ],
    allocatedCents: 0,
    creditedCents: 0,
    amountDueCents: 1200000,
    settlementStatus: 'UNPAID',
    ...overrides,
  };
}

function creditNote(overrides: Partial<CreditNote> = {}): CreditNote {
  return {
    id: 'cn-1',
    creditNoteNumber: null,
    status: 'DRAFT',
    customerId: 'cust-1',
    customerName: 'Brightline Analytics',
    invoiceId: 'inv-15',
    invoiceNumber: 'INV-000015',
    issueDate: '2026-09-03',
    currencyCode: 'USD',
    fxRate: '1.00000000',
    reasonCode: 'RETURN',
    reason: null,
    customerNameSnapshot: 'Brightline Analytics',
    customerAddressSnapshot: null,
    customerTaxNumberSnapshot: null,
    notes: null,
    subtotalCents: 180000,
    taxCents: 0,
    totalCents: 180000,
    baseSubtotalCents: 180000,
    baseTaxCents: 0,
    baseTotalCents: 180000,
    journalEntryId: null,
    voidJournalEntryId: null,
    issuedAt: null,
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'cl1',
        lineNumber: 1,
        description: '3 bracket kits returned',
        quantityMilli: 3000,
        unitPriceCents: 60000,
        revenueAccountId: account4800.id,
        revenueAccountCode: '4800',
        revenueAccountName: 'Sales Returns & Allowances',
        taxRateBp: 0,
        netCents: 180000,
        taxCents: 0,
      },
    ],
    allocations: [],
    appliedCents: 0,
    unappliedCents: 0,
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

function listResponse(creditNotes: CreditNote[]) {
  return jsonResponse(200, {
    success: true,
    count: creditNotes.length,
    totalCount: creditNotes.length,
    currentPage: 1,
    totalPages: 1,
    creditNotes,
  });
}

describe('CreditNotesPage', () => {
  it('renders the list with number, against-document and unapplied amount', async () => {
    const issued = creditNote({ id: 'cn-2', creditNoteNumber: 'CN-000002', status: 'ISSUED', unappliedCents: 50000, totalCents: 50000 });
    fetchMock.mockImplementation(() => Promise.resolve(listResponse([issued])));

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/credit-notes']}>
        <Routes>
          <Route path="/app/:appSlug/credit-notes" element={<CreditNotesPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const number = await screen.findByRole('link', { name: 'CN-000002' });
    expect(number).toHaveAttribute('href', '/app/ledger-core/credit-notes/cn-2');
    expect(screen.getByRole('link', { name: 'INV-000015' })).toHaveAttribute('href', '/app/ledger-core/invoices/inv-15');
    const row = number.closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getAllByText('500.00')).toHaveLength(2);
    expect(within(row).getByText('Goods returned')).toBeInTheDocument();
  });
});

describe('NewCreditNotePage', () => {
  it('pre-fills lines from the invoice and defaults the account to 4800', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/ledger-core/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 2, accounts: [account4100, account4800] }));
      }
      if (url.endsWith('/ledger-core/invoices/inv-15')) {
        return Promise.resolve(jsonResponse(200, { success: true, invoice: invoice() }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/credit-notes/new?invoiceId=inv-15']}>
        <Routes>
          <Route path="/app/:appSlug/credit-notes/new" element={<NewCreditNotePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('Line 1 description')).toHaveValue('Bracket kits');
    expect(screen.getByLabelText('Line 1 quantity')).toHaveValue('20');
    expect(screen.getByLabelText('Line 1 account')).toHaveValue('acc-4800');
    expect(screen.getByTestId('note-total')).toHaveTextContent('12000.00 USD');
  });

  it('refuses to draft against an invoice that is not issued', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/ledger-core/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account4800] }));
      }
      if (url.endsWith('/ledger-core/invoices/inv-15')) {
        return Promise.resolve(jsonResponse(200, { success: true, invoice: invoice({ status: 'DRAFT', invoiceNumber: null }) }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    render(
      <MemoryRouter initialEntries={['/app/ledger-core/credit-notes/new?invoiceId=inv-15']}>
        <Routes>
          <Route path="/app/:appSlug/credit-notes/new" element={<NewCreditNotePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Only an issued invoice can be credited.')).toBeInTheDocument();
  });
});

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/credit-notes/cn-1']}>
      <Routes>
        <Route path="/app/:appSlug/credit-notes/:noteId" element={<CreditNoteDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CreditNoteDetailPage', () => {
  it('issue confirms before posting and shows the number', async () => {
    const draft = creditNote();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.endsWith('/credit-notes/cn-1/issue')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            creditNote: creditNote({
              status: 'ISSUED',
              creditNoteNumber: 'CN-000001',
              journalEntryId: 'je-9',
              appliedCents: 180000,
              allocations: [
                { id: 'a1', invoiceId: 'inv-15', invoiceNumber: 'INV-000015', amountCents: 180000, baseAmountCents: 180000, allocationDate: '2026-09-03', createdAt: '' },
              ],
            }),
          }),
        );
      }
      if (url.endsWith('/credit-notes/cn-1')) return Promise.resolve(jsonResponse(200, { success: true, creditNote: draft }));
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));

    expect(await screen.findByRole('heading', { name: 'CN-000001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'je-9' })).toHaveAttribute('href', '/app/ledger-core/journals/je-9');
    expect(screen.getByText('Applied to')).toBeInTheDocument();
  });

  it('apply dialog defaults the amount to min(unapplied, due) and posts it', async () => {
    const issued = creditNote({ status: 'ISSUED', creditNoteNumber: 'CN-000002', totalCents: 50000, unappliedCents: 50000 });
    const target = invoice({ id: 'inv-16', invoiceNumber: 'INV-000016', totalCents: 620000, amountDueCents: 620000 });
    let appliedBody: unknown = null;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.endsWith('/credit-notes/cn-1/allocations')) {
        appliedBody = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(201, { success: true, creditNote: { ...issued, appliedCents: 50000, unappliedCents: 0 } }),
        );
      }
      if (url.includes('/ledger-core/invoices?')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, invoices: [target] }),
        );
      }
      if (url.endsWith('/credit-notes/cn-1')) return Promise.resolve(jsonResponse(200, { success: true, creditNote: issued }));
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Apply credit' }));
    const amount = await screen.findByLabelText('Amount to apply');
    expect(amount).toHaveValue('500.00');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByTestId('unapplied')).toHaveTextContent('0.00'));
    expect(appliedBody).toMatchObject({ invoiceId: 'inv-16', amountCents: 50000 });
  });
});
