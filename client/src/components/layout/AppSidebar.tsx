import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronRight, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useShell } from './ShellContext';
import { cx } from '../../utils/cx';

export interface SidebarNavItem {
  /** An absolute path, already resolved by the caller (e.g. via useAppBasePath()). */
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
  /** Phase 38c — the permission needed to see this entry; absent means every member. */
  permission?: string;
}

export interface SidebarNavGroup {
  heading: string;
  items: readonly SidebarNavItem[];
  /** The group's own icon; defaults to its first item's. */
  icon?: LucideIcon;
  /** A `.tone-*` class colouring that icon. */
  tone?: string;
  /** Render the items as top-level links with no heading to open. */
  flat?: boolean;
}

export interface AppSidebarProps {
  /** The <nav> accessible name — 'Accounting', 'Inventory', 'Capture'. */
  ariaLabel: string;
  groups: readonly SidebarNavGroup[];
  /** CreateMenu, or nothing — rendered above the nav, hidden while the rail is collapsed to icons. */
  header?: ReactNode;
}

function isItemActive(pathname: string, item: SidebarNavItem): boolean {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * The shared rail behind AccountingSidebar, StockSidebar and CaptureSidebar —
 * groups that open like an accordion, a collapsible icon rail on desktop, and an
 * off-canvas drawer on mobile. Only the group holding the current page and the one
 * last opened are expanded, so forty links read as seven headings.
 *
 * Two markup blocks, not one responsive block: the desktop `<nav>` is always
 * in the DOM (hidden below `md` by CSS only), so `getByRole('link', …)`
 * keeps finding a unique match with the same accessible name whether the
 * rail is expanded or collapsed to icons — collapsing hides labels visually
 * with `sr-only`, never from the accessibility tree. A closed group's links stay
 * mounted so its panel can animate; `inert` and `aria-hidden` keep them out of
 * reach until it opens. The mobile drawer is a
 * SEPARATE tree, mounted only while `mobileOpen` is true, so the two never
 * both exist in the DOM at once and a test never sees a duplicate link.
 */
export default function AppSidebar({ ariaLabel, groups, header }: AppSidebarProps) {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useShell();
  const location = useLocation();
  const [openedGroup, setOpenedGroup] = useState<string | null>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen, setMobileOpen]);

  function renderRail() {
    return groups.flatMap((group) =>
      group.items.map((item) => (
        <NavLink key={item.label} to={item.to} end={item.end} title={item.label} className="nav-rail-link no-underline">
          <item.icon size={17} aria-hidden="true" />
          <span className="sr-only">{item.label}</span>
        </NavLink>
      )),
    );
  }

  function renderGroups(onNavigate?: () => void) {
    return groups.map((group) => {
      if (group.flat === true) {
        return group.items.map((item) => (
          <NavLink key={item.label} to={item.to} end={item.end} className="nav-flat" onClick={onNavigate}>
            <span className={cx('nav-icon', group.tone)}>
              <item.icon size={17} aria-hidden="true" />
            </span>
            {item.label}
          </NavLink>
        ));
      }
      const active = group.items.some((item) => isItemActive(location.pathname, item));
      const open = active || openedGroup === group.heading;
      const GroupIcon = group.icon ?? group.items[0]?.icon;
      return (
        <div key={group.heading} className={cx('nav-group', open && 'nav-group--open')}>
          <button
            type="button"
            onClick={() => setOpenedGroup((current) => (current === group.heading ? null : group.heading))}
            aria-expanded={open}
            className="nav-group__button"
          >
            <span className={cx('nav-icon', group.tone ?? 'tone-plain')}>{GroupIcon !== undefined && <GroupIcon size={17} aria-hidden="true" />}</span>
            {group.heading}
            <ChevronRight size={16} aria-hidden="true" className="nav-group__chevron" />
          </button>
          <div className="nav-group__panel">
            <div className="nav-group__inner" inert={!open} aria-hidden={!open}>
              {group.items.map((item) => (
                <NavLink key={item.label} to={item.to} end={item.end} className="nav-link" onClick={onNavigate}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
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
          'no-print hidden md:flex md:flex-col md:shrink-0 md:sticky md:top-16 md:h-[calc(100vh-4rem)] py-5 transition-[width] duration-500',
          collapsed ? 'md:w-16 md:px-1' : 'md:w-72',
        )}
        style={{ transitionTimingFunction: 'var(--ease)' }}
      >
        {header !== undefined && !collapsed && <div className="mb-4 px-1">{header}</div>}
        <div className="flex-1 flex flex-col gap-1 overflow-y-auto overflow-x-hidden">{collapsed ? renderRail() : renderGroups()}</div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cx(
            'mt-3 flex items-center gap-3 px-3 min-h-11 text-sm rounded-[0.875rem] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors',
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
            className="animate-fade-in absolute inset-0 bg-black/50 backdrop-blur-sm border-0 p-0 cursor-pointer"
          />
          <nav
            aria-label={ariaLabel}
            className="animate-slide-in-left absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-[var(--bg)] rounded-r-[2rem] p-4 flex flex-col overflow-y-auto shadow-[var(--shadow-lg)]"
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
            <div className="flex flex-col gap-1">{renderGroups(() => setMobileOpen(false))}</div>
          </nav>
        </div>
      )}
    </>
  );
}
