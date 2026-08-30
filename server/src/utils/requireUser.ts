import type { Request } from 'express';
import { ApiError } from './apiError.js';
import type { AuthUser } from '../types/auth.js';

/**
 * Narrows `req.user` from `AuthUser | undefined` to `AuthUser`.
 *
 * `req.user` has to be optional on the type, because it genuinely is absent on
 * public routes. The tempting shortcut in a protected controller is
 * `req.user!` — but that assertion is a promise the compiler cannot check, and
 * a route accidentally mounted without the auth middleware would turn into
 * `Cannot read properties of undefined` at runtime, on a request that should
 * have been a clean 401.
 *
 * This turns that same mistake into the correct HTTP response, in one place.
 * Every protected controller starts with `const user = requireUser(req);`.
 */
export function requireUser(req: Request): AuthUser {
  if (req.user === undefined) {
    throw new ApiError(401, 'Authentication required');
  }
  return req.user;
}
