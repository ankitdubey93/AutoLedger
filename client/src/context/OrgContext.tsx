import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { switchOrg as switchOrgRequest } from '../services/fetchServices';
import { useAuth, useAuthActions } from './AuthContext';
import type { Membership, OrganizationSummary, Role, SessionResponse } from '../services/fetchServices';

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
  /** Phase 38c — the active role's display name. */
  roleName: string | null;
  /** Phase 38c — permission keys in the active organization. */
  permissions: ReadonlySet<string>;
  /**
   * Phase 38c — "would the server allow this?" Used to hide controls a
   * member cannot use. Display only: every route re-checks on the server.
   */
  can: (permission: string) => boolean;
  memberships: Membership[];
  switching: boolean;
  error: string | null;
  switchTo: (orgId: string) => Promise<void>;
  /**
   * Phase 37 — adopts a session the server already moved to another
   * organization (create, accept an invitation, leave) exactly as a switch
   * does: new auth state, a remount of org-scoped pages, and the dashboard.
   */
  enterSession: (session: SessionResponse) => void;
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
  const navigate = useNavigate();

  // Phase 37: always land on the dashboard. Staying on the current URL would
  // load a detail page for the previous organization's record under the new
  // one (a 404 at best), and the dashboard is where SetupGate sends a
  // not-yet-set-up organization to its own setup wizard.
  const enterSession = useCallback(
    (session: SessionResponse) => {
      applySession(session);
      setOrgVersion((v) => v + 1);
      navigate('/');
    },
    [applySession, navigate],
  );

  const switchTo = useCallback(
    async (orgId: string) => {
      setSwitching(true);
      setError(null);
      try {
        // The server re-validates membership and rotates BOTH tokens. If it
        // only moved the access token, the next silent refresh would read the
        // stale org off the refresh row and quietly switch back.
        enterSession(await switchOrgRequest(orgId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not switch organization');
      } finally {
        setSwitching(false);
      }
    },
    [enterSession],
  );

  const authenticated = auth.status === 'authenticated' ? auth : null;
  const permissions = useMemo(() => new Set(authenticated?.permissions ?? []), [authenticated?.permissions]);
  const can = useCallback((permission: string) => permissions.has(permission), [permissions]);

  const value: OrgContextValue = {
    organization: authenticated?.organization ?? null,
    role: authenticated?.role ?? null,
    roleName: authenticated?.roleName ?? null,
    permissions,
    can,
    memberships: authenticated?.memberships ?? [],
    switching,
    error,
    switchTo,
    enterSession,
    orgVersion,
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (value === null) throw new Error('useOrg must be used inside <OrgProvider>');
  return value;
}

/**
 * Phase 40 — the active organization's name, or null outside an
 * OrgProvider. For placeholder previews on document forms, which also render
 * in tests and pages that have no provider; a missing name only leaves
 * `[Organisation Name]` unfilled in the preview.
 */
export function useOrganizationName(): string | null {
  return useContext(OrgContext)?.organization?.name ?? null;
}
