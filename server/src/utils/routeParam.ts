import type { Request } from 'express';
import { ApiError } from './apiError.js';

/**
 * Narrows a route parameter from `string | string[] | undefined` to `string`.
 *
 * Express 5 types `req.params` values as a union with `string[]`, because a
 * wildcard segment (`/*splat`) genuinely produces an array. A `:id` segment
 * never does — but the compiler cannot tell the two apart from the type alone,
 * and the tempting shortcut is `req.params.id as string`.
 *
 * That cast is a promise the compiler cannot check. This turns the same
 * mistake into a clean 400 instead, in one place, for the same reason
 * `requireUser` exists rather than `req.user!`.
 */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, `Missing route parameter "${name}"`);
  }
  return value;
}
