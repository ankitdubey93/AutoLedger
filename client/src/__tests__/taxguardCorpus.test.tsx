import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import TaxGuardCorpusPage from '../Pages/taxguard/TaxGuardCorpusPage';
import type { TaxGuardCorpusDocument } from '../services/fetchServices';

/**
 * TaxGuard corpus page (Phase 16). Reads `useAuth()` to gate Add/Delete on
 * role, so it renders under AuthProvider + OrgProvider — the same posture
 * boarddeckDecks.test.tsx established.
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

function corpusDoc(overrides: Partial<TaxGuardCorpusDocument> = {}): TaxGuardCorpusDocument {
  return {
    id: 'corpus-1',
    documentId: 'doc-1',
    title: 'Income-tax Act, 1961',
    jurisdiction: 'IN',
    actYear: 1961,
    status: 'READY',
    chunkCount: 12,
    errorMessage: null,
    ingestedAt: new Date().toISOString(),
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

function mockRoutes(role: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER', documents: TaxGuardCorpusDocument[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.endsWith('/taxguard/corpus')) {
      return Promise.resolve(jsonResponse(200, { success: true, corpusDocuments: documents }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <TaxGuardCorpusPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('TaxGuardCorpusPage', () => {
  it('renders a status badge per document', async () => {
    mockRoutes('OWNER', [
      corpusDoc({ id: 'ready-1', title: 'Ready Act', status: 'READY' }),
      corpusDoc({ id: 'failed-1', title: 'Failed Act', status: 'FAILED', chunkCount: 0, ingestedAt: null, errorMessage: 'parse error' }),
    ]);
    renderPage();

    await screen.findByText('Ready Act');
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText(/parse error/)).toBeInTheDocument();
  });

  it('Add to corpus is hidden for a VIEWER', async () => {
    mockRoutes('VIEWER', [corpusDoc()]);
    renderPage();

    await screen.findByText('Income-tax Act, 1961');
    expect(screen.queryByRole('button', { name: 'Add to corpus' })).not.toBeInTheDocument();
  });

  it('Add to corpus is visible for an ACCOUNTANT', async () => {
    mockRoutes('ACCOUNTANT', [corpusDoc()]);
    renderPage();

    await screen.findByText('Income-tax Act, 1961');
    expect(screen.getByRole('button', { name: /Add to corpus/ })).toBeInTheDocument();
  });

  it('Delete is hidden below ADMIN', async () => {
    mockRoutes('ACCOUNTANT', [corpusDoc()]);
    renderPage();

    await screen.findByText('Income-tax Act, 1961');
    expect(screen.queryByLabelText(/Delete/)).not.toBeInTheDocument();
  });

  it('Delete is visible for OWNER', async () => {
    mockRoutes('OWNER', [corpusDoc()]);
    renderPage();

    await screen.findByText('Income-tax Act, 1961');
    expect(screen.getByLabelText(/Delete/)).toBeInTheDocument();
  });
});
