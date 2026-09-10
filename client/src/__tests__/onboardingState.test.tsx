import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import LedgerCoreRoutes from '../Pages/ledger-core/LedgerCoreRoutes';
import AppChooserPage from '../Pages/AppChooserPage';

/**
 * Phase 9a — the soft onboarding gate, Skip, and the suite-level checklist.
 * Mirrors ledgerCoreOnboarding.test.tsx's fixture shape.
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

const accountsResponse = { success: true, count: 0, accounts: [] };

const emptyDashboard = {
  success: true,
  asOf: '2026-01-15',
  fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  position: { assetsCents: 0, liabilitiesCents: 0, equityCents: 0, currentEarningsCents: 0, cashCents: null, equationHolds: true },
  performance: {
    yearToDate: { revenueCents: 0, expenseCents: 0, netIncomeCents: 0 },
    currentMonth: { revenueCents: 0, expenseCents: 0, netIncomeCents: 0 },
  },
  activity: { entryCountYtd: 0, recentEntries: [] },
  integrity: { totalDebitCents: 0, totalCreditCents: 0, isBalanced: true },
  trend: Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${String(i + 1)}`, revenueCents: 0, expenseCents: 0 })),
  receivables: { outstandingCents: 0, overdueCents: 0, draftCount: 0, draftCents: 0, buckets: [] },
  payables: {
    outstandingCents: 0,
    overdueCents: 0,
    draftCount: 0,
    draftCents: 0,
    awaitingReviewCount: 0,
    awaitingReviewCents: 0,
    buckets: [],
  },
};

function onboardingStateResponse(status: string) {
  return {
    success: true,
    onboarding: {
      appSlug: 'ledger-core',
      status,
      currentStep: null,
      draft: {},
      completedAt: status === 'COMPLETED' ? new Date().toISOString() : null,
      skippedAt: status === 'SKIPPED' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(options: { settings?: unknown; onboardingStatus?: string } = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session));
    if (url.includes('/ledger-core/settings/onboarding')) {
      return Promise.resolve(jsonResponse(200, onboarded));
    }
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, options.settings ?? notOnboarded));
    }
    if (url.includes('/onboarding/ledger-core/skip')) {
      return Promise.resolve(jsonResponse(200, onboardingStateResponse('SKIPPED')));
    }
    if (url.includes('/onboarding/ledger-core')) {
      return Promise.resolve(jsonResponse(200, onboardingStateResponse(options.onboardingStatus ?? 'NOT_STARTED')));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, accountsResponse));
    }
    if (url.includes('/ledger-core/reports/dashboard')) {
      return Promise.resolve(jsonResponse(200, emptyDashboard));
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

function renderLedgerCore() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core']}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/app/:appSlug/*" element={<LedgerCoreRoutes />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('the soft onboarding gate', () => {
  it('a skipped wizard leaves LedgerCore routes reachable behind a banner', async () => {
    mockRoutes({ settings: notOnboarded, onboardingStatus: 'SKIPPED' });
    renderLedgerCore();

    expect(await screen.findByText('Chart of Accounts')).toBeInTheDocument();
    expect(screen.getByText(/setup was skipped/i)).toBeInTheDocument();
  });

  it('a never-started wizard still redirects to onboarding', async () => {
    mockRoutes({ settings: notOnboarded, onboardingStatus: 'NOT_STARTED' });
    renderLedgerCore();

    expect(await screen.findByText(/set up ledgercore/i)).toBeInTheDocument();
    expect(screen.queryByText('Chart of Accounts')).not.toBeInTheDocument();
  });

  it('a completed wizard renders no banner', async () => {
    mockRoutes({ settings: onboarded });
    renderLedgerCore();

    expect(await screen.findByText('Chart of Accounts')).toBeInTheDocument();
    expect(screen.queryByText(/setup was skipped/i)).not.toBeInTheDocument();
  });
});

describe('Skip for now', () => {
  it('posts to the skip endpoint and returns to the dashboard', async () => {
    mockRoutes({ settings: notOnboarded, onboardingStatus: 'NOT_STARTED' });
    renderLedgerCore();
    const user = userEvent.setup();

    await screen.findByText(/set up ledgercore/i);
    await user.click(screen.getByRole('button', { name: /skip for now/i }));

    const skipCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const input = call[0] as RequestInfo | URL;
      return (typeof input === 'string' ? input : input.toString()).includes('/onboarding/ledger-core/skip');
    });
    expect(skipCall).toBeDefined();
    const init = skipCall?.[1] as RequestInit;
    expect(init.method).toBe('POST');
  });
});

describe('the suite checklist', () => {
  function renderChooser() {
    return render(
      <MemoryRouter>
        <AppChooserPage />
      </MemoryRouter>,
    );
  }

  it('lists only apps with a wizard', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/onboarding')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 8,
            items: [
              {
                appSlug: 'ledger-core',
                appName: 'LedgerCore',
                appStatus: 'building',
                status: 'NOT_STARTED',
                currentStep: null,
                draft: {},
                completedAt: null,
                skippedAt: null,
                updatedAt: null,
              },
              ...Array.from({ length: 7 }, (_, i) => ({
                appSlug: `planned-${String(i)}`,
                appName: `Planned ${String(i)}`,
                appStatus: 'planned',
                status: 'NOT_STARTED',
                currentStep: null,
                draft: {},
                completedAt: null,
                skippedAt: null,
                updatedAt: null,
              })),
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 1,
          apps: [
            { slug: 'ledger-core', name: 'LedgerCore', domain: 'x', tagline: 'y', skills: [], status: 'building' },
          ],
        }),
      );
    });

    renderChooser();

    const setupSection = await screen.findByText('Setup');
    expect(setupSection).toBeInTheDocument();

    const checklistItems = screen.getAllByText('Set up');
    expect(checklistItems).toHaveLength(1);
  });
});
