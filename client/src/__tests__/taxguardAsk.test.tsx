import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import TaxGuardAskPage from '../Pages/taxguard/TaxGuardAskPage';
import type { TaxGuardQuestion } from '../services/fetchServices';

/** TaxGuard ask page (Phase 16). Renders under AuthProvider + OrgProvider, matching every other app page test. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session() {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role: 'OWNER' as const,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER' as const, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function question(overrides: Partial<TaxGuardQuestion> = {}): TaxGuardQuestion {
  return {
    id: 'q-1',
    questionText: 'Can I claim a deduction?',
    jurisdiction: 'IN',
    answerText: 'Yes, under Section 80C. [1]',
    citations: [
      { chunkId: 'c-1', citation: 'Income-tax Act, Section 80C', corpusDocumentTitle: 'Income-tax Act, 1961', score: 0.9 },
      { chunkId: 'c-2', citation: 'Income-tax Act, Section 80D', corpusDocumentTitle: 'Income-tax Act, 1961', score: 0.8 },
    ],
    model: 'claude-sonnet-5',
    latencyMs: 1200,
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

function mockAuth() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session()));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <TaxGuardAskPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function askQuestion(user: ReturnType<typeof userEvent.setup>) {
  const textarea = await screen.findByLabelText('Question');
  await user.type(textarea, 'Can I claim a deduction for my investments?');
  await user.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('TaxGuardAskPage', () => {
  it('renders citations as a numbered source list', async () => {
    const user = userEvent.setup();
    mockAuth();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session()));
      if (url.endsWith('/taxguard/questions') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { success: true, question: question() }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    renderPage();

    await askQuestion(user);

    expect(await screen.findByText(/\[1\] Income-tax Act, Section 80C/)).toBeInTheDocument();
    expect(screen.getByText(/\[2\] Income-tax Act, Section 80D/)).toBeInTheDocument();
  });

  it('renders the empty state on a 422', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session()));
      if (url.endsWith('/taxguard/questions') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(422, { success: false, error: 'No relevant source material found' }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    renderPage();

    await askQuestion(user);

    expect(await screen.findByText(/No source material yet/)).toBeInTheDocument();
    expect(screen.queryByText(/status--bad/)).not.toBeInTheDocument();
  });

  it('renders the not-configured state on a 503', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session()));
      if (url.endsWith('/taxguard/questions') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(503, { success: false, error: 'Answering is not configured' }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    renderPage();

    await askQuestion(user);

    expect(await screen.findByText(/Answering is not configured/)).toBeInTheDocument();
  });
});
