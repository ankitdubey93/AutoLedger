import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttachmentsPanel from '../components/AttachmentsPanel';
import NewBillPage from '../Pages/purchases/NewBillPage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import type { Account, LedgerSettings, VaultDocument, Vendor } from '../services/fetchServices';

/**
 * Phase 43b — the vault picker (unattached by default, one attach call per
 * picked id) and a new expense sending the files uploaded while drafting.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const stamp = new Date().toISOString();

function doc(id: string, filename: string): VaultDocument {
  return {
    id,
    sha256: id.padEnd(64, 'a'),
    byteSize: 2048,
    mimeType: 'application/pdf',
    originalFilename: filename,
    uploadedBy: 'user-1',
    uploadedByName: 'Alice',
    createdAt: stamp,
    linkCount: 0,
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

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

describe('DocumentPickerDialog via AttachmentsPanel', () => {
  const unlinkedA = doc('doc-a', 'receipt-a.pdf');
  const unlinkedB = doc('doc-b', 'receipt-b.pdf');

  function mockVault() {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/api/v1/documents?')) {
        const unattached = url.includes('unattached=true');
        const docs = unattached ? [unlinkedA, unlinkedB] : [unlinkedA, unlinkedB, doc('doc-c', 'already-linked.pdf')];
        // The panel's own list is filtered by entityId; the picker's is not.
        const forPanel = url.includes('entityId=');
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: forPanel ? 0 : docs.length,
            totalCount: forPanel ? 0 : docs.length,
            currentPage: 1,
            totalPages: 1,
            documents: forPanel ? [] : docs,
          }),
        );
      }
      if (method === 'POST' && url.endsWith('/links')) {
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            link: {
              id: 'link-1',
              documentId: 'x',
              module: 'ledger-core',
              entityType: 'bill',
              entityId: 'bill-1',
              createdBy: 'u',
              createdAt: stamp,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  it('lists only unattached documents by default', async () => {
    mockVault();
    const user = userEvent.setup();
    render(<AttachmentsPanel module="ledger-core" entityType="bill" entityId="bill-1" />);
    await screen.findByText('No attachments yet.');

    await user.click(screen.getByRole('button', { name: 'Choose from Documents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose from Documents' });

    await within(dialog).findByText('receipt-a.pdf');
    expect(within(dialog).queryByText('already-linked.pdf')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Not yet attached')).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Attach' })).toBeDisabled();

    const pickerCall = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0] as RequestInfo | URL);
      return url.includes('/documents?') && !url.includes('entityId=');
    });
    expect(urlOf((pickerCall as [RequestInfo | URL])[0])).toContain('unattached=true');
  });

  it('attaching calls attachDocument for each picked id', async () => {
    mockVault();
    const user = userEvent.setup();
    render(<AttachmentsPanel module="ledger-core" entityType="bill" entityId="bill-1" />);
    await screen.findByText('No attachments yet.');

    await user.click(screen.getByRole('button', { name: 'Choose from Documents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose from Documents' });
    await user.click(await within(dialog).findByLabelText('receipt-a.pdf'));
    await user.click(within(dialog).getByLabelText('receipt-b.pdf'));
    await user.click(within(dialog).getByRole('button', { name: 'Attach' }));

    await waitFor(() => {
      const linkCalls = fetchMock.mock.calls.filter((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'POST' && urlOf(input).endsWith('/links');
      });
      expect(linkCalls.map((c) => urlOf((c as [RequestInfo | URL])[0])).sort()).toEqual([
        expect.stringContaining('/documents/doc-a/links'),
        expect.stringContaining('/documents/doc-b/links'),
      ]);
    });
  });
});

describe('a new expense', () => {
  it('sends attachmentDocumentIds from the files uploaded while drafting', async () => {
    const vendor: Vendor = {
      id: 'vend-a',
      name: 'Acme Supplies',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      paymentTerms: null,
      notes: null,
      defaultPaymentTermId: null,
      isActive: true,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const expense = {
      id: 'acc-6130',
      code: '6130',
      name: 'Office Supplies',
      type: 'Expense',
      isPostable: true,
    } as unknown as Account;
    const settings = {
      organizationName: 'Test Org',
      legalName: null,
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      fiscalYearStartDay: 1,
      booksStartDate: '2026-01-01',
      industry: null,
      timezone: 'UTC',
      cashAccountId: null,
      onboardedAt: stamp,
      currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
      baseCurrencyLocked: false,
      realizedFxGainAccountId: null,
      realizedFxLossAccountId: null,
      unrealizedFxAccountId: null,
      inventoryAccountId: null,
      cogsAccountId: null,
      inventoryAdjustmentAccountId: null,
      stockOpeningAccountId: null,
      defaultSalesPaymentTermId: null,
      defaultPurchasePaymentTermId: null,
    } satisfies LedgerSettings;
    const uploaded = doc('doc-up', 'scan.pdf');
    let createBody: Record<string, unknown> | null = null;

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/api/v1/documents')) {
        return Promise.resolve(jsonResponse(201, { success: true, created: true, document: uploaded }));
      }
      if (method === 'POST' && url.endsWith('/api/v1/bills')) {
        createBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Promise.resolve(jsonResponse(201, { success: true, bill: { id: 'bill-new' } }));
      }
      if (url.endsWith('/api/v1/settings')) return Promise.resolve(jsonResponse(200, { success: true, settings }));
      if (url.includes('/api/v1/vendors')) return Promise.resolve(jsonResponse(200, { success: true, count: 1, vendors: [vendor] }));
      if (url.includes('/api/v1/accounts')) return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [expense] }));
      if (url.includes('/api/v1/items')) return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
      if (url.includes('/api/v1/payment-terms')) return Promise.resolve(jsonResponse(200, { success: true, count: 0, paymentTerms: [] }));
      if (url.includes('/api/v1/purchase-orders')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, orders: [] }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/expenses/new']}>
        <LedgerSettingsProvider>
          <Routes>
            <Route path="/expenses/new" element={<NewBillPage />} />
            <Route path="/expenses/:id" element={<p>saved</p>} />
          </Routes>
        </LedgerSettingsProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Select a vendor…');
    await screen.findByRole('option', { name: 'Acme Supplies' });

    await user.selectOptions(screen.getByDisplayValue('Select a vendor…'), 'vend-a');
    await user.type(screen.getByPlaceholderText("The vendor's own invoice number"), 'INV-1');
    await user.type(screen.getByLabelText('Due date'), '2026-12-31');
    await user.type(screen.getByLabelText('Description for line 1'), 'Paper');
    await user.type(screen.getByLabelText('Quantity for line 1'), '1');
    await user.type(screen.getByLabelText('Unit price for line 1'), '10.00');
    await user.selectOptions(screen.getByLabelText('Account for line 1'), 'acc-6130');

    await user.upload(
      screen.getByLabelText('Upload files'),
      new File(['%PDF-1.7'], 'scan.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText('scan.pdf');

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({ attachmentDocumentIds: ['doc-up'], purchaseOrderId: null });
  });
});
