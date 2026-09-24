import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { Package, Landmark } from 'lucide-react';
import AppSidebar from '../components/layout/AppSidebar';
import { ShellProvider, useShell } from '../components/layout/ShellContext';

const groups = [
  {
    heading: 'Group one',
    items: [
      { to: '/app/test', label: 'Dashboard', icon: Landmark, end: true },
      { to: '/app/test/items', label: 'Items', icon: Package, end: false },
    ],
  },
  {
    heading: 'Group two',
    items: [{ to: '/app/test/other', label: 'Other', icon: Package, end: false }],
  },
];

function Harness({ path = '/app/test' }: { path?: string }) {
  const { mobileOpen, setMobileOpen } = useShell();
  return (
    <>
      <button type="button" onClick={() => setMobileOpen(!mobileOpen)}>
        toggle drawer
      </button>
      <AppSidebar ariaLabel="TestApp" storageKey={`test-${path}`} groups={groups} />
    </>
  );
}

function renderSidebar(path = '/app/test') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShellProvider>
        <Harness path={path} />
      </ShellProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AppSidebar', () => {
  it('renders every link once, with an accessible name, on the desktop rail', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/app/test');
    expect(screen.getByRole('link', { name: 'Items' })).toHaveAttribute('href', '/app/test/items');
  });

  it('marks the active item with aria-current, not its siblings', () => {
    renderSidebar('/app/test/items');
    expect(screen.getByRole('link', { name: 'Items' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('a group heading toggles aria-expanded and hides its items', async () => {
    const user = userEvent.setup();
    renderSidebar('/app/test');

    const heading = screen.getByRole('button', { name: /group two/i });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Other' })).toBeInTheDocument();

    await user.click(heading);

    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Other' })).not.toBeInTheDocument();
  });

  it('the group holding the active route cannot be collapsed away', async () => {
    const user = userEvent.setup();
    renderSidebar('/app/test/other');

    const heading = screen.getByRole('button', { name: /group two/i });
    await user.click(heading);

    // Manually "collapsed", but it holds the active route, so it stays open.
    expect(screen.getByRole('link', { name: 'Other' })).toBeInTheDocument();
    expect(heading).toHaveAttribute('aria-expanded', 'true');
  });

  it('the mobile drawer is absent by default and appears when opened, without duplicating links', async () => {
    const user = userEvent.setup();
    renderSidebar();

    // Only the desktop rail's copy exists initially.
    expect(screen.getAllByRole('link', { name: 'Dashboard' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'toggle drawer' }));

    expect(screen.getAllByRole('link', { name: 'Dashboard' })).toHaveLength(2);
    expect(screen.getAllByRole('navigation', { name: 'TestApp' })).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'toggle drawer' }));
    expect(screen.getAllByRole('link', { name: 'Dashboard' })).toHaveLength(1);
  });

  it('collapsing the rail keeps the same accessible link names and persists the choice', async () => {
    const user = userEvent.setup();
    const { unmount } = renderSidebar();

    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    // Still findable by the same accessible name — collapsing hides the
    // label visually (sr-only), never from the accessibility tree.
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(localStorage.getItem('autoledger.sidebarCollapsed')).toBe('1');

    unmount();
    renderSidebar();
    // The persisted choice survives a fresh mount, and the link is still
    // reachable by the same accessible name.
    expect(localStorage.getItem('autoledger.sidebarCollapsed')).toBe('1');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('Escape closes the mobile drawer', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: 'toggle drawer' }));
    expect(screen.getAllByRole('navigation', { name: 'TestApp' })).toHaveLength(2);

    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('navigation', { name: 'TestApp' })).toHaveLength(1);
  });
});
