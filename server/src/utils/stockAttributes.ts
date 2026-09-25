import type { StockAttributeDefinition, StockAttributes } from '../types/inventory.js';

/**
 * Inventory (Phase 28) — validates a category's user-defined custom
 * fields. A pure function of its arguments: no database import, no
 * `ApiError`. It returns a result and never throws, mirroring
 * `utils/stockCodePattern.ts`.
 *
 * `definitions` is the ACTIVE definitions for one category and one scope
 * (ITEM or SERIAL) — the caller (`itemService`, `movementService`,
 * `serialService`) is responsible for loading the right slice. `input` is
 * the whole attributes object from the request body: a PATCH **replaces**
 * the object, it never merges, so every definition is checked against
 * `input` fresh every time.
 *
 * Every rule collects into one `errors` array rather than stopping at the
 * first problem — a client with three bad fields should not need three
 * round trips to discover them (the same reasoning `utils/parseBody.ts`
 * gives for reporting every zod issue at once).
 */

export type AttributeValidation = { ok: true; value: StockAttributes } | { ok: false; errors: string[] };

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER_SHAPE = /^-?\d{1,12}(\.\d+)?$/;

/** Rejects a string that merely looks like a date, e.g. 2026-02-30. */
function isRealDate(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function validateAttributes(
  definitions: readonly StockAttributeDefinition[],
  input: Record<string, unknown>,
): AttributeValidation {
  const errors: string[] = [];
  const byKey = new Map(definitions.map((def) => [def.key, def]));

  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) errors.push(`Unknown attribute "${key}"`);
  }

  const value: StockAttributes = {};

  for (const def of definitions) {
    const raw = input[def.key];
    const isAbsent = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0);

    if (isAbsent) {
      if (def.isRequired) errors.push(`Attribute "${def.label}" is required`);
      continue;
    }

    switch (def.dataType) {
      case 'TEXT': {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        if (typeof raw !== 'string' || trimmed.length < 1 || trimmed.length > 200) {
          errors.push(`Attribute "${def.label}" must be text of at most 200 characters`);
          break;
        }
        value[def.key] = trimmed;
        break;
      }
      case 'NUMBER': {
        const decimalPlaces = def.decimalPlaces ?? 0;
        const message = `Attribute "${def.label}" must be a number with at most ${decimalPlaces} decimal places`;
        // A JS number is rejected outright — floats are never accepted (rule 3);
        // only a canonical decimal string is a valid NUMBER attribute value.
        if (typeof raw !== 'string') {
          errors.push(message);
          break;
        }
        const trimmed = raw.trim();
        const shapeMatch = NUMBER_SHAPE.test(trimmed);
        const fractionDigits = trimmed.includes('.') ? (trimmed.split('.')[1]?.length ?? 0) : 0;
        if (!shapeMatch || fractionDigits > decimalPlaces) {
          errors.push(message);
          break;
        }
        value[def.key] = trimmed;
        break;
      }
      case 'DATE': {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        if (typeof raw !== 'string' || !isRealDate(trimmed)) {
          errors.push(`Attribute "${def.label}" must be a date (YYYY-MM-DD)`);
          break;
        }
        value[def.key] = trimmed;
        break;
      }
      case 'BOOLEAN': {
        if (typeof raw !== 'boolean') {
          errors.push(`Attribute "${def.label}" must be true or false`);
          break;
        }
        value[def.key] = raw;
        break;
      }
      case 'SELECT': {
        const options = def.options ?? [];
        if (typeof raw !== 'string' || !options.includes(raw)) {
          errors.push(`Attribute "${def.label}" must be one of: ${options.join(', ')}`);
          break;
        }
        value[def.key] = raw;
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}
