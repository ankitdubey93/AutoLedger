import { LogOut, Menu as MenuIcon, Monitor, Moon, Search, Settings, Sun, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import { useTheme, type Theme } from '../../context/ThemeContext';
import { useShell } from './ShellContext';
import OrgSwitcher from './OrgSwitcher';
import Menu from '../ui/Menu';
import { initials } from '../../utils/initials';
import BrandMark from '../BrandMark';

const THEME_OPTIONS: Array<{ id: Theme; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/**
 * The product's top bar. Left to right: the mobile sidebar toggle, the brand
 * mark, a search trigger for the command palette, a theme toggle, the org
 * switcher, and a user menu. Phase 33 removed the app switcher: there is one
 * product, so there is nothing to switch between.
 */
export default function AppTopBar() {
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { organization } = useOrg();
  const { resolvedTheme, setTheme } = useTheme();
  const { setMobileOpen, openPalette } = useShell();

  const email = auth.status === 'authenticated' ? auth.user.email : '';
  const name = auth.status === 'authenticated' ? auth.user.name : null;
  const ThemeIcon = resolvedTheme === 'light' ? Sun : Moon;

  return (
    <header className="app-topbar no-print sticky top-0 z-30 h-16 flex items-center gap-3 px-4 md:px-7 bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
        className="md:hidden p-1.5 -ml-1 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]"
      >
        <MenuIcon size={19} aria-hidden="true" />
      </button>

      <Link
        to="/"
        title="Dashboard"
        className="flex items-center gap-1.5 shrink-0 no-underline text-[var(--text)]"
      >
        <BrandMark nameClassName="hidden sm:inline" />
      </Link>


      <button
        type="button"
        onClick={openPalette}
        className="hidden md:flex items-center gap-2.5 ml-[9.5rem] min-h-11 w-full max-w-sm px-4 rounded-full bg-[var(--panel-2)] text-sm text-[var(--muted)] hover:text-[var(--text)] hover:shadow-[0_0_0_5px_var(--accent-soft)]"
      >
        <Search size={16} aria-hidden="true" />
        <span>Search or jump to…</span>
        <kbd className="ml-auto text-xs bg-[var(--panel)] rounded-lg px-2 py-0.5">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search"
        className="md:hidden p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]"
      >
        <Search size={17} aria-hidden="true" />
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <Menu
          panelLabel="Theme"
          align="right"
          items={THEME_OPTIONS.map((option) => ({
            label: option.label,
            icon: option.icon,
            onSelect: () => setTheme(option.id),
          }))}
          trigger={({ buttonProps }) => (
            <button
              {...buttonProps}
              type="button"
              aria-label="Change theme"
              className="flex size-11 items-center justify-center rounded-full bg-[var(--panel-2)] text-[var(--text)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
            >
              <ThemeIcon size={18} aria-hidden="true" />
            </button>
          )}
        />

        <OrgSwitcher />

        <Menu
          panelLabel="Account"
          align="right"
          items={[
            { label: 'Account settings', icon: UserCog, to: '/account' },
            { label: 'Organization settings', icon: Settings, to: '/settings' },
            { type: 'separator' as const },
            { label: 'Sign out', icon: LogOut, onSelect: () => void logout(), danger: true },
          ]}
          trigger={({ buttonProps }) => (
            <button
              {...buttonProps}
              type="button"
              className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-[var(--panel-2)]"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-[var(--coral)] text-[#2a1320] text-xs font-bold">
                {initials(name, email)}
              </span>
              <span className="hidden lg:flex flex-col items-start leading-tight">
                <span className="text-xs font-medium truncate max-w-[10rem]">{email}</span>
                {organization !== null && (
                  <span className="text-[11px] text-[var(--muted)] truncate max-w-[10rem]">{organization.name}</span>
                )}
              </span>
            </button>
          )}
        />
      </div>
    </header>
  );
}
