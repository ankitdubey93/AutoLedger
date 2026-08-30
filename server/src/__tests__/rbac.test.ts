import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requireRole } from '../middleware/rbac.js';
import { requireUser } from '../utils/requireUser.js';
import { ApiError } from '../utils/apiError.js';
import type { AuthUser } from '../types/auth.js';

/**
 * Unit tier. Middleware is a decision point, not plumbing, so it is worth
 * testing directly rather than only through the routes that happen to use it.
 */

function fakeRequest(user?: AuthUser): Request {
  return (user === undefined ? {} : { user }) as Request;
}

/**
 * Middleware signals failure by passing an error to next(), not by throwing.
 *
 * A plain closure rather than `vi.fn<NextFunction>()`: Express types
 * NextFunction with an overload taking the literal `'router'`, which a generic
 * mock cannot satisfy. Capturing the argument by hand is simpler and typechecks.
 */
function runRole(allowed: Parameters<typeof requireRole>, user?: AuthUser): unknown {
  let captured: unknown;
  const next = ((err?: unknown) => {
    captured = err;
  }) as NextFunction;

  requireRole(...allowed)(fakeRequest(user), {} as Response, next);
  return captured;
}

const owner: AuthUser = { id: 'u1', orgId: 'o1', role: 'OWNER' };
const viewer: AuthUser = { id: 'u2', orgId: 'o1', role: 'VIEWER' };

describe('requireRole', () => {
  it('calls next() with no argument for an allowed role', () => {
    expect(runRole(['OWNER', 'ADMIN'], owner)).toBeUndefined();
  });

  it('rejects a role that is not listed with 403', () => {
    const err = runRole(['OWNER', 'ADMIN'], viewer);
    expect(err).toBeInstanceOf(ApiError);
    // 403, not 404: they are authenticated, just not permitted. Hiding the
    // route's existence is not the goal here.
    expect((err as ApiError).status).toBe(403);
  });

  it('rejects an unauthenticated caller with 401, not 403', () => {
    // The distinction matters to the client: 401 is recoverable by logging in,
    // 403 is not, and the UI reacts differently to each.
    const err = runRole(['OWNER'], undefined);
    expect((err as ApiError).status).toBe(401);
  });

  it('names the required roles so the client can explain the refusal', () => {
    const err = runRole(['OWNER', 'ADMIN'], viewer);
    expect((err as ApiError).message).toMatch(/OWNER, ADMIN/);
    expect((err as ApiError).message).toMatch(/VIEWER/);
  });
});

describe('requireUser', () => {
  it('returns the user when present', () => {
    expect(requireUser(fakeRequest(owner))).toEqual(owner);
  });

  it('throws 401 rather than returning undefined', () => {
    // This is the whole point: a route accidentally mounted without the auth
    // middleware becomes a clean 401 instead of a TypeError on `.orgId`.
    try {
      requireUser(fakeRequest(undefined));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
    }
  });
});
