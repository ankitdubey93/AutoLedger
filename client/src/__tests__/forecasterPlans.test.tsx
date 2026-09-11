import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForecasterPlansPage from '../Pages/forecaster/ForecasterPlansPage';
import NewForecasterPlanPage from '../Pages/forecaster/NewForecasterPlanPage';
import ForecasterPlanDetailPage from '../Pages/forecaster/ForecasterPlanDetailPage';
import type { ForecasterPlan } from '../services/fetchServices';

/** ForecasterPro (Phase 13) — the plans list, create form, and roll-forward confirmation. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function plan(overrides: Partial<ForecasterPlan> = {}): ForecasterPlan {
  return {
    id: 'plan-1',
    name: 'FY27 Plan',
    description: null,
    startsOn: '2026-10-01',
    horizonMonths: 12,
    actualsThrough: '2026-09-01',
    status: 'DRAFT',
    createdBy: 'user-1',
    createdByName: 'Alice',
    createdAt: new Date('2026-09-01').toISOString(),
    updatedAt: new Date('2026-09-01').toISOString(),
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

function mockPlansListRoute(plans: ForecasterPlan[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/forecaster/plans')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          plans,
          count: plans.length,
          totalCount: plans.length,
          currentPage: 1,
          totalPages: 1,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPlansPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecaster']}>
      <Routes>
        <Route path="/app/:appSlug" element={<ForecasterPlansPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForecasterPlansPage', () => {
  it('1. renders the plan list from the API', async () => {
    mockPlansListRoute([plan({ id: 'p1', name: 'FY27 Plan' }), plan({ id: 'p2', name: 'FY28 Draft' })]);
    renderPlansPage();

    await screen.findByText('FY27 Plan');
    expect(screen.getByText('FY28 Draft')).toBeInTheDocument();
  });

  it('2. shows an empty state when there are no plans', async () => {
    mockPlansListRoute([]);
    renderPlansPage();

    await screen.findByText('No plans yet.');
    expect(screen.getByRole('link', { name: 'Build the first plan' })).toBeInTheDocument();
  });
});

function renderNewPlanPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecaster/new']}>
      <Routes>
        <Route path="/app/:appSlug/new" element={<NewForecasterPlanPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewForecasterPlanPage', () => {
  it('3. submits a new plan with first-of-month dates', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/forecaster/plans')) {
        return Promise.resolve(jsonResponse(201, { success: true, plan: plan({ id: 'new-plan' }) }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    const user = userEvent.setup();
    renderNewPlanPage();

    await user.type(screen.getByLabelText('Name'), 'FY27 Plan');
    await user.type(screen.getByLabelText('Actuals through (last closed month)'), '2026-09');
    await user.type(screen.getByLabelText('Plan starts'), '2026-10');
    await user.click(screen.getByRole('button', { name: 'Create plan' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'POST';
      });
      expect(postCall).toBeDefined();
      const [, init] = postCall as [RequestInfo | URL, RequestInit];
      const body = JSON.parse(init.body as string) as { startsOn: string; actualsThrough: string };
      expect(body.startsOn).toBe('2026-10-01');
      expect(body.actualsThrough).toBe('2026-09-01');
    });
  });
});

function mockDetailRoutes(detailPlan: ForecasterPlan) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
    }
    if (method === 'GET' && url.includes('/drivers')) {
      return Promise.resolve(jsonResponse(200, { success: true, drivers: [], count: 0 }));
    }
    if (method === 'GET' && url.includes('/headcount')) {
      return Promise.resolve(jsonResponse(200, { success: true, roles: [], count: 0 }));
    }
    if (method === 'GET' && url.includes('/forecast-lines')) {
      return Promise.resolve(jsonResponse(200, { success: true, lines: [], count: 0 }));
    }
    if (method === 'POST' && /\/forecaster\/plans\/[^/]+\/roll$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true, plan: { ...detailPlan, startsOn: '2026-11-01' } }));
    }
    if (method === 'GET' && /\/forecaster\/plans\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true, plan: detailPlan }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecaster/plan-1']}>
      <Routes>
        <Route path="/app/:appSlug/:id" element={<ForecasterPlanDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForecasterPlanDetailPage', () => {
  it('4. asks for confirmation before rolling a plan forward', async () => {
    mockDetailRoutes(plan());
    const user = userEvent.setup();
    renderDetailPage();

    await screen.findByText('FY27 Plan');
    await user.click(screen.getByRole('button', { name: /Roll forward/ }));

    const dialog = await screen.findByRole('dialog');
    expect(
      fetchMock.mock.calls.some((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'POST';
      }),
    ).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Roll forward' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => {
          const [input, init] = c as [RequestInfo | URL, RequestInit?];
          const url = typeof input === 'string' ? input : input.toString();
          return init?.method === 'POST' && url.includes('/roll');
        }),
      ).toBe(true);
    });
  });
});
