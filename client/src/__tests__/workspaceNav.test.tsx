import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ShellProvider } from '../components/layout/ShellContext';
import Sidebar from '../components/layout/Sidebar';
import { NAV_GROUPS } from '../components/layout/nav';

/**
 * Phase 33: one sidebar for the whole product. Accounting, the bill inbox and
 * inventory are sections of it, not separate apps behind a switcher.
 */

function renderSidebar(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShellProvider>
        <Sidebar />
      </ShellProvider>
    </MemoryRouter>,
  );
}

function desktopNav(): HTMLElement {
  // AppSidebar renders a desktop <nav> and (when open) a mobile drawer with the same name.
  const [nav] = screen.getAllByRole('navigation', { name: 'AutoLedger' });
  if (nav === undefined) throw new Error('no sidebar rendered');
  return nav;
}

describe('the product sidebar', () => {
  it('has the sections of one product, in order', () => {
    expect(NAV_GROUPS.map((g) => g.heading)).toEqual([
      'Overview',
      'Sales',
      'Purchases',
      'Products & inventory',
      'Banking',
      'Accounting',
      'Reports',
      'Workspace',
    ]);
  });

  it('every link is absolute and none still uses the retired /app/<slug> shape', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.to.startsWith('/app/')).toBe(false);
    }
  });

  it('puts the bill inbox under Purchases and stock under Products & inventory', () => {
    renderSidebar();
    const nav = within(desktopNav());

    expect(nav.getByRole('link', { name: 'Bill inbox' })).toHaveAttribute('href', '/inbox');
    expect(nav.getByRole('link', { name: 'Review queue' })).toHaveAttribute('href', '/inbox/review');
    expect(nav.getByRole('link', { name: 'Products & services' })).toHaveAttribute('href', '/products');
    expect(nav.getByRole('link', { name: 'Stock on hand' })).toHaveAttribute('href', '/inventory/items');
    expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('marks the bill inbox current on /inbox but not on /inbox/review', () => {
    renderSidebar('/inbox/review');
    const nav = within(desktopNav());

    expect(nav.getByRole('link', { name: 'Review queue' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Bill inbox' })).not.toHaveAttribute('aria-current');
  });

  it('the New menu creates documents from every section', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(within(desktopNav()).getByRole('button', { name: /new/i }));

    expect(screen.getByRole('menuitem', { name: 'Invoice' })).toHaveAttribute('href', '/invoices/new');
    expect(screen.getByRole('menuitem', { name: 'Upload a bill' })).toHaveAttribute('href', '/inbox');
    expect(screen.getByRole('menuitem', { name: 'Stock item' })).toHaveAttribute('href', '/inventory/items/new');
    expect(screen.getByRole('menuitem', { name: 'Product or service' })).toHaveAttribute('href', '/products?new=1');
  });
});
