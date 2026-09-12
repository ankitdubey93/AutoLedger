import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardDeckBvaPage from '../Pages/boarddeck/BoardDeckBvaPage';

/**
 * BoardDeck BvA page (Phase 15). Talks to fetchServices directly — no
 * AuthContext needed, since every role can read this page.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes(bvaResponse: () => Response) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/forecaster/plans')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          plans: [{ id: 'plan-1', name: 'FY27 Plan', description: null, startsOn: '2026-06-01', horizonMonths: 3, actualsThrough: '2026-05-01', status: 'ACTIVE', createdBy: 'u1', createdByName: 'Ada', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          count: 1,
          totalCount: 1,
          currentPage: 1,
          totalPages: 1,
        }),
      );
    }
    if (url.includes('/boarddeck/bva')) {
      return Promise.resolve(bvaResponse());
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BoardDeckBvaPage />
    </MemoryRouter>,
  );
}

describe('BoardDeckBvaPage', () => {
  it('a 422 from /bva renders the no-approved-budget empty state, not an error', async () => {
    mockRoutes(() =>
      jsonResponse(422, { success: false, error: 'This plan has no approved budget version' }),
    );
    renderPage();

    expect(await screen.findByText(/This plan has no approved budget version/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to ForecasterPro' })).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status/)).not.toBeInTheDocument();
  });
});
