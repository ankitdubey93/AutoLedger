import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MigrationImportDetailPage from '../Pages/accounting/MigrationImportDetailPage';
import type { MigrationImport, MigrationImportRow } from '../services/fetchServices';
import { IMPORT_KINDS_FIXTURE } from './fixtures/importKinds';

/**
 * The staged migration importers' client pages (Phase 9b) — the new-import
 * form and the detail/preview/commit page.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function baseImport(overrides: Partial<MigrationImport> = {}): MigrationImport {
  return {
    id: 'imp-1',
    kind: 'OPENING_BALANCES',
    status: 'VALIDATED',
    fileName: 'trial-balance.csv',
    delimiter: ',',
    rowCount: 1,
    errorCount: 0,
    validCount: 1,
    excludedCount: 0,
    journalEntryId: null,
    committedAt: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    columnMap: null,
    result: null,
    dateFormat: 'ISO',
    ...overrides,
  };
}

function baseRow(overrides: Partial<MigrationImportRow> = {}): MigrationImportRow {
  return {
    id: 'row-1',
    rowNumber: 2,
    raw: {},
    values: {},
    groupKey: null,
    accountCode: '1110',
    accountName: null,
    accountType: null,
    parentCode: null,
    description: null,
    debitCents: 100000,
    creditCents: 0,
    partyName: null,
    partyEmail: null,
    partyPhone: null,
    partyAddress: null,
    partyTaxNumber: null,
    partyPaymentTerms: null,
    partyNotes: null,
    errors: [],
    status: 'VALID',
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

describe('MigrationImportDetailPage', () => {
  function mockRoutes(imp: MigrationImport, rows: MigrationImportRow[], preview: Record<string, unknown>) {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/migration-imports/kinds')) {
        return Promise.resolve(jsonResponse(200, { success: true, kinds: IMPORT_KINDS_FIXTURE }));
      }
      if (init?.method === 'POST' && url.includes('/commit')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            import: { ...imp, status: 'COMMITTED' },
            result: { kind: imp.kind, journalEntryId: 'entry-9', plugCents: 0 },
          }),
        );
      }
      if (url.includes('/preview')) {
        return Promise.resolve(jsonResponse(200, { success: true, preview: { summary: [], warnings: [], ...preview } }));
      }
      if (url.includes('/rows')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: rows.length, totalCount: rows.length, currentPage: 1, totalPages: 1, rows }));
      }
      if (url.endsWith(`/migration-imports/${imp.id}`)) {
        return Promise.resolve(jsonResponse(200, { success: true, import: imp }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  function renderPage(importId: string) {
    return render(
      <MemoryRouter initialEntries={[`/migration-imports/${importId}`]}>
        <Routes>
          <Route path="/migration-imports/:importId" element={<MigrationImportDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('renders each invalid row\'s error strings', async () => {
    const imp = baseImport({ status: 'DRAFT', errorCount: 1 });
    mockRoutes(
      imp,
      [baseRow({ status: 'INVALID', errors: ['account code is required'] })],
      { kind: 'OPENING_BALANCES', canCommit: false, blockingErrorCount: 1, accountsToCreate: 0, accountsToMerge: 0, totalDebitCents: 0, totalCreditCents: 0, plugCents: 0, plugAccountCode: '3400', entryDate: null },
    );
    renderPage(imp.id);

    expect(await screen.findByText('account code is required')).toBeInTheDocument();
  });

  it('disables Commit until the import is VALIDATED', async () => {
    const imp = baseImport({ status: 'DRAFT', errorCount: 2 });
    mockRoutes(imp, [baseRow()], {
      kind: 'OPENING_BALANCES',
      canCommit: false,
      blockingErrorCount: 2,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 0,
      totalCreditCents: 0,
      plugCents: 0,
      plugAccountCode: '3400',
      entryDate: null,
    });
    renderPage(imp.id);

    const button = await screen.findByRole('button', { name: 'Commit' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Fix 2 invalid rows first/)).toBeInTheDocument();
  });

  it('names the plug account and amount in the preview before commit', async () => {
    const imp = baseImport({ status: 'VALIDATED' });
    mockRoutes(imp, [baseRow()], {
      kind: 'OPENING_BALANCES',
      canCommit: true,
      blockingErrorCount: 0,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 300000,
      totalCreditCents: 0,
      plugCents: 300000,
      plugAccountCode: '3400',
      entryDate: '2026-01-01',
    });
    renderPage(imp.id);

    const preview = await screen.findByText(/will be posted to/);
    expect(preview.textContent).toContain('3400');
    expect(preview.textContent).toContain('3,000.00');
  });

  it('opens the confirm dialog before posting, and posts only after confirming', async () => {
    const imp = baseImport({ status: 'VALIDATED' });
    mockRoutes(imp, [baseRow()], {
      kind: 'OPENING_BALANCES',
      canCommit: true,
      blockingErrorCount: 0,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 0,
      totalCreditCents: 0,
      plugCents: 0,
      plugAccountCode: '3400',
      entryDate: '2026-01-01',
    });
    const user = userEvent.setup();
    renderPage(imp.id);

    await user.click(await screen.findByRole('button', { name: 'Commit' }));

    const commitCallsBefore = fetchMock.mock.calls.filter((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/commit');
    });
    expect(commitCallsBefore).toHaveLength(0);

    await user.click(screen.getByRole('dialog').querySelector('button:last-of-type') as HTMLElement);

    await waitFor(() => {
      const commitCalls = fetchMock.mock.calls.filter((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/commit');
      });
      expect(commitCalls).toHaveLength(1);
    });
  });

  it('renders read-only with a link to its journal entry once COMMITTED', async () => {
    const imp = baseImport({ status: 'COMMITTED', journalEntryId: 'entry-42', committedAt: new Date().toISOString() });
    mockRoutes(imp, [baseRow()], {
      kind: 'OPENING_BALANCES',
      canCommit: false,
      blockingErrorCount: 0,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 0,
      totalCreditCents: 0,
      plugCents: 0,
      plugAccountCode: '3400',
      entryDate: null,
    });
    renderPage(imp.id);

    await screen.findByText(imp.fileName);
    expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument();

    const link = await screen.findByRole('link', { name: 'journal entry' });
    expect(link).toHaveAttribute('href', expect.stringContaining('entry-42'));
  });

  it('the party preview reports created and merged counts', async () => {
    const imp = baseImport({ kind: 'CUSTOMERS', status: 'VALIDATED' });
    mockRoutes(
      imp,
      [baseRow({ accountCode: null, partyName: 'Northwind Traders', partyEmail: 'ap@northwind.test' })],
      {
        kind: 'CUSTOMERS',
        canCommit: true,
        blockingErrorCount: 0,
        accountsToCreate: 0,
        accountsToMerge: 0,
        totalDebitCents: 0,
        totalCreditCents: 0,
        plugCents: 0,
        plugAccountCode: '',
        entryDate: null,
        partiesToCreate: 2,
        partiesToMerge: 1,
      },
    );
    renderPage(imp.id);

    expect(await screen.findByText(/2 will be created, 1 will be merged into existing records/)).toBeInTheDocument();
  });

  it('the header names the kind, not "Opening balances", for a customer import', async () => {
    const imp = baseImport({ kind: 'CUSTOMERS', status: 'VALIDATED' });
    mockRoutes(imp, [baseRow({ accountCode: null, partyName: 'Northwind Traders' })], {
      kind: 'CUSTOMERS',
      canCommit: true,
      blockingErrorCount: 0,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 0,
      totalCreditCents: 0,
      plugCents: 0,
      plugAccountCode: '',
      entryDate: null,
      partiesToCreate: 1,
      partiesToMerge: 0,
    });
    renderPage(imp.id);

    const subtitle = await screen.findByText(/Customers · VALIDATED/);
    expect(subtitle.textContent).not.toContain('Opening balances');
  });

  it('a committed party import shows created and merged counts from result', async () => {
    const imp = baseImport({
      kind: 'CUSTOMERS',
      status: 'COMMITTED',
      committedAt: new Date().toISOString(),
      result: { kind: 'CUSTOMERS', createdCount: 3, mergedCount: 1 },
    });
    mockRoutes(imp, [baseRow({ accountCode: null, partyName: 'Northwind Traders' })], {
      kind: 'CUSTOMERS',
      canCommit: false,
      blockingErrorCount: 0,
      accountsToCreate: 0,
      accountsToMerge: 0,
      totalDebitCents: 0,
      totalCreditCents: 0,
      plugCents: 0,
      plugAccountCode: '',
      entryDate: null,
      partiesToCreate: 0,
      partiesToMerge: 0,
    });
    renderPage(imp.id);

    expect(await screen.findByText('Committed: 3 created, 1 merged.')).toBeInTheDocument();
  });

  const EMPTY_PREVIEW = {
    canCommit: true,
    blockingErrorCount: 0,
    accountsToCreate: 0,
    accountsToMerge: 0,
    totalDebitCents: 0,
    totalCreditCents: 0,
    plugCents: 0,
    plugAccountCode: '',
    entryDate: null,
    partiesToCreate: 0,
    partiesToMerge: 0,
  };

  it('a data-kind row edits raw text and saves values', async () => {
    const imp = baseImport({ kind: 'ITEMS', status: 'DRAFT', errorCount: 1 });
    mockRoutes(
      imp,
      [
        baseRow({
          accountCode: null,
          status: 'INVALID',
          errors: ['sale price is not a valid amount'],
          raw: { itemCode: 'A1', itemName: 'Widget', salePrice: 'abc' },
        }),
      ],
      { ...EMPTY_PREVIEW, kind: 'ITEMS', canCommit: false, blockingErrorCount: 1 },
    );
    const user = userEvent.setup();
    renderPage(imp.id);

    const input = await screen.findByLabelText('Sale price, row 2');
    expect((input as HTMLInputElement).value).toBe('abc');
    await user.clear(input);
    await user.type(input, '99.50');
    await user.click(screen.getByRole('button', { name: 'Save row 2' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(call).toBeDefined();
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        values: {
          itemCode: 'A1',
          itemName: 'Widget',
          itemType: null,
          description: null,
          salePrice: '99.50',
          salesAccount: null,
          salesTaxRate: null,
          purchasePrice: null,
          purchasesAccount: null,
          purchasesTaxRate: null,
        },
      });
    });
  });

  it('the Type column is a select of options', async () => {
    const imp = baseImport({ kind: 'ITEMS', status: 'VALIDATED' });
    mockRoutes(imp, [baseRow({ accountCode: null, raw: { itemCode: 'A1', itemName: 'Widget', itemType: 'Service' } })], {
      ...EMPTY_PREVIEW,
      kind: 'ITEMS',
    });
    renderPage(imp.id);

    const select = (await screen.findByLabelText('Type, row 2')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('Service');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Service', 'Non-inventory']);
  });

  it('the preview renders summary items with money formatting', async () => {
    const imp = baseImport({ kind: 'INVENTORY_ITEMS', status: 'VALIDATED' });
    mockRoutes(imp, [baseRow({ accountCode: null })], {
      ...EMPTY_PREVIEW,
      kind: 'INVENTORY_ITEMS',
      summary: [
        { label: 'Items to create', value: 3, format: 'count' },
        { label: 'Opening stock value', value: 123456, format: 'money' },
      ],
    });
    renderPage(imp.id);

    expect(await screen.findByText('Items to create')).toBeInTheDocument();
    expect(screen.getByText('Items to create').nextElementSibling).toHaveTextContent('3');
    expect(screen.getByText('Opening stock value')).toBeInTheDocument();
    expect(screen.getByText('1,234.56')).toBeInTheDocument();
  });

  it('a committed inventory import shows created and opening counts', async () => {
    const imp = baseImport({
      kind: 'INVENTORY_ITEMS',
      status: 'COMMITTED',
      committedAt: new Date().toISOString(),
      result: { kind: 'INVENTORY_ITEMS', createdCount: 4, openingStockCount: 2 },
    });
    mockRoutes(imp, [baseRow({ accountCode: null })], { ...EMPTY_PREVIEW, kind: 'INVENTORY_ITEMS', canCommit: false });
    renderPage(imp.id);

    expect(await screen.findByText('Committed: 4 items created, opening stock posted for 2.')).toBeInTheDocument();
  });
});
