/**
 * StockLedger (Phase 28) — the item-code pattern engine. A pure function of
 * its arguments: no database import, no `ApiError`, no I/O. It returns
 * results and never throws, mirroring `utils/uniteconPvm.ts` and
 * `utils/forecasterBuild.ts`.
 *
 * GRAMMAR. A pattern is 1–60 characters made of literals and tokens.
 *
 *   - Literal characters: A–Z, 0–9, - _ / . (lower-case and spaces are
 *     invalid — the render step upper-cases attribute values, so a lower-case
 *     literal would silently never match what actually gets generated).
 *   - {CAT}          the category code
 *   - {YYYY}         the 4-digit UTC year of the render context's date
 *   - {YY}           the 2-digit UTC year
 *   - {ATTR:key:n}   an item-level attribute value, sanitized and truncated
 *                     to n characters (1–10). key matches ^[a-z][a-z0-9_]{0,39}$
 *   - {SEQ:n}        the sequence number, zero-padded to n digits (3–8)
 *
 * Exactly one {SEQ:n} is required — it is what makes a scheme a *counter*,
 * not a fixed label. Any other {…} is invalid.
 *
 * ATTR rendering: convert the raw value to a string (true → 'Y', false →
 * 'N', a YYYY-MM-DD date string → YYYYMMDD, anything else used as-is),
 * upper-case it, delete every character outside [A-Z0-9], then keep the
 * first n characters. An empty result after that is an error — a code
 * scheme cannot silently drop the very information it was configured to
 * encode.
 *
 * Every rendered code (not the scope key — see below) must match
 * ITEM_CODE_REGEX, which is also `stock_items.code`'s CHECK constraint and
 * the 40-character cap.
 */

export const CODE_PATTERN_MAX_LENGTH = 60;
export const ITEM_CODE_REGEX = /^[A-Z0-9][A-Z0-9\-_/.]{0,39}$/;

const LITERAL_CHAR = /^[A-Z0-9\-_/.]$/;
const ATTR_TOKEN = /^ATTR:([a-z][a-z0-9_]{0,39}):(\d+)$/;
const SEQ_TOKEN = /^SEQ:(\d+)$/;

export type CodeSegment =
  | { kind: 'LITERAL'; text: string }
  | { kind: 'CAT' }
  | { kind: 'YYYY' }
  | { kind: 'YY' }
  | { kind: 'ATTR'; key: string; length: number }
  | { kind: 'SEQ'; width: number };

export type ParsedCodePattern = { ok: true; segments: CodeSegment[] } | { ok: false; error: string };

export interface CodeRenderContext {
  categoryCode: string;
  attributes: Record<string, string | boolean>;
  date: Date;
}

export type RenderedCode = { ok: true; value: string } | { ok: false; error: string };

type TokenResult = { ok: true; segment: CodeSegment } | { ok: false; error: string };

function parseToken(inner: string, raw: string): TokenResult {
  if (inner === 'CAT') return { ok: true, segment: { kind: 'CAT' } };
  if (inner === 'YYYY') return { ok: true, segment: { kind: 'YYYY' } };
  if (inner === 'YY') return { ok: true, segment: { kind: 'YY' } };

  const attrMatch = ATTR_TOKEN.exec(inner);
  if (attrMatch !== null) {
    const key = attrMatch[1] as string;
    const length = Number(attrMatch[2]);
    if (length < 1 || length > 10) {
      return { ok: false, error: '{ATTR:key:n} length must be 1 to 10' };
    }
    return { ok: true, segment: { kind: 'ATTR', key, length } };
  }

  const seqMatch = SEQ_TOKEN.exec(inner);
  if (seqMatch !== null) {
    const width = Number(seqMatch[1]);
    if (width < 3 || width > 8) {
      return { ok: false, error: '{SEQ:n} width must be 3 to 8' };
    }
    return { ok: true, segment: { kind: 'SEQ', width } };
  }

  return { ok: false, error: `Unknown token "${raw}"` };
}

/** Parses and validates a pattern. Fails fast, left to right, on the first problem found. */
export function parseCodePattern(pattern: string): ParsedCodePattern {
  if (pattern.length === 0) return { ok: false, error: 'Pattern is empty' };
  if (pattern.length > CODE_PATTERN_MAX_LENGTH) {
    return { ok: false, error: 'Pattern is longer than 60 characters' };
  }

  const segments: CodeSegment[] = [];
  let seqCount = 0;
  let literalBuffer = '';
  let i = 0;

  const flushLiteral = (): void => {
    if (literalBuffer.length > 0) {
      segments.push({ kind: 'LITERAL', text: literalBuffer });
      literalBuffer = '';
    }
  };

  while (i < pattern.length) {
    const ch = pattern[i] as string;

    if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) return { ok: false, error: 'Unclosed "{"' };

      flushLiteral();
      const raw = pattern.slice(i, close + 1);
      const inner = pattern.slice(i + 1, close);
      const token = parseToken(inner, raw);
      if (!token.ok) return token;

      if (token.segment.kind === 'SEQ') seqCount += 1;
      segments.push(token.segment);
      i = close + 1;
      continue;
    }

    if (!LITERAL_CHAR.test(ch)) {
      return { ok: false, error: `Character "${ch}" is not allowed; use A-Z, 0-9, - _ / .` };
    }
    literalBuffer += ch;
    i += 1;
  }
  flushLiteral();

  if (seqCount !== 1) return { ok: false, error: 'Pattern needs exactly one {SEQ:n}' };

  return { ok: true, segments };
}

/**
 * Converts a raw attribute value to the characters a code may use: booleans
 * become Y/N, a YYYY-MM-DD date string loses its dashes, everything else is
 * used as-is — then upper-cased and stripped of every non-alphanumeric
 * character. Truncation to the token's declared length happens at the call
 * site, after this runs.
 */
function sanitizeAttributeValue(raw: string | boolean): string {
  let str: string;
  if (typeof raw === 'boolean') {
    str = raw ? 'Y' : 'N';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    str = raw.replace(/-/g, '');
  } else {
    str = raw;
  }
  return str.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

type SequenceMode = { kind: 'VALUE'; value: number } | { kind: 'SCOPE' };

/**
 * Shared renderer for `renderCode` and `renderScopeKey`. The scope-key mode
 * renders `{SEQ:n}` as the single character `#` and skips the final
 * ITEM_CODE_REGEX / 40-character validation — a scope key is a counter
 * bucket, not an item code, and `#` is deliberately outside that alphabet so
 * a scope key can never collide with a real generated code.
 */
function render(segments: readonly CodeSegment[], ctx: CodeRenderContext, seq: SequenceMode): RenderedCode {
  let out = '';

  for (const seg of segments) {
    switch (seg.kind) {
      case 'LITERAL':
        out += seg.text;
        break;
      case 'CAT':
        out += ctx.categoryCode;
        break;
      case 'YYYY':
        out += String(ctx.date.getUTCFullYear());
        break;
      case 'YY':
        out += String(ctx.date.getUTCFullYear() % 100).padStart(2, '0');
        break;
      case 'ATTR': {
        const raw = ctx.attributes[seg.key];
        if (raw === undefined) {
          return { ok: false, error: `Code scheme needs attribute "${seg.key}" to generate a code` };
        }
        const sanitized = sanitizeAttributeValue(raw).slice(0, seg.length);
        if (sanitized.length === 0) {
          return { ok: false, error: `Code scheme needs attribute "${seg.key}" to generate a code` };
        }
        out += sanitized;
        break;
      }
      case 'SEQ':
        if (seq.kind === 'SCOPE') {
          out += '#';
        } else {
          if (seq.value >= 10 ** seg.width) {
            return { ok: false, error: 'Code sequence exhausted for this scheme' };
          }
          out += String(seq.value).padStart(seg.width, '0');
        }
        break;
    }
  }

  if (seq.kind === 'SCOPE') return { ok: true, value: out };

  if (out.length > 40) return { ok: false, error: 'Generated code is longer than 40 characters' };
  if (!ITEM_CODE_REGEX.test(out)) return { ok: false, error: 'Generated code is not a valid item code' };
  return { ok: true, value: out };
}

/** Renders the full code with the given sequence number. */
export function renderCode(segments: readonly CodeSegment[], ctx: CodeRenderContext, sequence: number): RenderedCode {
  return render(segments, ctx, { kind: 'VALUE', value: sequence });
}

/** Same rendering, with {SEQ:n} replaced by the single character '#'. The counter key. */
export function renderScopeKey(segments: readonly CodeSegment[], ctx: CodeRenderContext): RenderedCode {
  return render(segments, ctx, { kind: 'SCOPE' });
}

/**
 * Documentation example: renders with sequence 1, and each {ATTR:key:n}
 * fed its own key name as the source value (so `{ATTR:brand:3}` renders
 * "BRA") — there is no real item to draw a value from yet.
 */
export function exampleCode(pattern: string, categoryCode: string, date: Date): RenderedCode {
  const parsed = parseCodePattern(pattern);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const attributes: Record<string, string | boolean> = {};
  for (const seg of parsed.segments) {
    if (seg.kind === 'ATTR') attributes[seg.key] = seg.key;
  }

  return renderCode(parsed.segments, { categoryCode, attributes, date }, 1);
}
