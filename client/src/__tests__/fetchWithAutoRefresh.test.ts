import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_EXPIRED_EVENT,
  fetchWithAutoRefresh,
  resetRefreshState,
} from '../utils/fetchWithAutoRefresh';

/**
 * The highest-value client test in Phase 1: it covers the one piece of
 * genuinely concurrent logic, and it needs no DOM at all.
 *
 * The failure it guards against is subtle and expensive. Several requests
 * 401ing at once, each refreshing independently, means several rotations —
 * and the server treats a token that was already rotated as a replayed one and
 * kills the entire session. So a missing single-flight does not show up as a
 * slow page; it shows up as users being randomly logged out.
 */

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ success: status < 400 }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRefreshState();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Requests aimed at the refresh endpoint, as opposed to the original calls. */
function refreshCalls(): unknown[] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/auth/refresh'));
}

describe('fetchWithAutoRefresh', () => {
  it('passes a successful response straight through', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));

    const res = await fetchWithAutoRefresh('http://localhost:5000/api/v1/organizations');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('refreshes once and retries the original request on a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401)) // original
      .mockResolvedValueOnce(jsonResponse(200)) // refresh
      .mockResolvedValueOnce(jsonResponse(200)); // retry

    const res = await fetchWithAutoRefresh('http://localhost:5000/api/v1/organizations');

    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('issues exactly ONE refresh for three concurrent 401s', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/auth/refresh')
          ? jsonResponse(200)
          : // Every non-refresh call 401s first, then succeeds after rotation.
            jsonResponse(refreshCalls().length === 0 ? 401 : 200),
      ),
    );

    const results = await Promise.all([
      fetchWithAutoRefresh('http://localhost:5000/api/v1/a'),
      fetchWithAutoRefresh('http://localhost:5000/api/v1/b'),
      fetchWithAutoRefresh('http://localhost:5000/api/v1/c'),
    ]);

    // The point of the whole module: three 401s, one rotation.
    expect(refreshCalls()).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('does not refresh a second time when the retry also 401s', async () => {
    // The refresh SUCCEEDS, so a retry happens — and that retry 401s too.
    // Without the single-retry rule this recurses until the stack or the
    // server gives out.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401)) // original
      .mockResolvedValueOnce(jsonResponse(200)) // refresh succeeds
      .mockResolvedValueOnce(jsonResponse(401)); // retry 401s anyway

    const res = await fetchWithAutoRefresh('http://localhost:5000/api/v1/organizations');

    expect(res.status).toBe(401);
    expect(refreshCalls()).toHaveLength(1);
    // original + refresh + one retry, and no more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry at all when the refresh itself fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));

    const res = await fetchWithAutoRefresh('http://localhost:5000/api/v1/organizations');

    expect(res.status).toBe(401);
    // No point replaying the original with a credential we just failed to renew.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips the whole dance when skipAuthRefresh is set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));

    // A 401 from /auth/login is a wrong password, not an expired session.
    const res = await fetchWithAutoRefresh(
      'http://localhost:5000/api/v1/auth/login',
      { method: 'POST' },
      { skipAuthRefresh: true },
    );

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('announces an unrecoverable session instead of navigating', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401)) // original
      .mockResolvedValueOnce(jsonResponse(401)); // refresh itself fails

    const onExpired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);

    await fetchWithAutoRefresh('http://localhost:5000/api/v1/organizations');

    // An event, not a redirect: a fetch helper has no business navigating.
    expect(onExpired).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });

  it('allows a later refresh after an earlier one failed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));
    await fetchWithAutoRefresh('http://localhost:5000/api/v1/first');

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200));

    const res = await fetchWithAutoRefresh('http://localhost:5000/api/v1/second');

    // The promise is cleared in `finally`, so one failure does not wedge every
    // future refresh onto a permanently-rejected promise.
    expect(res.status).toBe(200);
  });
});
