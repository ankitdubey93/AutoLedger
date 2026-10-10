import { ApiError } from './apiError.js';
import { fillPlaceholders, type FillMode, type PlaceholderContext, type PlaceholderSurface } from './placeholders.js';

/**
 * Phase 40 — filling one stored document field, with the rules every service
 * shares: the column's length limit is re-checked on the FILLED text (a long
 * contact name can push a description past 500), a required field cannot be
 * filled down to nothing, and the caller learns what the field's `*_template`
 * column should hold (migration 087).
 *
 * Over-long text is refused (422 naming the field) rather than truncated —
 * silently cutting a line description is corrupting a financial document.
 */

export interface FilledField {
  text: string;
  /** The text as written, when filling changed it; null when it did not. */
  template: string | null;
}

export interface FieldRule {
  /** Shown in the 422 — "Line 2's description", "Notes". */
  label: string;
  /** Maximum characters, counted as PostgreSQL's char_length does (code points). */
  max: number;
  /** A NOT NULL / non-blank column: filling it to nothing is a 422. */
  required: boolean;
}

function codePoints(text: string): number {
  return [...text].length;
}

export function fillField(
  raw: string,
  surface: PlaceholderSurface,
  ctx: PlaceholderContext,
  mode: FillMode,
  rule: FieldRule,
): FilledField {
  const text = fillPlaceholders(raw, surface, ctx, mode);
  if (text === raw) return { text, template: null };
  if (codePoints(text) > rule.max) {
    throw new ApiError(422, `${rule.label} is longer than ${String(rule.max)} characters once placeholders are filled`);
  }
  if (rule.required && text.trim() === '') {
    throw new ApiError(422, `${rule.label} is empty once placeholders are filled`);
  }
  return { text, template: raw };
}

/** `fillField` for a nullable column: null stays null. */
export function fillOptionalField(
  raw: string | null,
  surface: PlaceholderSurface,
  ctx: PlaceholderContext,
  mode: FillMode,
  rule: Omit<FieldRule, 'required'>,
): { text: string | null; template: string | null } {
  if (raw === null) return { text: null, template: null };
  const filled = fillField(raw, surface, ctx, mode, { ...rule, required: false });
  // A note filled down to nothing is stored as no note, like an empty form field.
  return { text: filled.text.trim() === '' ? null : filled.text, template: filled.template };
}

export const LINE_DESCRIPTION_MAX = 500;
export const NOTES_MAX = 1000;
export const VENDOR_REFERENCE_MAX = 100;
export const JOURNAL_DESCRIPTION_MAX = 500;
