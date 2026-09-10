import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewMigrationImportPage from '../Pages/ledger-core/NewMigrationImportPage';
import MigrationImportDetailPage from '../Pages/ledger-core/MigrationImportDetailPage';
import type { MigrationImport, MigrationImportRow } from '../services/fetchServices';

/**
 * The staged migration importers' client pages (Phase 9b) — the new-import
 * form and the detail/preview/commit page.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeCsvFile(): File {
  const content = 'Code,Name,Type,Parent\n9100,Custom Root,Asset,';
  return new File([content], 'chart.csv', { type: 'text/csv' });
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
    ...overrides,
  };
}

function baseRow(overrides: Partial<MigrationImportRow> = {}): MigrationImportRow {
  return {
    id: 'row-1',
    rowNumber: 2,
    raw: {},
    accountCode: '1110',
    accountName: null,
    accountType: null,
    parentCode: null,
    description: null,
    debitCents: 100000,
    creditCents: 0,
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

describe('NewMigrationImportPage', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/app/ledger-core/migration-imports/new']}>
        <Routes>
          <Route path="/app/:appSlug/migration-imports/new" element={<NewMigrationImportPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('posts CSV text as a JSON string body, never FormData', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { success: true, import: baseImport({ id: 'imp-new' }), rows: [] }),
    );
    const user = userEvent.setup();
    renderPage();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makeCsvFile());
    await waitFor(() => expect(fileInput.files?.length).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Stage import' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'POST';
      });
      expect(call).toBeDefined();
      const init = call?.[1] as RequestInit;
      expect(init.body).not.toBeInstanceOf(FormData);
      const parsed = JSON.parse(init.body as string) as { content: string };
      expect(typeof parsed.content).toBe('string');
      expect(parsed.content).toContain('9100');
    });
  });
});

describe('MigrationImportDetailPage', () => {
  function mockRoutes(imp: MigrationImport, rows: MigrationImportRow[], preview: Record<string, unknown>) {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
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
        return Promise.resolve(jsonResponse(200, { success: true, preview }));
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
      <MemoryRouter initialEntries={[`/app/ledger-core/migration-imports/${importId}`]}>
        <Routes>
          <Route path="/app/:appSlug/migration-imports/:importId" element={<MigrationImportDetailPage />} />
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
    expect(preview.textContent).toContain('3000.00');
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
});
