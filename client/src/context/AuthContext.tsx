import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  checkSession,
  login as loginRequest,
  logout as logoutRequest,
  refreshSessionRequest,
  register as registerRequest,
  type Membership,
  type OrganizationSummary,
  type PublicUser,
  type RegisterInput,
  type Role,
  type SessionResponse,
} from '../services/fetchServices';
import { AUTH_EXPIRED_EVENT } from '../utils/fetchWithAutoRefresh';

/**
 * Session state for the whole app.
 *
 * Modelled as a discriminated union rather than `user | null` plus a separate
 * `loading` boolean, because those two can express states that cannot happen
 * ("loading and also authenticated") and the compiler cannot help you rule
 * them out. Here the three states are exhaustive and mutually exclusive.
 *
 * `checking` being the INITIAL state is the whole trick behind not flashing
 * the login page on reload: the session lives in an httpOnly cookie the
 * JavaScript cannot read, so on boot we genuinely do not know yet, and saying
 * so is more honest than defaulting to "logged out" and correcting a moment
 * later.
 */
export type AuthState =
  | { status: 'checking' }
  | {
      status: 'authenticated';
      user: PublicUser;
      organization: OrganizationSummary | null;
      role: Role | null;
      memberships: Membership[];
      accessTokenExpiresAt: string;
    }
  | { status: 'anonymous' };

interface AuthActions {
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshNow: () => Promise<void>;
  /** Lets OrgContext publish the session that /auth/switch-org returned. */
  applySession: (session: SessionResponse) => void;
}

function toAuthenticated(session: SessionResponse): AuthState {
  return {
    status: 'authenticated',
    user: session.user,
    organization: session.organization,
    role: session.role,
    memberships: session.memberships,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
  };
}

/**
 * Two contexts, not one. Actions are stable for the lifetime of the provider,
 * so a component that only needs `logout` should not re-render every time the
 * session data changes — with a single context it would, because the value
 * object is new on every state change.
 */
const AuthStateContext = createContext<AuthState | null>(null);
const AuthActionsContext = createContext<AuthActions | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'checking' });

  // Restore the session on boot.
  //
  // An `ignore` flag rather than an AbortController. StrictMode double-invokes
  // effects in development, and aborting the discarded first request while its
  // CORS preflight was still in flight made the second request — queued behind
  // that same preflight — fail with a TypeError. Letting the stale response
  // arrive and discarding it is React's documented pattern and has no such
  // race. (Aborting is still right for genuinely expensive requests.)
  useEffect(() => {
    let ignore = false;

    checkSession()
      .then((session) => {
        if (!ignore) setState(toAuthenticated(session));
      })
      .catch(() => {
        // Any failure here — 401, network, malformed — means no usable
        // session. The important part is that we always leave `checking`,
        // because a stuck spinner is worse than a login page.
        if (!ignore) setState({ status: 'anonymous' });
      });

    return () => {
      ignore = true;
    };
  }, []);

  // The auto-refresh wrapper announces an unrecoverable 401 rather than
  // navigating, so the reaction lives here and the routing stays declarative.
  useEffect(() => {
    const onExpired = () => setState({ status: 'anonymous' });
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const actions = useMemo<AuthActions>(
    () => ({
      login: async (email, password) => {
        setState(toAuthenticated(await loginRequest(email, password)));
      },
      register: async (input) => {
        // Register deliberately does not issue a session, so log in straight
        // after — the user experiences one action, not two.
        await registerRequest(input);
        setState(toAuthenticated(await loginRequest(input.email, input.password)));
      },
      logout: async () => {
        try {
          await logoutRequest();
        } finally {
          // Even if the request fails, the local session must end — otherwise
          // "log out" visibly does nothing.
          setState({ status: 'anonymous' });
        }
      },
      refreshNow: async () => {
        setState(toAuthenticated(await refreshSessionRequest()));
      },
      applySession: (session) => setState(toAuthenticated(session)),
    }),
    [],
  );

  return (
    <AuthStateContext.Provider value={state}>
      <AuthActionsContext.Provider value={actions}>{children}</AuthActionsContext.Provider>
    </AuthStateContext.Provider>
  );
}

/* --------------------------------------------------------------------- hooks */

export function useAuth(): AuthState {
  const state = useContext(AuthStateContext);
  // A null context means the hook escaped its provider — a clear message here
  // beats a confusing "cannot read property of null" three components away.
  if (state === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return state;
}

export function useAuthActions(): AuthActions {
  const actions = useContext(AuthActionsContext);
  if (actions === null) throw new Error('useAuthActions must be used inside <AuthProvider>');
  return actions;
}

/** Convenience for the many components that only render when authenticated. */
export function useCurrentUser() {
  const state = useAuth();
  return state.status === 'authenticated' ? state : null;
}

// Exported for the test that asserts the provider leaves `checking`.
export { AuthStateContext };
