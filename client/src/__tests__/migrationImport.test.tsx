import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MigrationImportDetailPage from '../Pages/accounting/MigrationImportDetailPage';
import InvoicesPage from '../Pages/sales/InvoicesPage';
import BillsPage from '../Pages/purchases/BillsPage';
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
    conversionMode: false,
    commitOptions: null,
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

  function journalRows(): MigrationImportRow[] {
    const mk = (id: string, n: number, key: string, number: string, acct: string) =>
      baseRow({
        id,
        rowNumber: n,
        accountCode: null,
        groupKey: key,
        raw: { journalNumber: number, date: '2026-06-30', narration: 'June accruals', accountCode: acct, debit: '10.00' },
      });
    return [
      mk('jr-1', 2, 'J-001', 'J-001', '6100'),
      mk('jr-2', 3, 'J-001', 'J-001', '2100'),
      mk('jr-3', 4, 'J-002', 'J-002', '6100'),
    ];
  }

  it('grouped rows render one header per journal with its line count', async () => {
    const imp = baseImport({ kind: 'JOURNALS', status: 'VALIDATED', rowCount: 3, validCount: 3 });
    mockRoutes(imp, journalRows(), { ...EMPTY_PREVIEW, kind: 'JOURNALS' });
    renderPage(imp.id);

    expect(await screen.findByRole('button', { name: /^Exclude group J-001/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Exclude group / })).toHaveLength(2);
    expect(screen.getByText(/— 2 lines/)).toBeInTheDocument();
    expect(screen.getByText(/— 1 line$/)).toBeInTheDocument();
  });

  it('Exclude group sends every row id of that journal with status EXCLUDED', async () => {
    const imp = baseImport({ kind: 'JOURNALS', status: 'VALIDATED', rowCount: 3, validCount: 3 });
    mockRoutes(imp, journalRows(), { ...EMPTY_PREVIEW, kind: 'JOURNALS' });
    const user = userEvent.setup();
    renderPage(imp.id);

    await user.click(await screen.findByRole('button', { name: /^Exclude group J-001/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/rows/status');
      });
      expect(call).toBeDefined();
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        rowIds: ['jr-1', 'jr-2'],
        status: 'EXCLUDED',
      });
    });
  });

  it('a committed journal import shows entry and line counts', async () => {
    const imp = baseImport({
      kind: 'JOURNALS',
      status: 'COMMITTED',
      committedAt: new Date().toISOString(),
      result: { kind: 'JOURNALS', entryCount: 2, lineCount: 5 },
    });
    mockRoutes(imp, journalRows(), { ...EMPTY_PREVIEW, kind: 'JOURNALS', canCommit: false });
    renderPage(imp.id);

    expect(await screen.findByText('Committed: 2 journal entries posted (5 lines).')).toBeInTheDocument();
  });

  const DOC_PREVIEW = {
    ...EMPTY_PREVIEW,
    kind: 'INVOICES',
    canCommit: true,
    summary: [{ label: 'Invoices', value: 3, format: 'count' }],
  };

  function commitCalls() {
    return fetchMock.mock.calls.filter((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/commit');
    });
  }

  function previewUrls(): string[] {
    return fetchMock.mock.calls
      .map((c) => {
        const input = (c as [RequestInfo | URL])[0];
        return typeof input === 'string' ? input : input.toString();
      })
      .filter((u) => u.includes('/preview'));
  }

  it('document imports offer draft or post, and posting sends mode and date', async () => {
    const imp = baseImport({ kind: 'INVOICES', status: 'VALIDATED' });
    mockRoutes(imp, [baseRow()], DOC_PREVIEW);
    const user = userEvent.setup();
    renderPage(imp.id);

    const how = await screen.findByRole('radiogroup', { name: 'How to import' });
    expect(screen.getByRole('radio', { name: 'Import as drafts' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Import and post' })).not.toBeChecked();
    expect(how).toHaveTextContent('Issues the invoices');
    expect(screen.queryByRole('radiogroup', { name: 'Posting date' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Import and post' }));
    expect(await screen.findByRole('radiogroup', { name: 'Posting date' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: "Each document's own date" })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /On this date/ }));
    const dateInput = screen.getByLabelText('Posting date', { selector: 'input[type="date"]' });
    await user.type(dateInput, '2026-03-31');

    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('This creates 3 posted document(s).');
    await user.click(screen.getByRole('dialog').querySelector('button:last-of-type') as HTMLElement);

    await waitFor(() => expect(commitCalls()).toHaveLength(1));
    const body = JSON.parse((commitCalls()[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ mode: 'POST', postingDate: '2026-03-31' });
  });

  it('changing the commit options re-fetches the preview with them', async () => {
    const imp = baseImport({ kind: 'BILLS', status: 'VALIDATED' });
    mockRoutes(imp, [baseRow()], { ...DOC_PREVIEW, kind: 'BILLS' });
    const user = userEvent.setup();
    renderPage(imp.id);

    await screen.findByRole('radiogroup', { name: 'How to import' });
    expect(screen.getByRole('radiogroup', { name: 'How to import' })).toHaveTextContent('Approves the expenses');
    await user.click(screen.getByRole('radio', { name: 'Import and post' }));

    await waitFor(() => expect(previewUrls().some((u) => u.includes('mode=POST'))).toBe(true));

    await user.click(screen.getByRole('radio', { name: /On this date/ }));
    await user.type(screen.getByLabelText('Posting date', { selector: 'input[type="date"]' }), '2026-04-30');

    await waitFor(() =>
      expect(previewUrls().some((u) => u.includes('mode=POST') && u.includes('postingDate=2026-04-30'))).toBe(true),
    );
  });

  it('a conversion-mode import shows the fixed posting note and commits with an empty body', async () => {
    const imp = baseImport({ kind: 'INVOICES', status: 'VALIDATED', conversionMode: true });
    mockRoutes(imp, [baseRow()], DOC_PREVIEW);
    const user = userEvent.setup();
    renderPage(imp.id);

    expect(
      await screen.findByText('Conversion mode — documents post on your conversion date to 3400 Opening Balance Equity.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'How to import' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('This creates 3 posted document(s).');
    await user.click(screen.getByRole('dialog').querySelector('button:last-of-type') as HTMLElement);

    await waitFor(() => expect(commitCalls()).toHaveLength(1));
    expect(JSON.parse((commitCalls()[0]?.[1] as RequestInit).body as string)).toEqual({});
  });

  it('a committed invoice import reports drafts or posted with counts', async () => {
    const drafts = baseImport({
      kind: 'INVOICES',
      status: 'COMMITTED',
      committedAt: new Date().toISOString(),
      result: { kind: 'INVOICES', documentCount: 3, lineCount: 7, mode: 'DRAFT' },
    });
    mockRoutes(drafts, [baseRow()], DOC_PREVIEW);
    const first = renderPage(drafts.id);
    expect(await screen.findByText('Committed: 3 invoices created as drafts (7 lines).')).toBeInTheDocument();
    first.unmount();

    const posted = baseImport({
      id: 'imp-2',
      kind: 'BILLS',
      status: 'COMMITTED',
      committedAt: new Date().toISOString(),
      result: { kind: 'BILLS', documentCount: 2, lineCount: 4, mode: 'POST' },
    });
    mockRoutes(posted, [baseRow()], { ...DOC_PREVIEW, kind: 'BILLS' });
    renderPage(posted.id);
    expect(await screen.findByText('Committed: 2 expenses posted (4 lines).')).toBeInTheDocument();
  });
});

describe('Import buttons on the document registers', () => {
  it('Invoices and Expenses pages link to their import wizards', async () => {
    const stub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/invoices')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, invoices: [] }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, bills: [] }),
      );
    });
    vi.stubGlobal('fetch', stub);

    const inv = render(
      <MemoryRouter initialEntries={['/invoices']}>
        <Routes>
          <Route path="/invoices" element={<InvoicesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const invLink = await screen.findByRole('link', { name: 'Import' });
    expect(invLink).toHaveAttribute('href', '/migration-imports/new?kind=INVOICES&returnTo=%2Finvoices');
    inv.unmount();

    render(
      <MemoryRouter initialEntries={['/expenses']}>
        <Routes>
          <Route path="/expenses" element={<BillsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const billLink = await screen.findByRole('link', { name: 'Import' });
    expect(billLink).toHaveAttribute('href', '/migration-imports/new?kind=BILLS&returnTo=%2Fexpenses');
  });
});
