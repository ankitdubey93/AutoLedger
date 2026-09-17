import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) helpers, for Google Drive
 * intake (Phase 19.2). PKCE defends the authorization code exchange against
 * interception — even a leaked authorization code is useless without the
 * verifier that only this server ever holds.
 */

/** `bytes` random bytes as base64url — the OAuth `state` and PKCE verifier both use this. */
export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** S256 code_challenge: base64url(SHA-256(verifier)), per RFC 7636. */
export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Plain lowercase hex SHA-256 — used to store only a hash of the OAuth `state`. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
