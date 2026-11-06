import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BasDetailPage from '../Pages/bas/BasDetailPage';
import BasListPage from '../Pages/bas/BasListPage';
import { visibleNavGroups } from '../components/layout/nav';
import type { BasDetail } from '../services/fetchServices';

vi.mock('../context/AuthContext', async (original) => ({
  ...(await original<typeof import('../context/AuthContext')>()),
  useCan: () => () => true,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fixture(overrides: Partial<BasDetail> = {}): BasDetail {
  return {
    id: 'bas-1',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    basis: 'CASH',
    method: 'SIMPLER',
    cycle: 'QUARTERLY',
    status: 'DRAFT',
    dueDate: '2026-10-28',
    lodgedOn: null,
    atoReference: null,
    clearingJournalEntryId: null,
    w1Cents: 0,
    w2Cents: 0,
    instalmentCents: 0,
    labels: { G1: 123_456, '1A': 11_223, '1B': 4_099 },
    reportedLabels: ['G1', '1A', '1B'],
    summary: { gstOnSales: 112, gstOnPurchases: 40, paygWithheld: 0, paygInstalment: 0, netPayable: 72 },
    adjustments: [],
    warnings: [{ code: 'DEPOSITS_IN_PERIOD', message: 'A deposit carries no GST.' }],
    reconciliation: {
      sales: { glCents: 11_223, reportedCents: 11_223, unpaidMovementCents: 0, differenceCents: 0 },
      purchases: { glCents: 4_099, reportedCents: 4_099, unpaidMovementCents: 0, differenceCents: 0 },
    },
    paygSuggestion: { w1Cents: 0, w2Cents: 0 },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let bas: BasDetail;

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/bas/bas-1']}>
      <Routes>
        <Route path="/bas/:basId" element={<BasDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test/api/v1');
  bas = fixture();
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/accounts')) return Promise.resolve(jsonResponse(200, { success: true, accounts: [] }));
    if (url.includes('/events')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 1,
          events: [{ sourceKind: 'INVOICE', sourceId: 'i1', documentNumber: 'INV-7', partyName: 'Harbour Cafe', eventDate: '2026-08-01', taxCode: 'S_GST', taxLabel: 'GST on sales (10%)', netCents: 10_000, taxCents: 1_000, grossCents: 11_000, labels: ['G1', '1A'] }],
        }),
      );
    }
    if (url.includes('/finalise') && init?.method === 'POST') {
      bas = fixture({ status: 'FINALISED', warnings: [], reconciliation: null, paygSuggestion: null });
      return Promise.resolve(jsonResponse(200, { success: true, bas }));
    }
    return Promise.resolve(jsonResponse(200, { success: true, bas }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the BAS page', () => {
  it('shows whole dollars, the warning, and the not-lodged notice', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Transactions at G1' })).toHaveTextContent('$1,234');
    expect(screen.getByRole('button', { name: 'Transactions at 1A' })).toHaveTextContent('$112');
    expect(screen.getByText('A deposit carries no GST.')).toBeInTheDocument();
    expect(screen.getByText(/does not lodge it with the ATO/)).toBeInTheDocument();
    expect(screen.getByText('Payable to the ATO')).toBeInTheDocument();
  });

  it('drills into a label', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Transactions at G1' }));
    expect(await screen.findByText('INV-7')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/events?label=G1');
  });

  it('flags a return that does not reconcile', async () => {
    bas = fixture({
      reconciliation: {
        sales: { glCents: 12_000, reportedCents: 11_223, unpaidMovementCents: 0, differenceCents: 777 },
        purchases: { glCents: 0, reportedCents: 0, unpaidMovementCents: 0, differenceCents: 0 },
      },
    });
    renderDetail();
    expect(await screen.findByText(/doesn't match the GST accounts/)).toBeInTheDocument();
  });

  it('finalises through a confirmation, then offers to record lodgment', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Finalise' }));
    expect(await screen.findByText(/months in this period close/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Finalise' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Record lodgment' })).toBeInTheDocument());
  });

  it('a lodged return offers no way to change it', async () => {
    bas = fixture({ status: 'LODGED', lodgedOn: '2026-10-20', atoReference: 'REC1', warnings: [], reconciliation: null, paygSuggestion: null });
    renderDetail();
    expect(await screen.findByText(/receipt REC1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save PAYG' })).not.toBeInTheDocument();
  });
});

describe('the BAS list', () => {
  it('offers a period with no return', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { success: true, returns: [], suggested: [{ start: '2026-07-01', end: '2026-09-30', dueDate: '2026-10-28' }] })),
    );
    render(
      <MemoryRouter>
        <BasListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Start BAS' })).toBeInTheDocument();
  });
});

describe('navigation', () => {
  const allow = () => true;
  const labels = (region: string) => visibleNavGroups(allow, region).flatMap((g) => g.items).map((i) => i.label);

  it('shows BAS to an Australian organization only', () => {
    expect(labels('AU')).toContain('BAS');
    expect(labels('GENERIC')).not.toContain('BAS');
  });
});
