import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../utils/jwt.js';
import { ApiError } from '../utils/apiError.js';
import { env } from '../config/env.js';

/** Unit tier — signing and verification are pure, so no database is involved. */

const user = { id: 'cb1f9a90-3f57-4a0c-9d4e-1c5cbb2f2a11', orgId: 'org-1', role: 'OWNER' } as const;

describe('access tokens', () => {
  it('round-trips the id, active org and role', () => {
    expect(verifyAccessToken(signAccessToken(user))).toEqual(user);
  });

  it('rejects a token signed with the refresh key', () => {
    // The whole reason env.ts refuses to boot when the two secrets match: if
    // they were equal, this would verify and a 7-day refresh token would
    // become an unlimited-lifetime access token.
    const forged = jwt.sign({ sub: user.id, orgId: 'x', role: 'OWNER' }, env.REFRESH_TOKEN_SECRET);
    expect(() => verifyAccessToken(forged)).toThrow(ApiError);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: user.id, orgId: 'x', role: 'OWNER' }, env.ACCESS_TOKEN_SECRET, {
      expiresIn: '-1s',
    });
    expect(() => verifyAccessToken(expired)).toThrow(/Invalid or expired/);
  });

  it('rejects a correctly-signed token carrying an unknown role', () => {
    // Signed by us, so the signature passes — but a role outside the four
    // would otherwise flow straight into requireRole comparisons.
    const odd = jwt.sign(
      { sub: user.id, orgId: 'x', role: 'SUPERUSER' },
      env.ACCESS_TOKEN_SECRET,
    );
    expect(() => verifyAccessToken(odd)).toThrow(/Malformed/);
  });

  it('rejects a token with no orgId', () => {
    // A missing active org must never become `undefined` in a query's scope.
    const noOrg = jwt.sign({ sub: user.id, role: 'OWNER' }, env.ACCESS_TOKEN_SECRET);
    expect(() => verifyAccessToken(noOrg)).toThrow(/Malformed/);
  });
});

describe('refresh tokens', () => {
  it('round-trips the user and active org', () => {
    const claims = verifyRefreshToken(signRefreshToken(user.id, 'org-9'));
    expect(claims.userId).toBe(user.id);
    expect(claims.orgId).toBe('org-9');
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives two tokens issued in the same second different values', () => {
    // Without jwtid these would be byte-identical — same payload, same `iat` —
    // and the second login would hit a UNIQUE violation on token_hash.
    const a = signRefreshToken(user.id, 'org-1');
    const b = signRefreshToken(user.id, 'org-1');

    expect(a).not.toBe(b);
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });

  it('rejects a token signed with the access key', () => {
    const forged = jwt.sign({ sub: user.id, orgId: null }, env.ACCESS_TOKEN_SECRET);
    expect(() => verifyRefreshToken(forged)).toThrow(ApiError);
  });
});

describe('hashRefreshToken', () => {
  it('is a stable 64-character sha256 hex digest', () => {
    // Fast hash on purpose: the token is a high-entropy random value, so
    // bcrypt would cost a lot and buy nothing.
    const token = signRefreshToken(user.id, null);
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('does not contain the token itself', () => {
    // A database dump must not yield usable sessions.
    const token = signRefreshToken(user.id, null);
    expect(hashRefreshToken(token)).not.toContain(token.slice(0, 20));
  });
});
