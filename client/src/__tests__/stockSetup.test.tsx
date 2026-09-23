import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import StockSetupPage from '../Pages/stock/StockSetupPage';
import type { StockIndustryProfileSummary, StockSettings } from '../services/fetchServices';

/**
 * StockLedger (Phase 28) — the setup wizard. Reads `useAuth()` to gate the
 * apply button on role, so it renders under AuthProvider, mirroring
 * UniteconSettingsPage's tests.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionFor(role: 'OWNER' | 'VIEWER') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const unconfiguredSettings: StockSettings = {
  configured: false,
  industryProfile: null,
  suggestedProfile: 'REAL_ESTATE',
  updatedAt: null,
};

const profiles: StockIndustryProfileSummary[] = [
  {
    key: 'GENERAL',
    name: 'General business',
    description: 'A neutral starting point you shape yourself.',
    locationName: 'Main warehouse',
    categories: [
      { code: 'GEN', name: 'General goods', itemType: 'TRADING_GOOD', defaultTracking: 'QUANTITY', attributes: [] },
    ],
    codeSchemes: [{ name: 'Category + number', pattern: '{CAT}-{SEQ:5}', isDefault: true, example: 'GEN-00001' }],
  },
  {
    key: 'REAL_ESTATE',
    name: 'Real estate',
    description: 'Developers holding units, plots and construction materials.',
    locationName: 'Project site',
    categories: [
      {
        code: 'RES',
        name: 'Residential units',
        itemType: 'PROPERTY_UNIT',
        defaultTracking: 'SERIAL',
        attributes: [{ key: 'project', label: 'Project', appliesTo: 'ITEM', dataType: 'TEXT' }],
      },
    ],
    codeSchemes: [{ name: 'Category + number', pattern: '{CAT}-{SEQ:4}', isDefault: true, example: 'RES-0001' }],
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let applyBody: unknown;

beforeEach(() => {
  applyBody = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockSetupRoutes(role: 'OWNER' | 'VIEWER') {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor(role)));
    if (url.includes('/stock/setup/profiles')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: profiles.length, profiles }));
    }
    if (url.includes('/stock/setup')) {
      if (init?.method === 'POST') {
        applyBody = init.body !== undefined ? JSON.parse(init.body as string) : null;
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            settings: { ...unconfiguredSettings, configured: true, industryProfile: 'REAL_ESTATE' },
            created: { uoms: 5, categories: 4, attributes: 8, codeSchemes: 2, locations: 1 },
          }),
        );
      }
    }
    if (url.includes('/stock/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: unconfiguredSettings }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderSetupPage() {
  return render(
    <MemoryRouter initialEntries={['/app/stock/setup']}>
      <AuthProvider>
        <Routes>
          <Route path="/app/:appSlug/setup" element={<StockSetupPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('StockSetupPage', () => {
  it('pre-selects the suggested profile', async () => {
    mockSetupRoutes('OWNER');
    renderSetupPage();

    const card = await screen.findByRole('button', { name: /Real estate/ });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Suggested')).toBeInTheDocument();
  });

  it('shows the preview with the scheme example RES-0001 for Real estate', async () => {
    mockSetupRoutes('OWNER');
    renderSetupPage();

    await screen.findByRole('button', { name: /Real estate/ });
    expect(screen.getByText(/RES-0001/)).toBeInTheDocument();
  });

  it('OWNER applies and sees created counts', async () => {
    mockSetupRoutes('OWNER');
    const user = userEvent.setup();
    renderSetupPage();

    const applyButton = await screen.findByRole('button', { name: 'Set up StockLedger' });
    await user.click(applyButton);

    await waitFor(() => {
      expect(applyBody).toEqual({ industryProfile: 'REAL_ESTATE' });
    });
    expect(await screen.findByText(/5 units of measure/)).toBeInTheDocument();
  });

  it('VIEWER sees no apply button', async () => {
    mockSetupRoutes('VIEWER');
    renderSetupPage();

    await screen.findByRole('button', { name: /Real estate/ });
    expect(screen.queryByRole('button', { name: 'Set up StockLedger' })).not.toBeInTheDocument();
    expect(screen.getByText('Ask an owner or admin to finish setup.')).toBeInTheDocument();
  });
});
