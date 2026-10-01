import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewMigrationImportPage from '../Pages/accounting/NewMigrationImportPage';
import { mappingProblems } from '../Pages/accounting/imports/ColumnMapper';
import type { MigrationImportInspection } from '../services/fetchServices';
import { IMPORT_KINDS_FIXTURE } from './fixtures/importKinds';

/** The import wizard's Upload and Map-columns steps (Phase 36a). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function inspection(overrides: Partial<MigrationImportInspection> = {}): MigrationImportInspection {
  return {
    kind: 'CUSTOMERS',
    headers: ['*ContactName', 'EmailAddress'],
    delimiter: ',',
    rowCount: 1,
    sampleRows: [['Acme', 'a@x.test']],
    suggestedMap: { partyName: '*ContactName', partyEmail: 'EmailAddress' },
    missingRequired: [],
    exactMatch: true,
    suggestedDateFormat: null,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockApi(insp: MigrationImportInspection) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/migration-imports/kinds')) {
      return Promise.resolve(jsonResponse(200, { success: true, kinds: IMPORT_KINDS_FIXTURE }));
    }
    if (init?.method === 'POST' && url.endsWith('/migration-imports/inspect')) {
      return Promise.resolve(jsonResponse(200, { success: true, inspection: insp }));
    }
    if (init?.method === 'POST' && url.endsWith('/migration-imports')) {
      return Promise.resolve(jsonResponse(201, { success: true, import: { id: 'imp-new' }, rows: [] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/migration-imports/new" element={<NewMigrationImportPage />} />
        <Route path="/migration-imports/:importId" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const CUSTOMERS_URL = '/migration-imports/new?kind=CUSTOMERS&returnTo=%2Fcustomers';

async function uploadCsv(user: ReturnType<typeof userEvent.setup>, content: string) {
  const input = await screen.findByLabelText('CSV file');
  await user.upload(input, new File([content], 'customers.csv', { type: 'text/csv' }));
}

function postBody(urlSuffix: string): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find((c) => {
    const [input, init] = c as [RequestInfo | URL, RequestInit?];
    const url = typeof input === 'string' ? input : input.toString();
    return init?.method === 'POST' && url.endsWith(urlSuffix);
  });
  if (call === undefined) return undefined;
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewMigrationImportPage wizard', () => {
  it('locked kind from the URL shows the section title and hides the kind selector', async () => {
    mockApi(inspection());
    renderPage(CUSTOMERS_URL);

    expect(await screen.findByRole('heading', { name: 'Import customers' })).toBeInTheDocument();
    expect(screen.queryByLabelText('What are you importing?')).toBeNull();
    expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute('href', '/customers');
  });

  it('the template table marks required headers', async () => {
    mockApi(inspection());
    renderPage(CUSTOMERS_URL);

    const row = (await screen.findByText('*ContactName')).closest('tr');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Yes');
  });

  it('Download template builds the CSV from metadata', async () => {
    mockApi(inspection());
    const blobs: Blob[] = [];
    const createSpy = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    Object.defineProperty(URL, 'createObjectURL', { value: createSpy, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPage(CUSTOMERS_URL);

    await user.click(await screen.findByRole('button', { name: /Download template/ }));

    expect(createSpy).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsText(blobs[0] as Blob);
    });
    expect(text.split('\n')[0]).toBe('*ContactName,EmailAddress,Phone,BillingAddress,TaxNumber,Notes');
  });

  it('an exact-match file skips the mapper and stages without a column map', async () => {
    mockApi(inspection({ exactMatch: true }));
    const user = userEvent.setup();
    renderPage(CUSTOMERS_URL);

    await uploadCsv(user, '*ContactName,EmailAddress\nAcme,a@x.test');
    expect(await screen.findByText(/Every column matches/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stage import' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/migration-imports/imp-new?returnTo=%2Fcustomers'));
    expect(postBody('/migration-imports')).toMatchObject({ kind: 'CUSTOMERS', columnMap: null });
  });

  it('a mismatched file shows the mapper pre-filled from suggestions', async () => {
    mockApi(
      inspection({
        exactMatch: false,
        headers: ['Contact Name', 'Mail'],
        suggestedMap: { partyName: 'Contact Name', partyEmail: null },
      }),
    );
    const user = userEvent.setup();
    renderPage(CUSTOMERS_URL);

    await uploadCsv(user, 'Contact Name,Mail\nAcme,a@x.test');

    const select = (await screen.findByLabelText('Column for Name')) as HTMLSelectElement;
    expect(select.value).toBe('Contact Name');
  });

  it('a required field left unmapped blocks staging', async () => {
    mockApi(
      inspection({
        exactMatch: false,
        headers: ['Contact Name', 'Mail'],
        suggestedMap: { partyName: 'Contact Name', partyEmail: null },
      }),
    );
    const user = userEvent.setup();
    renderPage(CUSTOMERS_URL);

    await uploadCsv(user, 'Contact Name,Mail\nAcme,a@x.test');
    await user.selectOptions(await screen.findByLabelText('Column for Name'), "— Don't import —");

    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage import' })).toBeDisabled();
  });

  it('the chosen mapping is sent as columnMap', async () => {
    mockApi(
      inspection({
        exactMatch: false,
        headers: ['Contact Name', 'Mail'],
        suggestedMap: { partyName: 'Contact Name', partyEmail: null },
      }),
    );
    const user = userEvent.setup();
    renderPage(CUSTOMERS_URL);

    await uploadCsv(user, 'Contact Name,Mail\nAcme,a@x.test');
    await user.selectOptions(await screen.findByLabelText('Column for Email'), 'Mail');
    await user.click(screen.getByRole('button', { name: 'Stage import' }));

    await waitFor(() => expect(postBody('/migration-imports')).toBeDefined());
    const body = postBody('/migration-imports') as { columnMap: Record<string, string | null> };
    expect(body.columnMap.partyEmail).toBe('Mail');
    expect(body.columnMap.partyName).toBe('Contact Name');
  });

  it('mappingProblems asks for either debit and credit or an amount', () => {
    const opening = IMPORT_KINDS_FIXTURE.find((k) => k.kind === 'OPENING_BALANCES');
    expect(opening).toBeDefined();
    if (opening === undefined) return;

    const problems = mappingProblems(opening, { code: 'Code', name: null, debit: null, credit: null, amount: null });

    expect(problems).toContain('Map Debit and Credit, or Signed amount');
  });

  it("the guide panel is shown with the kind's first rule", async () => {
    mockApi(inspection());
    renderPage(CUSTOMERS_URL);

    const panel = await screen.findByRole('complementary', { name: 'How to import' });
    expect(within(panel).getByText(/matched by email/)).toBeInTheDocument();
  });

  it('a date-bearing kind shows the date-format select, preset from inspect', async () => {
    mockApi(
      inspection({
        kind: 'INVENTORY_ITEMS',
        headers: ['*ItemName'],
        sampleRows: [['Widget']],
        suggestedMap: { itemName: '*ItemName' },
        exactMatch: true,
        suggestedDateFormat: 'DMY',
      }),
    );
    const user = userEvent.setup();
    renderPage('/migration-imports/new?kind=INVENTORY_ITEMS&returnTo=%2Finventory%2Fitems');

    await uploadCsv(user, '*ItemName\nWidget');

    const select = (await screen.findByLabelText('Date format in your file')) as HTMLSelectElement;
    expect(select.value).toBe('DMY');

    await user.click(screen.getByRole('button', { name: 'Stage import' }));
    await waitFor(() => expect(postBody('/migration-imports')).toBeDefined());
    expect(postBody('/migration-imports')).toMatchObject({ kind: 'INVENTORY_ITEMS', dateFormat: 'DMY' });
  });

  it('an ambiguous date format must be chosen before staging', async () => {
    mockApi(
      inspection({
        kind: 'INVENTORY_ITEMS',
        headers: ['*ItemName'],
        sampleRows: [['Widget']],
        suggestedMap: { itemName: '*ItemName' },
        exactMatch: true,
        suggestedDateFormat: null,
      }),
    );
    const user = userEvent.setup();
    renderPage('/migration-imports/new?kind=INVENTORY_ITEMS&returnTo=%2Finventory%2Fitems');

    await uploadCsv(user, '*ItemName\nWidget');

    expect(await screen.findByText('Choose the date format your file uses')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage import' })).toBeDisabled();
  });

  it('the wizard shows the conversion-mode checkbox for invoices and sends it', async () => {
    mockApi(
      inspection({
        kind: 'INVOICES',
        headers: ['*ContactName', '*InvoiceDate', '*Description'],
        sampleRows: [['Northwind', '2026-01-05', 'Consulting']],
        suggestedMap: { contactName: '*ContactName', invoiceDate: '*InvoiceDate', description: '*Description' },
        exactMatch: true,
        suggestedDateFormat: 'ISO',
      }),
    );
    const user = userEvent.setup();
    renderPage('/migration-imports/new?kind=INVOICES&returnTo=%2Finvoices');

    await uploadCsv(user, '*ContactName,*InvoiceDate,*Description\nNorthwind,2026-01-05,Consulting');

    const checkbox = await screen.findByRole('checkbox', {
      name: 'These are open items from before my conversion date (conversion mode)',
    });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/They post to 3400 Opening Balance Equity on that date/)).toBeInTheDocument();

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Stage import' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/migration-imports/imp-new'));
    expect(postBody('/migration-imports')).toMatchObject({ kind: 'INVOICES', conversionMode: true });
  });
});
