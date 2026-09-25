import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import LegacyAppRedirect, { legacyTarget } from '../routes/LegacyAppRedirect';

/**
 * Phase 33 merged three apps into one product and dropped the
 * `/app/<slug>/...` URL shape. Old URLs still arrive (bookmarks, emails and
 * printed QR labels, which cannot be recalled), so every one of them must
 * land on the page that replaced it.
 */

function Probe() {
  const { pathname, search } = useLocation();
  return <span data-testid="at">{pathname + search}</span>;
}

function landAt(url: string): string {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/:appSlug/*" element={<LegacyAppRedirect />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('at').textContent ?? '';
}

describe('legacyTarget', () => {
  it.each([
    ['ledger-core', '', '/'],
    ['ledger-core', 'invoices/abc/edit', '/invoices/abc/edit'],
    ['ledger-core', 'items', '/products'],
    ['ledger-core', 'settings', '/settings/general'],
    ['ledger-core', 'settings/payment-terms', '/settings/payment-terms'],
    ['ledger-core', 'audit', '/settings/audit'],
    ['ledger-core', 'webhooks/deliveries', '/settings/webhooks/deliveries'],
    ['ap-flow', '', '/inbox'],
    ['ap-flow', 'review', '/inbox/review'],
    ['ap-flow', 'doc-1', '/inbox/doc-1'],
    ['ap-flow', 'settings', '/settings/inbox'],
    ['ap-flow', 'usage', '/settings/ai-usage'],
    ['stock', '', '/'],
    ['stock', 'dashboard', '/'],
    ['stock', 'items/abc', '/inventory/items/abc'],
    ['stock', 'scan/serial/abc', '/inventory/scan/serial/abc'],
    ['stock', 'settings', '/settings/inventory'],
    ['stock', 'settings/codes', '/settings/inventory/codes'],
    ['unitecon', 'anything', '/'],
  ])('/app/%s/%s → %s', (slug, rest, expected) => {
    expect(legacyTarget(slug, rest)).toBe(expected);
  });
});

describe('LegacyAppRedirect', () => {
  it('a printed QR label (/app/stock/scan/...) opens the inventory scan route', () => {
    expect(landAt('/app/stock/scan/item/123e4567-e89b-12d3-a456-426614174000')).toBe(
      '/inventory/scan/item/123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('keeps the query string', () => {
    expect(landAt('/app/ledger-core/invoices?status=DRAFT')).toBe('/invoices?status=DRAFT');
  });

  it('an app root with no trailing path goes to its replacement', () => {
    expect(landAt('/app/ap-flow')).toBe('/inbox');
  });

  it('an unknown or retired app goes to the dashboard', () => {
    expect(landAt('/app/nope/x')).toBe('/');
  });
});
