import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StatementsListPage from '../Pages/statements/StatementsListPage';
import StatementPage from '../Pages/statements/StatementPage';
import StatementDocument from '../Pages/statements/StatementDocument';
import { sampleStatement } from '../Pages/statements/sampleStatement';
import type { StatementListRow, StatementSettings } from '../services/fetchServices';

/**
 * Customer & vendor statements (Phase 39a): the list page, a single
 * statement, and the presentational document. Data comes from stubbed fetch;
 * OrgContext is mocked to a fixed organization.
 */

vi.mock('../context/AuthContext', () => ({ useCan: () => () => true }));

vi.mock('../context/OrgContext', () => ({
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme Ltd', slug: 'acme', baseCurrency: 'USD' } }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(routes: Record<string, { status: number; body: unknown }>) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [fragment, response] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(jsonResponse(response.status, response.body));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROWS: StatementListRow[] = [
  {
    partyId: 'c1',
    name: 'Northwind Traders',
    email: 'ap@northwind.test',
    isActive: true,
    outstandingCents: 1100000,
    overdueCents: 800000,
    lastSentAt: null,
  },
  {
    partyId: 'c2',
    name: 'Contoso',
    email: null,
    isActive: true,
    outstandingCents: 50000,
    overdueCents: 0,
    lastSentAt: '2026-09-01T10:00:00Z',
  },
];

const SETTINGS: StatementSettings = {
  templateId: 'classic',
  documentTitle: 'STATEMENT',
  defaultType: 'OUTSTANDING',
  showLogo: true,
  showOrgAddress: true,
  showAgingSummary: true,
  showRemittance: true,
  footerNotes: 'Thank you for your business.',
  accentColor: '#2563eb',
  configured: true,
};

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

describe('StatementsListPage', () => {
  it('lists outstanding and overdue per customer with totals, as of the URL date', async () => {
    mockRoutes({ '/api/v1/statements/customers': { status: 200, body: { success: true, asOf: '2026-07-10', count: 2, parties: ROWS } } });
    render(
      <MemoryRouter initialEntries={['/statements/customers?asOf=2026-07-10']}>
        <Routes>
          <Route path="/statements/customers" element={<StatementsListPage kind="CUSTOMER" />} />
        </Routes>
      </MemoryRouter>,
    );

    const row = (await screen.findByText('Northwind Traders')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('11,000.00')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('8,000.00')).toBeInTheDocument();
    expect(screen.getByText('No email')).toBeInTheDocument();
    expect(screen.getByText('11,500.00')).toBeInTheDocument(); // total outstanding

    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('asOf=2026-07-10');
    expect(screen.getByRole('link', { name: 'Northwind Traders' })).toHaveAttribute(
      'href',
      '/statements/customers/c1?type=OUTSTANDING&asOf=2026-07-10',
    );
  });

  it('switching to Activity asks for balances at the range end; Print opens the batch for the selection', async () => {
    const user = userEvent.setup();
    mockRoutes({ '/api/v1/statements/customers': { status: 200, body: { success: true, asOf: '2026-07-10', count: 2, parties: ROWS } } });
    render(
      <MemoryRouter initialEntries={['/statements/customers?type=ACTIVITY&from=2026-06-01&to=2026-06-30']}>
        <Routes>
          <Route path="/statements/customers" element={<StatementsListPage kind="CUSTOMER" />} />
          <Route path="/statements/customers/print" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Northwind Traders');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('asOf=2026-06-30');

    const print = screen.getByRole('button', { name: /Print/ });
    expect(print).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Northwind Traders' }));
    await user.click(screen.getByRole('button', { name: /Print \(1\)/ }));
    expect(screen.getByTestId('location').textContent).toBe(
      '/statements/customers/print?type=ACTIVITY&from=2026-06-01&to=2026-06-30&ids=c1',
    );
  });
});

describe('StatementPage', () => {
  it('renders the statement document with the org branding and a Print button', async () => {
    mockRoutes({
      '/api/v1/statements/customers/c1/sends': { status: 200, body: { success: true, count: 0, sends: [] } },
      '/api/v1/statements/customers/c1': {
        status: 200,
        body: { success: true, statement: sampleStatement('OUTSTANDING') },
      },
      '/api/v1/settings/statements': { status: 200, body: { success: true, statementSettings: SETTINGS } },
      '/api/v1/settings/invoicing': {
        status: 200,
        body: { success: true, invoiceSettings: { bankDetails: 'BSB 000-000 Acc 1234' } },
      },
      '/api/v1/organizations/profile': { status: 500, body: { success: false, error: 'down' } },
    });
    render(
      <MemoryRouter initialEntries={['/statements/customers/c1?type=OUTSTANDING&asOf=2026-09-30']}>
        <Routes>
          <Route path="/statements/customers/:partyId" element={<StatementPage kind="CUSTOMER" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('INV-000102')).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('BSB 000-000 Acc 1234')).toBeInTheDocument();
    expect(screen.getByText('Thank you for your business.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print/ })).toBeEnabled();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/statements/customers/c1?type=OUTSTANDING&asOf=2026-09-30')),
    ).toBe(true);
  });

  it('a 404 shows "Customer not found."', async () => {
    mockRoutes({
      '/api/v1/statements/customers/nope': { status: 404, body: { success: false, error: 'Customer not found' } },
      '/api/v1/settings/statements': { status: 200, body: { success: true, statementSettings: SETTINGS } },
    });
    render(
      <MemoryRouter initialEntries={['/statements/customers/nope']}>
        <Routes>
          <Route path="/statements/customers/:partyId" element={<StatementPage kind="CUSTOMER" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Customer not found.')).toBeInTheDocument();
  });
});

describe('StatementDocument', () => {
  const common = {
    settings: SETTINGS,
    organizationName: 'Acme Ltd',
    orgAddressLines: ['1 Main St'],
    baseCurrency: 'USD',
    logoSrc: null,
    bankDetails: null,
  };

  it('activity: opening balance, every row with its running balance, closing balance due', () => {
    render(<StatementDocument statement={sampleStatement('ACTIVITY')} {...common} />);
    expect(screen.getByText('Opening balance')).toBeInTheDocument();
    expect(screen.getByText('Payment RCPT-2209 — INV-000098, INV-000102')).toBeInTheDocument();
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('3,300.00 USD')).toHaveLength(1);
    expect(screen.getByText('1–30 days')).toBeInTheDocument();
  });

  it('outstanding: overdue items flagged; aging hidden when the template turns it off', () => {
    render(
      <StatementDocument statement={sampleStatement('OUTSTANDING')} {...common} settings={{ ...SETTINGS, showAgingSummary: false }} />,
    );
    expect(screen.getByText('(13d overdue)')).toBeInTheDocument();
    expect(screen.queryByText('1–30 days')).not.toBeInTheDocument();
    expect(screen.getByText('As at', { exact: false })).toBeInTheDocument();
  });

  it('vendor statements orient columns so bills raise the balance', () => {
    const statement = sampleStatement('ACTIVITY');
    render(
      <StatementDocument statement={{ ...statement, party: { ...statement.party, kind: 'VENDOR' } }} {...common} />,
    );
    expect(screen.getByText('Billed')).toBeInTheDocument();
    expect(screen.getByText('Balance owed')).toBeInTheDocument();
  });
});
