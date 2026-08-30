/**
 * Keeps a session alive across the 15-minute access-token expiry without the
 * user noticing.
 *
 * When a request comes back 401, this refreshes once and replays the original
 * request. The hard part is concurrency: a dashboard that fires five requests
 * on mount gets five simultaneous 401s, and five parallel refreshes would each
 * rotate the token — four of them then presenting a token the server has
 * already consumed, which the server correctly reads as replay and responds to
 * by killing the whole session. So the refresh is single-flighted: the first
 * 401 starts it, every other waits on the same promise.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

/** Fired when the session cannot be recovered, so AuthContext can reset to anonymous. */
export const AUTH_EXPIRED_EVENT = 'autoledger:auth-expired';

/**
 * The in-flight refresh, or null when none is running. Module-level because
 * the whole point is that every caller in the tab shares one.
 */
let refreshPromise: Promise<boolean> | null = null;

/**
 * Deliberately raw `fetch`, not the wrapper below: routing the refresh through
 * the retry logic would recurse the first time a refresh itself 401s.
 */
async function performRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch {
    // Network failure is not an expired session — the caller retries and gets
    // a normal error rather than being logged out for being offline.
    return false;
  }
}

/** Starts a refresh, or joins the one already running. */
export function refreshSession(): Promise<boolean> {
  // `??=` assigns only when null, so concurrent callers all receive the same
  // promise and the server sees exactly one rotation.
  refreshPromise ??= performRefresh().finally(() => {
    // Cleared in `finally` so a failed refresh does not wedge every future
    // attempt onto a permanently-rejected promise.
    refreshPromise = null;
  });

  return refreshPromise;
}

/** Test seam — resets module state between cases. */
export function resetRefreshState(): void {
  refreshPromise = null;
}

export interface AutoRefreshOptions {
  /**
   * Skips the refresh-and-retry dance. Set for the auth endpoints themselves:
   * a 401 from /auth/login means the password was wrong, and refreshing in
   * response to it would be both useless and confusing.
   */
  skipAuthRefresh?: boolean;
}

/**
 * `fetch`, plus one transparent refresh-and-retry on 401.
 *
 * Caveat: a retried request replays its original `init`. Every body in this
 * app is a JSON string, which is safely re-sendable — a stream or FormData
 * would already be consumed and would need rebuilding per attempt.
 */
export async function fetchWithAutoRefresh(
  url: string,
  init: RequestInit = {},
  options: AutoRefreshOptions = {},
): Promise<Response> {
  const response = await fetch(url, init);

  if (response.status !== 401 || options.skipAuthRefresh === true) {
    return response;
  }

  const refreshed = await refreshSession();

  if (!refreshed) {
    // Announced rather than redirected: a fetch helper has no business
    // navigating. ProtectedRoute reacts to the state change declaratively.
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    return response;
  }

  // Exactly one retry. If this 401s too the session is genuinely gone, and
  // looping would hammer the server with a dead credential.
  const retried = await fetch(url, init);

  if (retried.status === 401) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }

  return retried;
}
