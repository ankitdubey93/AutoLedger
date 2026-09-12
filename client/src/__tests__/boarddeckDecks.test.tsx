import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import BoardDeckDecksPage from '../Pages/boarddeck/BoardDeckDecksPage';
import type { BoardDeckDeck } from '../services/fetchServices';

/**
 * BoardDeck decks page (Phase 15). Reads `useAuth()` to gate Delete on
 * role, so it renders under AuthProvider + OrgProvider.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(role: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function deck(overrides: Partial<BoardDeckDeck> = {}): BoardDeckDeck {
  return {
    id: 'deck-1',
    title: 'June Board Deck',
    fiscalPeriodId: 'period-1',
    planId: null,
    periodStartsOn: '2026-06-01',
    periodEndsOn: '2026-06-30',
    status: 'READY',
    sha256: 'a'.repeat(64),
    byteSizeBytes: 12345,
    slideCount: 4,
    errorMessage: null,
    generatedAt: new Date().toISOString(),
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
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

function mockRoutes(role: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER', decks: BoardDeckDeck[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.includes('/ledger-core/fiscal-periods')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
    }
    if (url.includes('/forecaster/plans')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, plans: [], count: 0, totalCount: 0, currentPage: 1, totalPages: 1 }),
      );
    }
    if (url.endsWith('/boarddeck/decks')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: decks.length, decks }));
    }
    const singleMatch = /\/boarddeck\/decks\/([^/]+)$/.exec(url);
    if (singleMatch !== null) {
      const found = decks.find((d) => d.id === singleMatch[1]);
      if (found !== undefined) return Promise.resolve(jsonResponse(200, { success: true, deck: found }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <BoardDeckDecksPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('BoardDeckDecksPage', () => {
  it('a READY deck shows Download and hides Retry', async () => {
    mockRoutes('OWNER', [deck({ status: 'READY' })]);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('a FAILED deck shows Retry and its error message', async () => {
    mockRoutes('OWNER', [deck({ status: 'FAILED', sha256: null, byteSizeBytes: null, slideCount: null, generatedAt: null, errorMessage: 'boom' })]);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('a GENERATING deck polls and stops once READY', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const generating = deck({ status: 'GENERATING', sha256: null, byteSizeBytes: null, slideCount: null, generatedAt: null });
    const ready = deck({ status: 'READY' });

    let pollCount = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
      if (url.includes('/ledger-core/fiscal-periods')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
      }
      if (url.includes('/forecaster/plans')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, plans: [], count: 0, totalCount: 0, currentPage: 1, totalPages: 1 }),
        );
      }
      if (url.endsWith('/boarddeck/decks')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 1, decks: [generating] }));
      }
      if (url.endsWith(`/boarddeck/decks/${generating.id}`)) {
        pollCount += 1;
        return Promise.resolve(jsonResponse(200, { success: true, deck: pollCount >= 1 ? ready : generating }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('GENERATING')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(screen.getByText('READY')).toBeInTheDocument());

    const countAfterReady = pollCount;
    await vi.advanceTimersByTimeAsync(10000);
    expect(pollCount).toBe(countAfterReady);

    vi.useRealTimers();
  });

  it('Delete is absent for an ACCOUNTANT', async () => {
    mockRoutes('ACCOUNTANT', [deck()]);
    renderPage();

    await screen.findByText('June Board Deck');
    expect(screen.queryByLabelText(/Delete/)).not.toBeInTheDocument();
  });
});
