import { parseMoneyText } from './money.js';
import { parseFlexibleDate, type DateFormat } from './dateParse.js';

export type ImportCellType = 'text' | 'money' | 'percent' | 'quantity' | 'date' | 'enum' | 'signedMoney';
export type ParsedCell = { ok: true; value: string | number | null } | { ok: false; error: string };

/** Structural subset of ImportColumnDef this module needs (keeps utils free of types/accounting). */
export interface CellSpec {
  label: string;
  type: ImportCellType;
  maxLength: number | null;
  /** lowercase alias -> canonical value; enum only. */
  enumAliases: Readonly<Record<string, string>> | null;
  /** What to show in the error, e.g. ['Service', 'Non-inventory']; enum only. */
  enumLabels: readonly string[] | null;
}

const FORMAT_HINT: Record<DateFormat, string> = {
  ISO: 'YYYY-MM-DD',
  DMY: 'DD/MM/YYYY',
  MDY: 'MM/DD/YYYY',
};

const ZERO_WORDS = ['exempt', 'tax exempt', 'no tax', 'none', 'zero rated', 'zero-rated', 'n/a'];

/**
 * '10' '10%' '12.5 %' 'GST on Income (15%)' -> bp; zero words -> 0; else null.
 * Max 2 decimals, 0..10000 bp. Integer arithmetic only.
 */
export function parsePercentBp(text: string): number | null {
  const trimmed = text.trim().toLowerCase();

  // Check for zero words
  if (ZERO_WORDS.includes(trimmed) || trimmed.includes('exempt')) {
    return 0;
  }

  // Try to find a percentage anywhere in the text
  const percentMatch = /(\d+)(?:\.(\d{1,2}))?\s*%/.exec(text);
  if (percentMatch) {
    const intPart = percentMatch[1] ?? '';
    const fracPart = percentMatch[2] ?? '';
    const bp = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
    if (bp <= 10000) {
      return bp;
    }
    return null;
  }

  // Try to match the whole text as a number
  const numberMatch = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (numberMatch) {
    const intPart = numberMatch[1] ?? '';
    const fracPart = numberMatch[2] ?? '';
    const bp = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
    if (bp <= 10000) {
      return bp;
    }
    return null;
  }

  return null;
}

/**
 * '12' '12.5' '1,250.125' -> milli-units (int). Max 3 decimals, 0..1_000_000_000.
 * Negative/garbage -> null. Integer arithmetic only.
 */
export function parseQuantityMilli(text: string): number | null {
  let trimmed = text.trim();

  // Remove commas only when the text matches the thousands-grouping pattern
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    trimmed = trimmed.replace(/,/g, '');
  }

  // Now require the pattern
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const intPart = match[1] ?? '';
  const fracPart = match[2] ?? '';
  const milli = Number(intPart) * 1000 + Number(fracPart.padEnd(3, '0'));

  if (milli > 1_000_000_000) {
    return null;
  }

  return milli;
}

export function parseImportCell(spec: CellSpec, text: string, dateFormat: DateFormat): ParsedCell {
  const trimmed = text.trim();

  // Empty result gives { ok: true, value: null } for every type
  if (trimmed === '') {
    return { ok: true, value: null };
  }

  switch (spec.type) {
    case 'text': {
      if (spec.maxLength !== null && trimmed.length > spec.maxLength) {
        return {
          ok: false,
          error: `${spec.label} is longer than ${spec.maxLength} characters`,
        };
      }
      return { ok: true, value: trimmed };
    }

    case 'signedMoney':
    case 'money': {
      // parseMoneyText strips a trailing 3-letter currency code, so a digit-free
      // word like "abc" would otherwise parse as 0. Only "-", an em dash and
      // "n/a" (its own zero spellings) may lack a digit.
      if (!/\d/.test(trimmed) && !/^(-|—|n\/a)$/i.test(trimmed)) {
        return { ok: false, error: `${spec.label} "${text}" is not an amount` };
      }
      try {
        const cents = parseMoneyText(text);
        if (cents < 0 && spec.type === 'money') {
          return {
            ok: false,
            error: `${spec.label} cannot be negative`,
          };
        }
        return { ok: true, value: cents };
      } catch {
        return {
          ok: false,
          error: `${spec.label} "${text}" is not an amount`,
        };
      }
    }

    case 'percent': {
      const bp = parsePercentBp(trimmed);
      if (bp === null) {
        return {
          ok: false,
          error: `${spec.label} "${text}" is not a percentage like 10 or 12.5%`,
        };
      }
      return { ok: true, value: bp };
    }

    case 'quantity': {
      const milli = parseQuantityMilli(trimmed);
      if (milli === null) {
        return {
          ok: false,
          error: `${spec.label} "${text}" is not a quantity (up to 3 decimal places)`,
        };
      }
      return { ok: true, value: milli };
    }

    case 'date': {
      const iso = parseFlexibleDate(text, dateFormat);
      if (iso === null) {
        return {
          ok: false,
          error: `${spec.label} "${text}" is not a date in ${FORMAT_HINT[dateFormat]} format`,
        };
      }
      return { ok: true, value: iso };
    }

    case 'enum': {
      const canonical = spec.enumAliases?.[trimmed.toLowerCase()];
      if (canonical !== undefined) {
        return { ok: true, value: canonical };
      }
      const labels = spec.enumLabels ?? [];
      return {
        ok: false,
        error: `${spec.label} "${text}" must be one of: ${labels.join(', ')}`,
      };
    }
  }
}

/**
 * Given non-empty date cell texts: all /^\d{4}-\d{2}-\d{2}$/ (or none given) -> 'ISO';
 * any d/m/y-shaped value whose first part > 12 -> 'DMY';
 * else any whose second part > 12 -> 'MDY'; else null (ambiguous).
 * Separators / - .
 */
export function suggestDateFormat(samples: readonly string[]): DateFormat | null {
  if (samples.length === 0) {
    return 'ISO';
  }

  // Trim and filter empty strings
  const trimmed = samples.map((s) => s.trim()).filter((s) => s !== '');

  if (trimmed.length === 0) {
    return 'ISO';
  }

  // Check if all match ISO format
  const allISO = trimmed.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (allISO) {
    return 'ISO';
  }

  // Check for DMY or MDY pattern
  const parts = trimmed.map((s) => s.split(/[-/.]/));

  // Check if any first part > 12 (implies DMY)
  if (parts.some((p) => p.length === 3 && Number(p[0]) > 12)) {
    return 'DMY';
  }

  // Check if any second part > 12 (implies MDY)
  if (parts.some((p) => p.length === 3 && Number(p[1]) > 12)) {
    return 'MDY';
  }

  // Ambiguous
  return null;
}
