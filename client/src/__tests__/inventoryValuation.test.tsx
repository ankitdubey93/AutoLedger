import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import InventoryValuationPage from '../Pages/inventory/InventoryValuationPage';
import type { InventoryValuation, LinkAllResult } from '../services/fetchServices';

/**
 * Phase 35a — the inventory reconciliation report page. Reads `useAuth()` to
 * gate the three posting actions on role, so it renders under AuthProvider,
 * mirroring `InventoryMovementsPage`'s and `InventorySetupPage`'s tests.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionFor(role: 'OWNER' | 'VIEWER') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function tiedValuation(): InventoryValuation {
  return {
    asOf: null,
    accounts: [
      {
        accountId: 'acc-1140',
        code: '1140',
        name: 'Inventory',
        subledgerCents: 750000,
        glCents: 750000,
        differenceCents: 0,
        unexplainedLines: [],
      },
    ],
    totalSubledgerCents: 750000,
    totalGlCents: 750000,
    totalDifferenceCents: 0,
    misplaced: [],
    unlinkedItemCount: 0,
    unlinkedValueCents: 0,
    tiesOut: true,
  };
}

function differingValuation(): InventoryValuation {
  return {
    asOf: null,
    accounts: [
      {
        accountId: 'acc-1140',
        code: '1140',
        name: 'Inventory',
        subledgerCents: 750000,
        glCents: 800000,
        differenceCents: 50000,
        unexplainedLines: [
          {
            journalEntryId: 'je-1',
            entryDate: '2026-03-01',
            description: 'Manual adjustment',
            sourceType: 'manual',
            netDebitCents: 50000,
          },
        ],
      },
    ],
    totalSubledgerCents: 750000,
    totalGlCents: 800000,
    totalDifferenceCents: 50000,
    misplaced: [
      {
        stockItemId: 'stock-1',
        itemCode: 'RM-00001',
        itemName: 'Raw material',
        accountId: 'acc-1140',
        currentAccountId: 'acc-1135',
        valueCents: 12000,
      },
    ],
    unlinkedItemCount: 2,
    unlinkedValueCents: 3400,
    tiesOut: false,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let valuation: InventoryValuation;
let trueUpStatus: number;
let trueUpError: string;
let trueUpBody: Record<string, unknown> | null;
let reclassCalled: boolean;
let linkAllCalled: boolean;
let linkAllResult: LinkAllResult;

beforeEach(() => {
  valuation = tiedValuation();
  trueUpStatus = 201;
  trueUpError = '';
  trueUpBody = null;
  reclassCalled = false;
  linkAllCalled = false;
  linkAllResult = { linkedCount: 1, failures: [{ stockItemId: 'stock-2', code: 'RM-00002', message: 'code already exists' }] };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor('OWNER')));
    if (url.includes('/api/v1/inventory/valuation')) {
      return Promise.resolve(jsonResponse(200, { success: true, valuation }));
    }
    if (url.includes('/api/v1/inventory/reconcile/true-up')) {
      trueUpBody = init?.body !== undefined ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      if (trueUpStatus !== 201) {
        return Promise.resolve(jsonResponse(trueUpStatus, { success: false, error: trueUpError }));
      }
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          trueUp: { id: 'tu-1', accountId: 'acc-1140', glBeforeCents: 800000, subledgerCents: 750000, differenceCents: 50000, journalEntryId: 'je-2', occurredOn: '2026-06-01' },
        }),
      );
    }
    if (url.includes('/api/v1/inventory/reconcile/reclass')) {
      reclassCalled = true;
      return Promise.resolve(jsonResponse(200, { success: true, postingCount: 1 }));
    }
    if (url.includes('/api/v1/inventory/items/link-all')) {
      linkAllCalled = true;
      return Promise.resolve(jsonResponse(200, { success: true, result: linkAllResult }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function mockRoutesForRole(role: 'OWNER' | 'VIEWER') {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor(role)));
    if (url.includes('/api/v1/inventory/valuation')) {
      return Promise.resolve(jsonResponse(200, { success: true, valuation }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inventory/valuation']}>
      <AuthProvider>
        <Routes>
          <Route path="/inventory/valuation" element={<InventoryValuationPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('InventoryValuationPage', () => {
  it('shows the tied-out banner when every account matches', async () => {
    mockRoutes();
    renderPage();

    expect(await screen.findByText('Stock ties to the general ledger.')).toBeInTheDocument();
  });

  it('renders a difference row, and True up opens the dialog and posts accountId + expectedDifferenceCents', async () => {
    valuation = differingValuation();
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('1 account(s) differ from stock, or value sits on an old account.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1140 Inventory' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'True up' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'True up' }));

    await waitFor(() => expect(trueUpBody).not.toBeNull());
    expect(trueUpBody).toEqual({ accountId: 'acc-1140', expectedDifferenceCents: 50000 });
  });

  it('shows a 409 message from the true-up inline in the dialog', async () => {
    valuation = differingValuation();
    trueUpStatus = 409;
    trueUpError = 'The difference has changed — refresh the valuation and try again';
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('1 account(s) differ from stock, or value sits on an old account.');
    await user.click(screen.getByRole('button', { name: 'True up' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'True up' }));

    expect(await screen.findByText('The difference has changed — refresh the valuation and try again')).toBeInTheDocument();
  });

  it('Move to current accounts calls the reclass endpoint', async () => {
    valuation = differingValuation();
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Move to current accounts' }));

    await waitFor(() => expect(reclassCalled).toBe(true));
  });

  it('Link all lists a failure with its code and message', async () => {
    valuation = differingValuation();
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Link all' }));

    await waitFor(() => expect(linkAllCalled).toBe(true));
    expect(await screen.findByText(/RM-00002 — code already exists/)).toBeInTheDocument();
  });

  it('hides the posting buttons for a VIEWER', async () => {
    valuation = differingValuation();
    mockRoutesForRole('VIEWER');
    renderPage();

    await screen.findByText('1 account(s) differ from stock, or value sits on an old account.');
    expect(screen.queryByRole('button', { name: 'True up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to current accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link all' })).not.toBeInTheDocument();
  });
});
