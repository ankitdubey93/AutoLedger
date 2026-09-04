import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import DashboardPage from '../Pages/ledger-core/DashboardPage';
import type { DashboardSummary } from '../services/fetchServices';

/**
 * The LedgerCore dashboard. `DashboardPage` only depends on `OrgContext` (for
 * the organization name) and `fetchServices` directly — not
 * `LedgerSettingsContext` — so it renders under a lighter provider tree than
 * the onboarding gate needs. It does need a `MemoryRouter`, though: its
 * position tiles are now `<Link>`s (`MetricTile`), which read router context
 * that has no default value.
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

function baseDashboard(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    asOf: '2026-06-01',
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
    receivables: {
      outstandingCents: 0,
      overdueCents: 0,
      draftCount: 0,
      draftCents: 0,
      buckets: emptyBuckets(),
    },
    payables: {
      outstandingCents: 0,
      overdueCents: 0,
      draftCount: 0,
      draftCents: 0,
      awaitingReviewCount: 0,
      awaitingReviewCents: 0,
      buckets: emptyBuckets(),
    },
    ...overrides,
  };
}

function emptyBuckets(): DashboardSummary['receivables']['buckets'] {
  return [
    { bucket: 'CURRENT', label: 'Current', amountCents: 0, documentCount: 0 },
    { bucket: 'D1_30', label: '1–30 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D31_60', label: '31–60 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D61_90', label: '61–90 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D90_PLUS', label: '90+ days', amountCents: 0, documentCount: 0 },
  ];
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(dashboard: DashboardSummary) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session));
    if (url.includes('/ledger-core/reports/dashboard')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...dashboard }));
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

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core']}>
      <AuthProvider>
        <OrgProvider>
          <DashboardPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  it('formats a position tile in major units', async () => {
    mockRoutes(baseDashboard({ position: { ...baseDashboard().position, assetsCents: 100000 } }));
    renderDashboard();

    expect(await screen.findByText('1000.00')).toBeInTheDocument();
  });

  it('renders a placeholder and caption when no cash account is configured', async () => {
    mockRoutes(baseDashboard());
    renderDashboard();

    await screen.findByText(/this fiscal year/i);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/no cash account configured/i)).toBeInTheDocument();
  });

  it('shows an unbalanced warning when integrity.isBalanced is false', async () => {
    mockRoutes(
      baseDashboard({ integrity: { totalDebitCents: 500, totalCreditCents: 400, isBalanced: false } }),
    );
    renderDashboard();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/not balanced/i);
  });

  it('renders exactly 6 bar groups for a 6-point trend', async () => {
    mockRoutes(baseDashboard());
    const { container } = renderDashboard();

    await screen.findByText(/this fiscal year/i);
    // Two value bars (revenue + expense) per month, six months.
    // `[data-bar]` excludes the six transparent hover hit areas, which are
    // interaction surface, not data.
    expect(container.querySelectorAll('svg rect[data-bar]')).toHaveLength(12);
    expect(container.querySelectorAll('svg rect[data-hit]')).toHaveLength(6);
  });

  it('renders the AR/AP panels with formatted totals', async () => {
    mockRoutes(
      baseDashboard({
        receivables: {
          outstandingCents: 150000,
          overdueCents: 50000,
          draftCount: 0,
          draftCents: 0,
          buckets: emptyBuckets(),
        },
        payables: {
          outstandingCents: 60000,
          overdueCents: 10000,
          draftCount: 0,
          draftCents: 0,
          awaitingReviewCount: 2,
          awaitingReviewCents: 12000,
          buckets: emptyBuckets(),
        },
      }),
    );
    renderDashboard();

    await screen.findByText('Invoices owed to you');
    expect(screen.getByText('1500.00')).toBeInTheDocument();
    expect(screen.getByText('Bills you need to pay')).toBeInTheDocument();
    expect(screen.getByText('600.00')).toBeInTheDocument();
    expect(screen.getByText('To review')).toBeInTheDocument();
    expect(screen.getByText('120.00')).toBeInTheDocument();
  });

  it('the Overdue figure links into the invoices register filtered to overdue', async () => {
    mockRoutes(
      baseDashboard({
        receivables: {
          outstandingCents: 50000,
          overdueCents: 50000,
          draftCount: 0,
          draftCents: 0,
          buckets: emptyBuckets(),
        },
      }),
    );
    renderDashboard();

    await screen.findByText('Invoices owed to you');
    const overdueLink = screen.getAllByRole('link', { name: 'Overdue' })[0];
    expect(overdueLink).toHaveAttribute('href', expect.stringContaining('/invoices?status=ISSUED&settlement=OVERDUE'));
  });
});
