import type { ZodType } from 'zod';
import { ApiError } from './apiError.js';

/**
 * The bridge between zod and this codebase's one client-visible error type.
 *
 * Phase 1's routes take flat objects of five scalars, which the hand-rolled
 * `utils/validate.ts` covers clearly. LedgerCore's journal entries take a nested
 * `lines[]` array with cross-field rules ("exactly one of debit or credit"),
 * which is the revisit trigger recorded in docs/development.md. Both coexist
 * deliberately: this is an addition, not a rewrite of the auth routes.
 *
 * The value of `parse` over `validate` is that the return type is *narrowed*.
 * A validator returns a boolean and leaves you holding the same `unknown`; a
 * parser hands back a value the compiler knows the shape of, so there is no
 * `as` cast at the boundary and no way to forget one.
 *
 * See study/typescript/runtime-validation-and-zod.md.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  // Report every failure at once. Returning only the first means a client with
  // three bad fields makes three round trips to discover them, which is the
  // same reasoning behind config/env.ts reporting all missing variables at once.
  const detail = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  throw new ApiError(400, `Invalid request body: ${detail}`);
}
