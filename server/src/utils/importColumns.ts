import { ApiError } from './apiError.js';
import type { ImportColumnDef } from '../types/accounting.js';

/**
 * Column header normalization for matching.
 * 'Contact Name*', '*ContactName', 'contact_name' all -> 'contactname'.
 */
export function compactHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Column key -> header index (or null). Every key in `columns` appears in the result.
 *
 * Pass 1 (explicit): for each [key, header] in `columnMap` (skip when columnMap is null):
 *   - key not in columns -> ApiError(400, `Unknown column "${key}" for a ${kindLabel} import`)
 *   - header === null -> result[key] = null
 *   - idx = headers.findIndex(h => h.trim() === header.trim()); -1 ->
 *       ApiError(400, `The file has no column named "${header}"`)
 *   - idx already claimed -> ApiError(400, `Column "${header}" is mapped to more than one field`)
 *   - claim idx; result[key] = idx
 *
 * Pass 2 (automatic), in `columns` order, for keys not set in pass 1:
 *   candidates = [compactHeader(col.header), ...col.synonyms.map(compactHeader)]
 *   for each candidate in order: first header index j with compactHeader(headers[j]) === candidate
 *   and j not claimed -> claim j, result[key] = j, stop. None -> result[key] = null.
 */
export function resolveColumnIndexes(
  headers: readonly string[],
  columns: readonly ImportColumnDef[],
  columnMap: Readonly<Record<string, string | null>> | null,
  kindLabel: string,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const claimed = new Set<number>();

  // Build a key -> column map for quick lookup
  const columnsByKey = new Map(columns.map((col) => [col.key, col]));

  // Pass 1: explicit mapping
  if (columnMap !== null) {
    for (const [key, header] of Object.entries(columnMap)) {
      // Check if key exists in columns
      if (!columnsByKey.has(key)) {
        throw new ApiError(400, `Unknown column "${key}" for a ${kindLabel} import`);
      }

      if (header === null) {
        result[key] = null;
      } else {
        // Find the header in the file (exact trim match)
        const idx = headers.findIndex((h) => h.trim() === header.trim());
        if (idx === -1) {
          throw new ApiError(400, `The file has no column named "${header}"`);
        }
        if (claimed.has(idx)) {
          throw new ApiError(400, `Column "${header}" is mapped to more than one field`);
        }
        claimed.add(idx);
        result[key] = idx;
      }
    }
  }

  // Pass 2: automatic matching
  for (const col of columns) {
    if (result[col.key] !== undefined) {
      // Already mapped explicitly
      continue;
    }

    // Build candidates: template header first, then synonyms
    const candidates = [compactHeader(col.header), ...col.synonyms.map(compactHeader)];

    let found = false;
    for (const candidate of candidates) {
      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        if (header !== undefined && !claimed.has(j) && compactHeader(header) === candidate) {
          claimed.add(j);
          result[col.key] = j;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      result[col.key] = null;
    }
  }

  return result;
}

/**
 * Keys in rejection order: every `required` column whose index is null, in column order;
 * then, if requiredOneOf is non-empty and no set has every key non-null, the keys of the
 * FIRST set whose index is null.
 */
export function findMissingRequired(
  columns: readonly ImportColumnDef[],
  requiredOneOf: readonly (readonly string[])[],
  resolved: Readonly<Record<string, number | null>>,
): string[] {
  const missing: string[] = [];

  // First: required columns with null indices, in column order
  for (const col of columns) {
    if (col.required && resolved[col.key] === null) {
      missing.push(col.key);
    }
  }

  // Then: check requiredOneOf sets
  if (requiredOneOf.length > 0) {
    // Check if at least one set is fully mapped
    let anySetFullyMapped = false;
    let firstUnmappedSet: readonly string[] | null = null;

    for (const set of requiredOneOf) {
      const fullyMapped = set.every((key) => resolved[key] !== null);
      if (fullyMapped) {
        anySetFullyMapped = true;
        break;
      }
      if (firstUnmappedSet === null) {
        firstUnmappedSet = set;
      }
    }

    if (!anySetFullyMapped && firstUnmappedSet !== null) {
      // Find the keys in the first unmapped set that are null
      for (const key of firstUnmappedSet) {
        if (resolved[key] === null) {
          missing.push(key);
        }
      }
    }
  }

  return missing;
}
