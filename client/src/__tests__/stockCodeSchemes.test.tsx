import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import StockCodeSchemesPage from '../Pages/stock/StockCodeSchemesPage';
import type { StockCategory, StockCodeSchemePreset } from '../services/fetchServices';

/**
 * StockLedger (Phase 28) — the item-code scheme builder. Reads `useAuth()`
 * to gate the builder and save form on role, so it renders under
 * AuthProvider, mirroring UniteconSettingsPage's tests.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionFor(role: 'OWNER' | 'ACCOUNTANT') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const categories: StockCategory[] = [
  {
    id: 'cat-rm',
    code: 'RM',
    name: 'Raw materials',
    parentId: null,
    path: 'Raw materials',
    depth: 1,
    itemType: 'RAW_MATERIAL',
    defaultTracking: 'LOT',
    defaultUomId: null,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const presets: StockCodeSchemePreset[] = [
  { name: 'Category + number', pattern: '{CAT}-{SEQ:5}', description: 'Short category code, then a running number', example: 'CAT-00001' },
  { name: 'Plain number', pattern: '{SEQ:6}', description: 'One running number for everything', example: '000001' },
];

let fetchMock: ReturnType<typeof vi.fn>;
let previewResponse: unknown;

beforeEach(() => {
  previewResponse = { success: true, valid: true, example: 'RM-00001', scopeKey: 'RM-#' };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes(role: 'OWNER' | 'ACCOUNTANT') {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor(role)));
    if (url.includes('/stock/code-schemes/presets')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: presets.length, presets }));
    }
    if (url.includes('/stock/code-schemes/preview')) {
      return Promise.resolve(jsonResponse(200, previewResponse));
    }
    if (url.includes('/stock/code-schemes')) {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            codeScheme: {
              id: 'scheme-new',
              name: 'My scheme',
              pattern: '{CAT}-{SEQ:5}',
              isDefault: false,
              isActive: true,
              example: 'CAT-00001',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, codeSchemes: [] }));
    }
    if (url.includes('/stock/categories')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: categories.length, categories }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/stock/settings/codes']}>
      <AuthProvider>
        <Routes>
          <Route path="/app/:appSlug/settings/codes" element={<StockCodeSchemesPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('StockCodeSchemesPage', () => {
  it('clicking Category then - then Sequence (5) builds {CAT}-{SEQ:5}', async () => {
    mockRoutes('OWNER');
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Category + number');

    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.click(screen.getByRole('button', { name: '-' }));
    await user.click(screen.getByRole('button', { name: 'Sequence…' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));

    const patternInput = screen.getByLabelText('Pattern') as HTMLInputElement;
    expect(patternInput.value).toBe('{CAT}-{SEQ:5}');
  });

  it('shows the preview example from the API', async () => {
    mockRoutes('OWNER');
    renderPage();

    await screen.findByText('Category + number');
    // fireEvent, not userEvent.type: userEvent's keyboard parser treats a
    // literal "{" as the start of a special-key sequence (e.g. "{enter}"),
    // so it cannot type a pattern token like "{SEQ:5}" verbatim.
    fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: '{CAT}-{SEQ:5}' } });

    expect(await screen.findByText('RM-00001')).toBeInTheDocument();
  });

  it('shows the preview error', async () => {
    previewResponse = { success: true, valid: false, error: 'Pattern needs exactly one {SEQ:n}' };
    mockRoutes('OWNER');
    renderPage();

    await screen.findByText('Category + number');
    fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: '{CAT}' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Pattern needs exactly one {SEQ:n}');
  });

  it('Use this preset fills the builder', async () => {
    mockRoutes('OWNER');
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Plain number');
    await user.click(screen.getAllByRole('button', { name: 'Use this' })[1] as HTMLElement);

    const patternInput = screen.getByLabelText('Pattern') as HTMLInputElement;
    expect(patternInput.value).toBe('{SEQ:6}');
  });

  it('ACCOUNTANT sees no save button', async () => {
    mockRoutes('ACCOUNTANT');
    renderPage();

    await screen.findByText('Category + number');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Pattern')).not.toBeInTheDocument();
  });
});
