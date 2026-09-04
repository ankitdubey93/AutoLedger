import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FiscalPeriodsPage from '../Pages/ledger-core/FiscalPeriodsPage';
import type { FiscalPeriod } from '../services/fetchServices';

/**
 * Fiscal periods (Phase 4). No AuthContext/OrgContext dependency and no
 * client-side role gating — the Phase 3.7 ruling — so every action renders
 * for every viewer and a 403 from the server renders inline.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function period(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: 'period-jan',
    fiscalYearLabel: 'FY 2026',
    periodNumber: 1,
    startsOn: '2026-01-01',
    endsOn: '2026-01-31',
    status: 'OPEN',
    closedBy: null,
    closedByName: null,
    closedAt: null,
    lockedBy: null,
    lockedByName: null,
    lockedAt: null,
    entryCount: 3,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockListRoute(periods: FiscalPeriod[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/fiscal-periods/generate') && method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, { success: true, fiscalYearLabel: 'FY 2026', created: true, count: 1, periods: [period()] }),
      );
    }
    if (url.match(/\/fiscal-periods\/[^/]+\/lock$/) && method === 'POST') {
      return Promise.resolve(jsonResponse(200, { success: true, period: period({ status: 'LOCKED' }) }));
    }
    if (url.match(/\/fiscal-periods\/[^/]+\/close$/) && method === 'POST') {
      return Promise.resolve(jsonResponse(403, { success: false, error: 'Forbidden' }));
    }
    if (url.includes('/ledger-core/fiscal-periods') && method === 'GET') {
      return Promise.resolve(jsonResponse(200, { success: true, count: periods.length, periods }));
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

describe('FiscalPeriodsPage', () => {
  it('renders the generate prompt when there are no periods, and generates on click', async () => {
    mockListRoute([]);
    const user = userEvent.setup();
    render(<FiscalPeriodsPage />);

    const button = await screen.findByRole('button', { name: 'Generate periods for this fiscal year' });
    await user.click(button);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/fiscal-periods/generate');
      });
      expect(call).toBeDefined();
    });
  });

  it('offers Close, and neither Reopen nor Lock, for an OPEN period', async () => {
    mockListRoute([period({ status: 'OPEN' })]);
    render(<FiscalPeriodsPage />);

    await screen.findByRole('button', { name: 'Close' });
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });

  it('offers Reopen and Lock for a CLOSED period', async () => {
    mockListRoute([period({ status: 'CLOSED', closedByName: 'Alice' })]);
    render(<FiscalPeriodsPage />);

    await screen.findByRole('button', { name: 'Reopen' });
    expect(screen.getByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('offers no action and shows the permanence label for a LOCKED period', async () => {
    mockListRoute([period({ status: 'LOCKED', lockedAt: new Date().toISOString() })]);
    render(<FiscalPeriodsPage />);

    await screen.findByText('Locked — permanent');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });

  it('opens the confirm dialog on Lock and calls the API only after confirming', async () => {
    mockListRoute([period({ status: 'CLOSED' })]);
    const user = userEvent.setup();
    render(<FiscalPeriodsPage />);

    await user.click(await screen.findByRole('button', { name: 'Lock' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/lock');
      }),
    ).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Lock period' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/lock');
      });
      expect(call).toBeDefined();
    });
  });

  it('does not call the API when the lock confirmation is dismissed', async () => {
    mockListRoute([period({ status: 'CLOSED' })]);
    const user = userEvent.setup();
    render(<FiscalPeriodsPage />);

    await user.click(await screen.findByRole('button', { name: 'Lock' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/lock');
      }),
    ).toBeUndefined();
  });

  it('renders a 403 from close inline and leaves the row status unchanged', async () => {
    mockListRoute([period({ status: 'OPEN' })]);
    const user = userEvent.setup();
    render(<FiscalPeriodsPage />);

    await user.click(await screen.findByRole('button', { name: 'Close' }));

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
