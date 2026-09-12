import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import BoardDeckCloseRunsPage from '../Pages/boarddeck/BoardDeckCloseRunsPage';
import type { BoardDeckCloseRunDetail } from '../services/fetchServices';

/**
 * BoardDeck close runs page (Phase 15). Reads `useAuth()` to gate the Close
 * period button on role, so it renders under AuthProvider + OrgProvider,
 * the minimal stack ledgerCoreBills.test.tsx's BillDetailPage uses.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(role: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function blockedCloseRun(): BoardDeckCloseRunDetail {
  return {
    id: 'run-1',
    fiscalPeriodId: 'period-1',
    status: 'BLOCKED',
    periodStartsOn: '2026-06-01',
    periodEndsOn: '2026-06-30',
    ranAt: new Date().toISOString(),
    ranByName: 'Ada',
    closedAt: null,
    closedByName: null,
    createdAt: new Date().toISOString(),
    checks: [
      { kind: 'PERIOD_OPEN', result: 'PASS', detail: '', observedCount: 0 },
      { kind: 'TRIAL_BALANCE_BALANCED', result: 'PASS', detail: '', observedCount: 0 },
      { kind: 'NO_DRAFT_INVOICES', result: 'FAIL', detail: '2 invoice(s) still in DRAFT', observedCount: 2 },
      { kind: 'NO_UNPOSTED_BILLS', result: 'PASS', detail: '', observedCount: 0 },
      { kind: 'NO_UNMATCHED_BANK_LINES', result: 'PASS', detail: '', observedCount: 0 },
    ],
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

function mockRoutes(role: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER', run: BoardDeckCloseRunDetail) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.includes('/ledger-core/fiscal-periods')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
    }
    if (url.endsWith('/boarddeck/close-runs')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, closeRuns: [run] }));
    }
    if (url.endsWith(`/boarddeck/close-runs/${run.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, closeRun: run }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <BoardDeckCloseRunsPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('BoardDeckCloseRunsPage', () => {
  it('a BLOCKED run renders each failing check with its detail text', async () => {
    const run = blockedCloseRun();
    mockRoutes('OWNER', run);
    renderPage();

    const user = userEvent.setup();
    const viewButton = await screen.findByRole('button', { name: 'View' });
    await user.click(viewButton);

    expect(await screen.findByText(/2 invoice\(s\) still in DRAFT/)).toBeInTheDocument();
  });

  it('the Close period button is absent for an ACCOUNTANT', async () => {
    const run = blockedCloseRun();
    mockRoutes('ACCOUNTANT', run);
    renderPage();

    const user = userEvent.setup();
    const viewButton = await screen.findByRole('button', { name: 'View' });
    await user.click(viewButton);

    await screen.findByRole('button', { name: 'Re-run checks' });
    expect(screen.queryByRole('button', { name: 'Close period' })).not.toBeInTheDocument();
  });

  it('the Close period button is disabled on a BLOCKED run for an OWNER', async () => {
    const run = blockedCloseRun();
    mockRoutes('OWNER', run);
    renderPage();

    const user = userEvent.setup();
    const viewButton = await screen.findByRole('button', { name: 'View' });
    await user.click(viewButton);

    const closeButton = await screen.findByRole('button', { name: 'Close period' });
    expect(closeButton).toBeDisabled();
  });
});
