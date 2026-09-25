import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { ShellProvider, useShell } from '../components/layout/ShellContext';
import CommandPalette from '../components/layout/CommandPalette';
import type { Role } from '../services/fetchServices';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(role: Role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function OpenButton() {
  const { openPalette } = useShell();
  return (
    <button type="button" onClick={openPalette}>
      open palette
    </button>
  );
}

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <OrgProvider>
          <ShellProvider>
            <OpenButton />
            <CommandPalette />
            <Routes>
              <Route path="/inventory/items" element={<p>STOCK PAGE</p>} />
              <Route path="/documents" element={<p>DOCUMENTS PAGE</p>} />
            </Routes>
          </ShellProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('CommandPalette', () => {
  it('renders nothing until opened', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens as a dialog with a search input focused', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: 'open palette' }));

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /search or jump to/i })).toHaveFocus();
  });

  it('filters results as you type', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await screen.findByRole('dialog');

    await user.type(screen.getByRole('combobox'), 'documents');

    expect(screen.getByRole('option', { name: /documents/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /chart of accounts/i })).not.toBeInTheDocument();
  });

  it('Enter navigates to the highlighted result and closes the palette', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await screen.findByRole('dialog');

    await user.type(screen.getByRole('combobox'), 'documents');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('DOCUMENTS PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes the palette', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('searches the whole product under section names, not app names', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await screen.findByRole('dialog');

    // One list covers accounting, the bill inbox and inventory alike.
    expect(screen.getByRole('option', { name: /invoices\s*sales/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /bill inbox\s*purchases/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /stock on hand\s*products & inventory/i })).toBeInTheDocument();
    expect(screen.queryByText(/LedgerCore|StockLedger|AP-Flow/)).not.toBeInTheDocument();

    await user.type(screen.getByRole('combobox'), 'stock on hand');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('STOCK PAGE')).toBeInTheDocument();
  });
});
