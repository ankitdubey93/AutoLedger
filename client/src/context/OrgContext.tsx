import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { switchOrg as switchOrgRequest } from '../services/fetchServices';
import { useAuth, useAuthActions } from './AuthContext';
import type { Membership, OrganizationSummary, Role } from '../services/fetchServices';

/**
 * The active organization and the switcher.
 *
 * There is deliberately no local copy of the active org here. It is derived
 * from AuthContext, because the authority is the signed access token and
 * mirroring it into a second piece of state is how the two drift apart.
 * Switching organizations is therefore a server round trip that re-issues the
 * token, not a client-side selection.
 */

interface OrgContextValue {
  organization: OrganizationSummary | null;
  role: Role | null;
  memberships: Membership[];
  switching: boolean;
  error: string | null;
  switchTo: (orgId: string) => Promise<void>;
  /**
   * Increments on every successful switch. Components key their org-scoped
   * subtrees on it so they remount and refetch, rather than showing the
   * previous tenant's data until some effect happens to re-run. Cache
   * invalidation, done by identity rather than by manual cache-busting.
   */
  orgVersion: number;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { applySession } = useAuthActions();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgVersion, setOrgVersion] = useState(0);

  const switchTo = useCallback(
    async (orgId: string) => {
      setSwitching(true);
      setError(null);
      try {
        // The server re-validates membership and rotates BOTH tokens. If it
        // only moved the access token, the next silent refresh would read the
        // stale org off the refresh row and quietly switch back.
        const session = await switchOrgRequest(orgId);
        applySession(session);
        setOrgVersion((v) => v + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not switch organization');
      } finally {
        setSwitching(false);
      }
    },
    [applySession],
  );

  const authenticated = auth.status === 'authenticated' ? auth : null;

  const value: OrgContextValue = {
    organization: authenticated?.organization ?? null,
    role: authenticated?.role ?? null,
    memberships: authenticated?.memberships ?? [],
    switching,
    error,
    switchTo,
    orgVersion,
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (value === null) throw new Error('useOrg must be used inside <OrgProvider>');
  return value;
}
