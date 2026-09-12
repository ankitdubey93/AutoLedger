import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UniteconCohortsPage from '../Pages/unitecon/UniteconCohortsPage';
import type { UniteconCohortResponse } from '../services/fetchServices';

/** UnitEcon (Phase 14) — the cohort-retention matrix page. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function cohorts(overrides: Partial<UniteconCohortResponse> = {}): UniteconCohortResponse {
  return {
    baseCurrency: 'USD',
    from: '2026-01-01',
    to: '2026-02-01',
    matrix: {
      months: ['2026-01-01', '2026-02-01'],
      rows: [
        {
          cohortMonth: '2026-01-01',
          cohortSize: 2,
          customerIds: ['c1', 'c2'],
          cells: [
            { offset: 0, month: '2026-01-01', activeCustomers: 2, netRevenueCents: 100000, retentionBps: 10000 },
            { offset: 1, month: '2026-02-01', activeCustomers: 1, netRevenueCents: 50000, retentionBps: 6667 },
          ],
        },
      ],
      totalNewCustomers: 2,
      excludedPriorCustomers: 0,
    },
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

function mockCohortsRoute(response: UniteconCohortResponse | { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/unitecon/cohorts')) {
      if ('status' in response) {
        return Promise.resolve(jsonResponse(response.status, response.body));
      }
      return Promise.resolve(jsonResponse(200, { success: true, cohorts: response }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderCohortsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/unitecon/cohorts']}>
      <Routes>
        <Route path="/app/:appSlug/cohorts" element={<UniteconCohortsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UniteconCohortsPage', () => {
  it('1. renders a cohort row with retentionBps as a percentage', async () => {
    mockCohortsRoute(cohorts());
    renderCohortsPage();

    await screen.findByText('66.7%');
  });

  it('2. shows the excluded-prior-customers banner when the count is positive', async () => {
    mockCohortsRoute(cohorts({ matrix: { ...cohorts().matrix, excludedPriorCustomers: 3 } }));
    renderCohortsPage();

    await screen.findByText(/3 customers acquired before this window/);
  });

  it('3. hides the excluded-prior-customers banner when the count is zero', async () => {
    mockCohortsRoute(cohorts());
    renderCohortsPage();

    await screen.findByText('66.7%');
    expect(screen.queryByText(/acquired before this window/)).not.toBeInTheDocument();
  });

  it('4. renders an error message rather than a blank page on failure', async () => {
    mockCohortsRoute({ status: 500, body: { success: false, error: 'boom' } });
    renderCohortsPage();

    await screen.findByText('boom');
  });
});
