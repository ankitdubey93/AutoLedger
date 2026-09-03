import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import LedgerCoreRoutes from '../Pages/ledger-core/LedgerCoreRoutes';

/**
 * The onboarding gate and wizard. Renders the real `LedgerCoreRoutes` tree —
 * not `OnboardingPage` in isolation — because what's under test is the
 * redirect behaviour: a fresh organization sees the wizard, not the chart of
 * accounts, and never the other way around.
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
  activity: { entryCountYtd: 0, recentEntries: [] },
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

describe('the onboarding gate', () => {
  it('shows the wizard, not the chart of accounts, when onboarding has not completed', async () => {
    mockRoutes({ settings: notOnboarded });
    renderLedgerCore();

    expect(await screen.findByText(/set up ledgercore/i)).toBeInTheDocument();
    expect(screen.queryByText('Chart of Accounts')).not.toBeInTheDocument();
  });

  it('shows the sidebar, not the wizard, once onboarding has completed', async () => {
    mockRoutes({ settings: onboarded });
    renderLedgerCore();

    expect(await screen.findByText('Chart of Accounts')).toBeInTheDocument();
    expect(screen.queryByText(/set up ledgercore/i)).not.toBeInTheDocument();
  });
});

describe('the wizard', () => {
  it('shows the derived fiscal-year end date for an April start', async () => {
    mockRoutes({ settings: notOnboarded });
    renderLedgerCore();
    const user = userEvent.setup();

    await screen.findByText(/set up ledgercore/i);
    await user.click(screen.getByRole('button', { name: /next/i }));

    await user.selectOptions(await screen.findByLabelText(/fiscal year starts in/i), 'April');

    expect(await screen.findByText('2027-03-31', { exact: false })).toBeInTheDocument();
  });

  it('submits the expected onboarding payload on Finish', async () => {
    mockRoutes({ settings: notOnboarded });
    renderLedgerCore();
    const user = userEvent.setup();

    await screen.findByText(/set up ledgercore/i);
    await user.click(screen.getByRole('button', { name: /next/i })); // step 1 -> 2
    await user.selectOptions(await screen.findByLabelText(/fiscal year starts in/i), 'April');
    await user.click(screen.getByRole('button', { name: /next/i })); // step 2 -> 3
    await user.click(await screen.findByRole('button', { name: /finish/i }));

    const onboardingCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const input = call[0] as RequestInfo | URL;
      return (typeof input === 'string' ? input : input.toString()).includes(
        '/ledger-core/settings/onboarding',
      );
    });
    expect(onboardingCall).toBeDefined();
    const init = onboardingCall?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body as string).toContain('"fiscalYearStartMonth":4');
  });

  it('clicking Finish twice in quick succession posts only once', async () => {
    mockRoutes({ settings: notOnboarded });
    renderLedgerCore();
    const user = userEvent.setup();

    await screen.findByText(/set up ledgercore/i);
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    const finishButton = await screen.findByRole('button', { name: /finish/i });

    await user.click(finishButton);
    await user.click(finishButton);

    const onboardingCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const input = call[0] as RequestInfo | URL;
      return (typeof input === 'string' ? input : input.toString()).includes(
        '/ledger-core/settings/onboarding',
      );
    });
    expect(onboardingCalls).toHaveLength(1);
  });
});
