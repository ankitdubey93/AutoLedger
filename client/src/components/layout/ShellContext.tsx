import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const COLLAPSE_KEY = 'autoledger.sidebarCollapsed';

interface ShellContextValue {
  /** The desktop sidebar is collapsed to an icon rail. Persisted per browser. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** The mobile off-canvas drawer is open. Never persisted — always closed on load. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /** The ⌘K command palette is open. */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

// A real, working default (not a "throw outside provider" placeholder) —
// tests that render an app's route tree directly (ledgerCoreNavigation.test
// and friends), without going through AppFrame, get an inert but fully
// functional shell: expanded sidebar, closed drawer, closed palette, and
// toggles that are simply no-ops. That is also exactly what a page rendered
// outside the workspace (there are none today) would want.
const ShellContext = createContext<ShellContextValue>({
  collapsed: false,
  toggleCollapsed: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
  paletteOpen: false,
  openPalette: () => {},
  closePalette: () => {},
});

/**
 * Shell chrome state — sidebar collapse, the mobile drawer, and the command
 * palette — shared between AppTopBar (which has the toggle buttons) and
 * AppSidebar / CommandPalette (which render the state). Mounted once by
 * AppFrame and once by PlatformLayout, each wrapping its own header + main,
 * so the two never share a drawer or palette instance.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredCollapsed());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // in-memory state still applies for this session
      }
      return next;
    });
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Ctrl/⌘+B toggles the sidebar, Ctrl/⌘+K opens the palette — both are
  // workspace-wide, so the listener lives at the provider rather than in
  // each consumer.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleCollapsed();
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((was) => !was);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCollapsed]);

  const value: ShellContextValue = {
    collapsed,
    toggleCollapsed,
    mobileOpen,
    setMobileOpen,
    paletteOpen,
    openPalette,
    closePalette,
  };

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}
