import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FpaModelsPage from '../Pages/fpa-engine/FpaModelsPage';
import NewFpaModelPage from '../Pages/fpa-engine/NewFpaModelPage';
import FpaModelDetailPage from '../Pages/fpa-engine/FpaModelDetailPage';
import type { Account, FpaModel, FpaModelDetail } from '../services/fetchServices';

/** FP&A Engine (Phase 12) — the models list, create form, and detail page. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function model(overrides: Partial<FpaModel> = {}): FpaModel {
  return {
    id: 'model-1',
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
    scenarioCount: 1,
    ...overrides,
  };
}

function modelDetail(overrides: Partial<FpaModelDetail> = {}): FpaModelDetail {
  return {
    ...model(),
    scenarios: [
      {
        id: 'scenario-1',
        modelId: 'model-1',
        name: 'Base',
        kind: 'BASE',
        isDefault: true,
        dsoDays: 0,
        dpoDays: 0,
        taxRateBps: 0,
        createdAt: new Date('2026-09-01').toISOString(),
        updatedAt: new Date('2026-09-01').toISOString(),
      },
    ],
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    code: '4100',
    name: 'Product Revenue',
    type: 'Revenue',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
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

function mockModelsListRoute(models: FpaModel[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/fpa-engine/models')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          models,
          count: models.length,
          totalCount: models.length,
          currentPage: 1,
          totalPages: 1,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderModelsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/fpa-engine']}>
      <Routes>
        <Route path="/app/:appSlug" element={<FpaModelsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FpaModelsPage', () => {
  it('1. renders one row per model with its scenario count', async () => {
    mockModelsListRoute([
      model({ id: 'm1', name: 'FY27 Plan', scenarioCount: 3 }),
      model({ id: 'm2', name: 'FY28 Draft', scenarioCount: 1 }),
    ]);
    renderModelsPage();

    await screen.findByText('FY27 Plan');
    expect(screen.getByText('FY28 Draft')).toBeInTheDocument();
    const row = screen.getByText('FY27 Plan').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('3')).toBeInTheDocument();
  });

  it('2. shows the empty state and a New-model link when there are no models', async () => {
    mockModelsListRoute([]);
    renderModelsPage();

    await screen.findByText('No models yet.');
    expect(screen.getByRole('link', { name: 'Build the first model' })).toBeInTheDocument();
  });
});

function renderNewModelPage() {
  return render(
    <MemoryRouter initialEntries={['/app/fpa-engine/new']}>
      <Routes>
        <Route path="/app/:appSlug/new" element={<NewFpaModelPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewFpaModelPage', () => {
  it('3. blocks submission and shows the server-matching message when actualsThrough equals startsOn', async () => {
    const user = userEvent.setup();
    renderNewModelPage();

    await user.type(screen.getByLabelText('Name'), 'Bad Model');
    await user.type(screen.getByLabelText('Actuals through (last closed month)'), '2026-10');
    await user.type(screen.getByLabelText('Projection starts'), '2026-10');

    expect(await screen.findByText('actualsThrough must be before startsOn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create model' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockDetailRoutes(detail: FpaModelDetail, accounts: Account[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    }
    if (method === 'GET' && url.includes('/assumptions')) {
      return Promise.resolve(jsonResponse(200, { success: true, assumptions: [], count: 0 }));
    }
    if (method === 'DELETE' && /\/fpa-engine\/models\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true }));
    }
    if (method === 'GET' && /\/fpa-engine\/models\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true, model: detail }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={['/app/fpa-engine/model-1']}>
      <Routes>
        <Route path="/app/:appSlug/:id" element={<FpaModelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FpaModelDetailPage', () => {
  it('4. an ARCHIVED model offers Activate but no Draft/Archive actions — honours FPA_MODEL_TRANSITIONS', async () => {
    mockDetailRoutes(modelDetail({ status: 'ARCHIVED' }), [account()]);
    renderDetailPage();

    await screen.findByText('FY27 Plan');
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set to Draft' })).not.toBeInTheDocument();
  });

  it('5. delete-model click opens ConfirmDialog and calls nothing until confirmed', async () => {
    mockDetailRoutes(modelDetail(), [account()]);
    const user = userEvent.setup();
    renderDetailPage();

    await screen.findByText('FY27 Plan');
    // The scenarios table has its own per-row "Delete", disabled for the
    // default scenario — the header's model-level Delete is the first one.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[0] as HTMLElement);

    const dialog = await screen.findByRole('dialog');
    expect(
      fetchMock.mock.calls.some((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'DELETE';
      }),
    ).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => {
          const [, init] = c as [RequestInfo | URL, RequestInit?];
          return init?.method === 'DELETE';
        }),
      ).toBe(true);
    });
  });
});
