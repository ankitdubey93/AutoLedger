import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'autoledger.theme';

interface ThemeContextValue {
  /** What the person chose. 'system' means "follow the OS", never a fixed value. */
  theme: Theme;
  /** What is actually painted right now — 'system' resolved against the OS preference. */
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

// A real (non-null) default, not the usual "throw if used outside a
// provider" pattern the other contexts use. AppTopBar and PlatformLayout —
// which many existing tests render directly, without a full provider tree —
// consume useTheme() for the theme-toggle menu, and this default lets them
// keep doing that. It is inert: 'system' with a no-op setter, matching what
// index.css already renders with no JS at all.
const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolvedTheme: 'dark',
  setTheme: () => {},
});

/** Never throws: localStorage can be unavailable (private browsing, blocked storage). */
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** jsdom (this project's test environment) does not implement matchMedia at all. */
function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
}

/**
 * The runtime half of the theme system that `index.html`'s inline script
 * starts before first paint (see the comment there). This provider is the
 * only thing that writes `data-theme` and localStorage after mount — the
 * inline script never runs again once React has taken over.
 *
 * 'system' is stored as the ABSENCE of the localStorage key and the ABSENCE
 * of `data-theme`, so index.css's `@media (prefers-color-scheme)` block does
 * the resolving with zero JS in that case, both before and after hydration.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : theme,
  );

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
      setResolvedTheme(systemPrefersLight() ? 'light' : 'dark');
    } else {
      root.setAttribute('data-theme', theme);
      setResolvedTheme(theme);
    }
  }, [theme]);

  // While following the system, keep resolvedTheme (used by the theme-toggle
  // icon) in sync if the OS preference changes underneath us.
  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => setResolvedTheme(media.matches ? 'light' : 'dark');
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can throw (quota, private mode); the in-memory state above
      // still applies for the rest of this session.
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
