import { ApiRequestError } from '../../services/fetchServices';

/**
 * Product codes derived from a name (`Web design` → `WEB-DESIGN`) so the
 * common case never asks for one. The result also fits Inventory's stock-code
 * grammar (A-Z, 0-9, dashes), so the same code works for a tracked product.
 */
export function deriveItemCode(name: string): string {
  const code = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return code === '' ? 'ITEM' : code;
}

const MAX_CODE_ATTEMPTS = 6;

/**
 * Runs `create` with `base`, and — only when the code was derived, never when
 * the person typed it — retries with `-2`, `-3` … while the server answers
 * 409 (code taken). Rethrows anything else, and a 409 on a typed code, as a
 * readable Error.
 */
export async function createWithCodeRetry<T>(
  base: string,
  derived: boolean,
  create: (code: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 36)}-${String(attempt)}`;
    try {
      return await create(candidate);
    } catch (err: unknown) {
      const taken = err instanceof ApiRequestError && err.status === 409;
      if (taken && derived && attempt < MAX_CODE_ATTEMPTS) continue;
      if (taken) throw new Error(`The code ${candidate} is already used — choose another`);
      throw err;
    }
  }
}
