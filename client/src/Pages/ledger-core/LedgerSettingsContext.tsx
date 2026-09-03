import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getLedgerSettings, type LedgerSettings } from '../../services/fetchServices';

/**
 * LedgerCore's own settings state, scoped to this app's subtree rather than
 * the whole platform (mirrors context/AuthContext.tsx's discriminated-union
 * shape, one layer down).
 *
 * `loading` is the true initial state — there is no cached default, since a
 * missing `ledger_settings` row is a legitimate answer ("not yet onboarded"),
 * not an error.
 */
export type LedgerSettingsState =
  | { status: 'loading' }
  | { status: 'ready'; settings: LedgerSettings }
  | { status: 'error'; message: string };

interface LedgerSettingsActions {
  refresh: () => Promise<void>;
  /** Lets the onboarding wizard and the settings form update in place without a refetch. */
  applySettings: (settings: LedgerSettings) => void;
}

const LedgerSettingsContext = createContext<(LedgerSettingsState & LedgerSettingsActions) | null>(null);

export function LedgerSettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LedgerSettingsState>({ status: 'loading' });

  function toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : 'Failed to load LedgerCore settings';
  }

  // An `ignore` flag rather than an AbortController — StrictMode's double
  // invocation of this effect otherwise races the CORS preflight, exactly the
  // bug documented in services/fetchServices.ts and worked around the same
  // way in context/AuthContext.tsx.
  useEffect(() => {
    let ignore = false;

    getLedgerSettings()
      .then((settings) => {
        if (!ignore) setState({ status: 'ready', settings });
      })
      .catch((err: unknown) => {
        if (!ignore) setState({ status: 'error', message: toErrorMessage(err) });
      });

    return () => {
      ignore = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const settings = await getLedgerSettings();
      setState({ status: 'ready', settings });
    } catch (err) {
      setState({ status: 'error', message: toErrorMessage(err) });
    }
  }, []);

  const applySettings = useCallback((settings: LedgerSettings) => {
    setState({ status: 'ready', settings });
  }, []);

  const value = useMemo<LedgerSettingsState & LedgerSettingsActions>(
    () => ({ ...state, refresh, applySettings }),
    [state, refresh, applySettings],
  );

  return <LedgerSettingsContext.Provider value={value}>{children}</LedgerSettingsContext.Provider>;
}

export function useLedgerSettings(): LedgerSettingsState & LedgerSettingsActions {
  const value = useContext(LedgerSettingsContext);
  if (value === null) {
    throw new Error('useLedgerSettings must be used inside <LedgerSettingsProvider>');
  }
  return value;
}
