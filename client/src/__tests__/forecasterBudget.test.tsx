import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForecasterBudgetPage from '../Pages/forecaster/ForecasterBudgetPage';
import type { ForecasterBudgetVersion, ForecasterBudgetVersionDetail } from '../services/fetchServices';

/** ForecasterPro (Phase 13) — the budget versions page: source badges, approval confirmation, frozen editing. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function version(overrides: Partial<ForecasterBudgetVersion> = {}): ForecasterBudgetVersion {
  return {
    id: 'version-1',
    planId: 'plan-1',
    label: 'Q1 Budget',
    status: 'DRAFT',
    createdBy: 'user-1',
    createdByName: 'Alice',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    lineCount: 2,
    totalCents: 300_000,
    createdAt: new Date('2026-09-01').toISOString(),
    updatedAt: new Date('2026-09-01').toISOString(),
    ...overrides,
  };
}

function versionDetail(overrides: Partial<ForecasterBudgetVersionDetail> = {}): ForecasterBudgetVersionDetail {
  return {
    ...version(),
    lines: [
      {
        id: 'line-1',
        versionId: 'version-1',
        accountId: 'acc-1',
        accountCode: '6100',
        accountName: 'Salaries & Wages',
        month: '2026-10-01',
        amountCents: 200_000,
        source: 'HEADCOUNT',
        justification: 'Compiled from headcount role "Engineer" (1 FTE)',
        createdAt: new Date('2026-09-01').toISOString(),
        updatedAt: new Date('2026-09-01').toISOString(),
      },
      {
        id: 'line-2',
        versionId: 'version-1',
        accountId: 'acc-2',
        accountCode: '6120',
        accountName: 'Software & IT Infrastructure',
        month: '2026-10-01',
        amountCents: 100_000,
        source: 'MANUAL',
        justification: 'Signed vendor contract',
        createdAt: new Date('2026-09-01').toISOString(),
        updatedAt: new Date('2026-09-01').toISOString(),
      },
    ],
    ...overrides,
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

function mockBudgetRoutes(versions: ForecasterBudgetVersion[], detail: ForecasterBudgetVersionDetail) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
    }
    if (method === 'POST' && url.includes('/approve')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, version: { ...detail, status: 'APPROVED' } }),
      );
    }
    if (method === 'GET' && url.includes('/budget-versions') && !url.includes('plan-1/budget-versions')) {
      return Promise.resolve(jsonResponse(200, { success: true, version: detail }));
    }
    if (method === 'GET' && url.includes('plan-1/budget-versions')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, versions, count: versions.length }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderBudgetPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecaster/plans/plan-1/budget']}>
      <Routes>
        <Route path="/app/:appSlug/plans/:planId/budget" element={<ForecasterBudgetPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForecasterBudgetPage', () => {
  it('1. shows the source badge on every line', async () => {
    mockBudgetRoutes([version()], versionDetail());
    renderBudgetPage();

    await screen.findByText('HEADCOUNT');
    expect(screen.getByText('MANUAL')).toBeInTheDocument();
  });

  it('2. asks for confirmation before approving a version', async () => {
    mockBudgetRoutes([version()], versionDetail());
    const user = userEvent.setup();
    renderBudgetPage();

    await screen.findByText('HEADCOUNT');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      fetchMock.mock.calls.some((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/approve');
      }),
    ).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => {
          const [input, init] = c as [RequestInfo | URL, RequestInit?];
          const url = typeof input === 'string' ? input : input.toString();
          return init?.method === 'POST' && url.includes('/approve');
        }),
      ).toBe(true);
    });
  });

  it('3. hides the edit controls on an APPROVED version', async () => {
    mockBudgetRoutes(
      [version({ status: 'APPROVED', approvedByName: 'Bob' })],
      versionDetail({ status: 'APPROVED', approvedByName: 'Bob' }),
    );
    renderBudgetPage();

    await screen.findByText('HEADCOUNT');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compile from forecast' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add manual line' })).not.toBeInTheDocument();
  });
});
