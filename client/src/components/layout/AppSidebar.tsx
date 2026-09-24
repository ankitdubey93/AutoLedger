import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useShell } from './ShellContext';
import { cx } from '../../utils/cx';

export interface SidebarNavItem {
  /** An absolute path, already resolved by the caller (e.g. via useAppBasePath()). */
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
}

export interface SidebarNavGroup {
  heading: string;
  items: readonly SidebarNavItem[];
}

export interface AppSidebarProps {
  /** The <nav> accessible name — 'LedgerCore', 'StockLedger', 'AP-Flow'. */
  ariaLabel: string;
  /** Namespaces this app's group-collapse persistence in localStorage. */
  storageKey: string;
  groups: readonly SidebarNavGroup[];
  /** CreateMenu, or nothing — rendered above the nav, hidden while the rail is collapsed to icons. */
  header?: ReactNode;
}

function isItemActive(pathname: string, item: SidebarNavItem): boolean {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function readCollapsedGroups(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(`autoledger.sidebarGroups.${storageKey}`);
    return raw === null ? new Set() : new Set<string>(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

const linkClass = (isActive: boolean, collapsed: boolean) =>
  cx(
    'group/link flex items-center gap-2.5 px-3 py-2 text-sm no-underline rounded-md whitespace-nowrap transition-colors',
    collapsed && 'justify-center px-0',
    isActive
      ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium shadow-[inset_2px_0_0_var(--accent)]'
      : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]',
  );

/**
 * The shared rail behind LedgerCoreSidebar, StockSidebar and ApFlowSidebar —
 * grouped links, a collapsible icon rail on desktop, and an off-canvas
 * drawer on mobile that replaces the old horizontal scroll strip.
 *
 * Two markup blocks, not one responsive block: the desktop `<nav>` is always
 * in the DOM (hidden below `md` by CSS only), so `getByRole('link', …)`
 * keeps finding a unique match with the same accessible name whether the
 * rail is expanded or collapsed to icons — collapsing hides labels visually
 * with `sr-only`, never from the accessibility tree. The mobile drawer is a
 * SEPARATE tree, mounted only while `mobileOpen` is true, so the two never
 * both exist in the DOM at once and a test never sees a duplicate link.
 */
export default function AppSidebar({ ariaLabel, storageKey, groups, header }: AppSidebarProps) {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useShell();
  const location = useLocation();
  const [manuallyCollapsedGroups, setManuallyCollapsedGroups] = useState<Set<string>>(() =>
    readCollapsedGroups(storageKey),
  );

  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen, setMobileOpen]);

  function toggleGroup(heading: string) {
    setManuallyCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(heading)) next.delete(heading);
      else next.add(heading);
      try {
        localStorage.setItem(`autoledger.sidebarGroups.${storageKey}`, JSON.stringify([...next]));
      } catch {
        // in-memory state still applies for this session
      }
      return next;
    });
  }

  function isGroupActive(group: SidebarNavGroup): boolean {
    return group.items.some((item) => isItemActive(location.pathname, item));
  }

  function renderGroups(collapseToIcons: boolean, showHeadings: boolean) {
    return groups.map((group) => {
      const active = isGroupActive(group);
      const open = active || !manuallyCollapsedGroups.has(group.heading);
      return (
        <div key={group.heading} className="flex flex-col gap-1">
          {showHeadings && (
            <button
              type="button"
              onClick={() => toggleGroup(group.heading)}
              aria-expanded={open}
              className="flex items-center justify-between gap-1 px-3 py-1 mt-0 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
            >
              {group.heading}
              <ChevronDown
                size={12}
                aria-hidden="true"
                className={cx('transition-transform duration-150', !open && '-rotate-90')}
              />
            </button>
          )}
          {(open || !showHeadings) &&
            group.items.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.end}
                title={collapseToIcons ? item.label : undefined}
                className={({ isActive }) => linkClass(isActive, collapseToIcons)}
              >
                <item.icon size={16} aria-hidden="true" className="shrink-0" />
                <span className={collapseToIcons ? 'sr-only' : undefined}>{item.label}</span>
              </NavLink>
            ))}
        </div>
      );
    });
  }

  return (
    <>
      {/* Desktop rail — always in the DOM; CSS alone decides visibility below `md`. */}
      <nav
        aria-label={ariaLabel}
        className={cx(
          'no-print hidden md:flex md:flex-col md:shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] border-r border-[var(--border)] py-5 transition-[width] duration-200',
          collapsed ? 'md:w-16 md:px-2' : 'md:w-60 md:pr-3',
        )}
        style={{ transitionTimingFunction: 'var(--ease)' }}
      >
        {header !== undefined && !collapsed && <div className="mb-4 px-1">{header}</div>}
        <div className="flex-1 flex flex-col gap-6 overflow-y-auto overflow-x-hidden">
          {renderGroups(collapsed, !collapsed)}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cx(
            'mt-3 flex items-center gap-2.5 px-3 py-2 text-sm rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} aria-hidden="true" />
          )}
          <span className={collapsed ? 'sr-only' : undefined}>Collapse sidebar</span>
        </button>
      </nav>

      {/* Mobile drawer — a second, separate tree, only mounted while open. */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="animate-fade-in absolute inset-0 bg-black/50 border-0 p-0 cursor-pointer"
          />
          <nav
            aria-label={ariaLabel}
            className="animate-slide-in-left absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-[var(--panel)] border-r border-[var(--border)] p-4 flex flex-col overflow-y-auto shadow-[var(--shadow-lg)]"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold">{ariaLabel}</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMobileOpen(false)}
                className="p-1 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {header !== undefined && <div className="mb-4">{header}</div>}
            <div className="flex flex-col gap-6" onClick={() => setMobileOpen(false)}>
              {renderGroups(false, true)}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
