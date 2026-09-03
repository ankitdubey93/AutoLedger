import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import LedgerCoreRoutes from '../Pages/ledger-core/LedgerCoreRoutes';

/**
 * Regression coverage for the relative-navigation bug: sidebar links used to
 * append to the current URL instead of replacing the page, and the two
 * `<Navigate>` redirects in LedgerCoreRoutes could loop forever once a URL
 * missed every page route. See
 * study/react/routing-nested-and-dynamic-segments.md for the mechanism.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const session = {
  success: true,
  user: {
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    emailVerified: false,
    createdAt: new Date().toISOString(),
  },
  organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
  role: 'OWNER',
  memberships: [
    { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
  ],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

const baseSettings = {
  organizationName: 'Acme',
  legalName: null,
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

const notOnboarded = { success: true, settings: { ...baseSettings, onboardedAt: null } };
const onboarded = { success: true, settings: { ...baseSettings, onboardedAt: new Date().toISOString() } };

const accountsResponse = {
  success: true,
  count: 1,
  accounts: [
    {
      id: 'acc-1110',
      code: '1110',
      name: 'Operating Cash',
      type: 'Asset',
      parentId: null,
      isPostable: true,
      isActive: true,
      description: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: [],
    },
  ],
};

const emptyDashboard = {
  success: true,
  asOf: '2026-01-15',
  fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  position: {
    assetsCents: 0,
    liabilitiesCents: 0,
    equityCents: 0,
    currentEarningsCents: 0,
    cashCents: null,
    equationHolds: true,
  },
  performance: {
    yearToDate: { revenueCents: 0, expenseCents: 0, netIncomeCents: 0 },
    currentMonth: { revenueCents: 0, expenseCents: 0, netIncomeCents: 0 },
  },
  activity: {
    entryCountYtd: 1,
    recentEntries: [
      {
        id: 'je-1',
        entryDate: '2026-01-10',
        description: 'Opening balance',
        sourceType: 'manual',
        sourceId: null,
        reversesEntryId: null,
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        lines: [{ debitCents: 10_000 }, { debitCents: 0 }],
      },
    ],
  },
  integrity: { totalDebitCents: 0, totalCreditCents: 0, isBalanced: true },
  trend: Array.from({ length: 6 }, (_, i) => ({
    month: `2026-0${String(i + 1)}`,
    revenueCents: 0,
    expenseCents: 0,
  })),
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(overrides: { settings?: unknown; onboarding?: unknown } = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session));
    if (url.includes('/ledger-core/settings/onboarding')) {
      return Promise.resolve(jsonResponse(200, overrides.onboarding ?? onboarded));
    }
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, overrides.settings ?? notOnboarded));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, accountsResponse));
    }
    if (url.includes('/ledger-core/reports/dashboard')) {
      return Promise.resolve(jsonResponse(200, emptyDashboard));
    }
    if (url.includes('/ledger-core/journals')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 0,
          totalCount: 0,
          currentPage: 1,
          totalPages: 1,
          entries: [],
        }),
      );
    }
    if (url.includes('/ledger-core/reports/trial-balance')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          asOf: null,
          isBalanced: true,
          totalDebitCents: 0,
          totalCreditCents: 0,
          count: 0,
          rows: [],
        }),
      );
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

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function renderAt(initialPath: string, settings: unknown) {
  mockRoutes({ settings });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <OrgProvider>
          <LocationProbe />
          <Routes>
            <Route path="/app/:appSlug">
              <Route path="*" element={<LedgerCoreRoutes />} />
              <Route index element={<LedgerCoreRoutes />} />
            </Route>
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function pathname(): string {
  return screen.getByTestId('pathname').textContent ?? '';
}

describe('LedgerCore sidebar navigation', () => {
  it('clicking two sidebar links in a row lands on siblings, not on a nested path', async () => {
    renderAt('/app/ledger-core', onboarded);
    const user = userEvent.setup();

    await screen.findByText('Chart of Accounts');

    await user.click(screen.getByRole('link', { name: /chart of accounts/i }));
    expect(pathname()).toBe('/app/ledger-core/accounts');

    await user.click(screen.getByRole('link', { name: /journal entries/i }));
    expect(pathname()).toBe('/app/ledger-core/journals');

    await user.click(screen.getByRole('link', { name: /trial balance/i }));
    expect(pathname()).toBe('/app/ledger-core/trial-balance');

    await user.click(screen.getByRole('link', { name: /^dashboard$/i }));
    expect(pathname()).toBe('/app/ledger-core');
  });

  it('the sidebar marks exactly the page you are on as current', async () => {
    renderAt('/app/ledger-core', onboarded);
    const user = userEvent.setup();

    await screen.findByText('Chart of Accounts');
    await user.click(screen.getByRole('link', { name: /journal entries/i }));

    expect(screen.getByRole('link', { name: /journal entries/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /chart of accounts/i })).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByRole('link', { name: /^dashboard$/i })).not.toHaveAttribute('aria-current');
  });

  it('an unknown LedgerCore subpath returns to the dashboard without looping', async () => {
    renderAt('/app/ledger-core/nope/deeper', onboarded);

    // The sidebar renders as soon as AppPages mounts, before its internal
    // catch-all <Navigate> has settled — wait for the redirect itself, not
    // just for content that is present either way.
    await waitFor(() => expect(pathname()).toBe('/app/ledger-core'));
    expect(screen.getByText('Chart of Accounts')).toBeInTheDocument();
  });

  it('an un-onboarded organization landing on a deep subpath reaches the wizard without looping', async () => {
    renderAt('/app/ledger-core/accounts', notOnboarded);

    expect(await screen.findByText(/set up ledgercore/i)).toBeInTheDocument();
    expect(pathname()).toBe('/app/ledger-core/onboarding');
  });

  it('the reports index links to the trial balance at the app root', async () => {
    renderAt('/app/ledger-core', onboarded);
    const user = userEvent.setup();

    await screen.findByText('Chart of Accounts');
    await user.click(screen.getByRole('link', { name: /reports/i }));

    // The card's accessible name also swallows its description paragraph, and
    // the sidebar has its own "Trial Balance" link — the <h3> is what
    // uniquely identifies the report card.
    const trialBalanceHeading = await screen.findByRole('heading', {
      name: 'Trial balance',
      level: 3,
    });
    const trialBalanceLink = trialBalanceHeading.closest('a');
    expect(trialBalanceLink).not.toBeNull();
    expect(trialBalanceLink).toHaveAttribute('href', '/app/ledger-core/trial-balance');

    await user.click(trialBalanceLink!);
    expect(pathname()).toBe('/app/ledger-core/trial-balance');
  });

  it("the dashboard's recent-entry link points at the journals page", async () => {
    renderAt('/app/ledger-core', onboarded);

    const entryLink = await screen.findByRole('link', { name: '2026-01-10' });
    expect(entryLink).toHaveAttribute('href', '/app/ledger-core/journals');
  });
});
