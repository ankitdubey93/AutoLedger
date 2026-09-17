import { createSign } from 'node:crypto';
import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_HTTP_TIMEOUT_MS,
  GOOGLE_TOKEN_URL,
  SERVICE_ACCOUNT_TOKEN_SKEW_MS,
} from '../../config/constants.js';
import { GoogleDriveError, type FetchLike } from './googleDriveClient.js';

/**
 * RFC 7523 JWT-bearer grant for a Google service account — Phase 19.3's
 * recommended way to connect Drive intake, in place of 19.2's OAuth consent
 * flow. No `googleapis` or `google-auth-library` package: `node:crypto` signs
 * the assertion directly (guardrails rule 14; the identical no-SDK precedent
 * `googleDriveClient.ts`'s hand-rolled OAuth already sets).
 *
 * Touches no database and no HTTP request/response — this file must never
 * import `db/connect.js` or `express`. Every network call takes an injectable
 * `fetchImpl` so tests never reach the network.
 */

export interface ServiceAccountConfig {
  /** The `client_email` field of the downloaded service-account JSON key. */
  clientEmail: string;
  /** The `private_key` field — a PKCS#8 PEM, real newlines already restored. */
  privateKeyPem: string;
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Builds the signed JWT assertion RFC 7523 §2.1 sends as the `assertion`
 * parameter. Exported for unit testing; not used outside this file.
 *
 * Deliberately carries no `sub` claim — a `sub` requests domain-wide
 * delegation (impersonating a specific Workspace user), which needs a
 * Workspace super admin to authorize in the Admin console and does not exist
 * for personal Gmail accounts at all. This assertion authenticates as the
 * service account itself; the tenant grants it access by sharing a folder
 * with its address, the same way they would share with any other person.
 */
export function buildAssertion(config: ServiceAccountConfig, nowSeconds: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: config.clientEmail,
    scope: GOOGLE_DRIVE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  // Throws synchronously on a malformed key (wrong PEM type, corrupted
  // base64, etc.) — at call time, never at module import, so the server and
  // worker still boot with no service account configured at all.
  const signature = createSign('RSA-SHA256').update(signingInput).sign(config.privateKeyPem, 'base64url');

  return `${signingInput}.${signature}`;
}

interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * One service account serves every organization, so the cache is keyed by
 * `clientEmail` rather than by org — a 60-second sweep across N orgs mints
 * one token per hour, not N per minute.
 *
 * The map holds the in-flight PROMISE, not the resolved token. Setting it
 * into the map before the mint's first `await` (see getServiceAccountAccessToken
 * below) means every caller issued synchronously back-to-back on a cold cache
 * observes the same pending mint rather than each starting its own — the
 * thundering herd this cache exists to prevent.
 */
const tokenPromises = new Map<string, Promise<CachedToken>>();

async function mintAccessToken(config: ServiceAccountConfig, fetchImpl: FetchLike): Promise<CachedToken> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = buildAssertion(config, nowSeconds);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Status only, never Google's error body — the same token-hygiene
    // posture googleDriveClient.ts's refreshAccessToken takes for the OAuth
    // path (guardrails rule 11).
    throw new GoogleDriveError(
      'HTTP_ERROR',
      `Google service-account token request failed with status ${String(response.status)}`,
    );
  }

  const json = (await response.json()) as { access_token?: string };
  if (json.access_token === undefined) {
    throw new GoogleDriveError('HTTP_ERROR', 'Google service-account token request returned no access token');
  }

  return { accessToken: json.access_token, expiresAt: Date.now() + 3600 * 1000 };
}

/**
 * A Drive access token for the one server-wide service account, minted fresh
 * or served from cache. Refreshed `SERVICE_ACCOUNT_TOKEN_SKEW_MS` before
 * actual expiry so a caller never receives a token that expires mid-request.
 *
 * On expiry, a handful of concurrent callers can each start their own mint —
 * this only single-flights a COLD cache. That is a deliberate simplification:
 * expiry happens roughly once an hour, so a brief herd of a few requests then
 * is not worth the extra bookkeeping a fully race-free re-mint would add.
 */
export async function getServiceAccountAccessToken(
  config: ServiceAccountConfig,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const existing = tokenPromises.get(config.clientEmail);
  if (existing !== undefined) {
    const token = await existing;
    if (Date.now() < token.expiresAt - SERVICE_ACCOUNT_TOKEN_SKEW_MS) {
      return token.accessToken;
    }
  }

  const mintPromise = mintAccessToken(config, fetchImpl);
  tokenPromises.set(config.clientEmail, mintPromise);
  try {
    return (await mintPromise).accessToken;
  } catch (err) {
    // A failed mint must not poison the cache for the next call — only clear
    // the entry if it is still this failed attempt (a concurrent successful
    // re-mint may have already replaced it).
    if (tokenPromises.get(config.clientEmail) === mintPromise) {
      tokenPromises.delete(config.clientEmail);
    }
    throw err;
  }
}

/** Test seam only. */
export function resetServiceAccountTokenCache(): void {
  tokenPromises.clear();
}
