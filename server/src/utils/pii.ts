import { luhn, verhoeff } from './checksum.js';
import type { OcrWord, PiiKind, RedactedRegion } from '../types/ap-flow.js';

/**
 * PII detection over OCR'd text (Phase 10 — AP-Flow). Pure, zero
 * dependencies — hand-written like `utils/matchScore.ts`.
 *
 * **The honest limitation:** name detection is a label-anchored heuristic,
 * not named-entity recognition. It will miss an unlabelled name and will
 * over-mask a capitalised line item. Combined with approximate OCR boxes,
 * this means the claim this pipeline can honestly make is "redaction
 * pipeline implemented", never "PII cannot leak" — measuring recall needs a
 * labelled corpus that does not exist yet. See docs/ap-flow.md's redaction
 * section.
 */

export interface PiiSpan {
  kind: PiiKind;
  start: number;
  end: number;
}

const LABEL_NAMES = /(?:Bill To|Ship To|Attn|Attention|Cardholder|Customer|Name)\s*:\s*/gi;
const NAME_TOKEN = /^[A-Z][a-z]+$/;

const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
const GSTIN_RE = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;
const SSN_RE = /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g;

// 13-19 digits, optionally grouped by single spaces or hyphens.
const CARD_CANDIDATE_RE = /\b[0-9](?:[0-9 -]{11,23})[0-9]\b/g;
// Exactly 12 digits, optionally grouped, first digit 2-9.
const AADHAAR_CANDIDATE_RE = /\b[2-9][0-9](?:[0-9 -]{6,10})[0-9]\b/g;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Removes any span fully contained inside a longer span, keeping the longer one. */
function mergeSpans(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PiiSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start < last.end && span.end <= last.end) {
      continue; // fully contained in the previous, longer span
    }
    out.push(span);
  }
  return out;
}

/** Detects PII spans in a flat text stream. Pure — no boxes, no I/O. */
export function detectPii(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];

  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhn(digits)) continue;
    spans.push({ kind: 'CARD_NUMBER', start: match.index, end: match.index + raw.length });
  }

  for (const match of text.matchAll(AADHAAR_CANDIDATE_RE)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length !== 12) continue;
    if (!verhoeff(digits)) continue;
    spans.push({ kind: 'AADHAAR', start: match.index, end: match.index + raw.length });
  }

  for (const match of text.matchAll(PAN_RE)) {
    spans.push({ kind: 'PAN', start: match.index, end: match.index + match[0].length });
  }

  for (const match of text.matchAll(GSTIN_RE)) {
    spans.push({ kind: 'GSTIN', start: match.index, end: match.index + match[0].length });
  }

  for (const match of text.matchAll(SSN_RE)) {
    spans.push({ kind: 'SSN', start: match.index, end: match.index + match[0].length });
  }

  for (const labelMatch of text.matchAll(LABEL_NAMES)) {
    const afterLabel = labelMatch.index + labelMatch[0].length;
    // Consume up to 4 whitespace-separated capitalised tokens right after the label.
    const tail = text.slice(afterLabel);
    const tokenRe = /^[ \t]*([A-Za-z]+)/;
    let cursor = 0;
    let tokenCount = 0;
    let nameEnd = afterLabel;
    while (tokenCount < 4) {
      const rest = tail.slice(cursor);
      const m = tokenRe.exec(rest);
      if (m === null || m[1] === undefined || !NAME_TOKEN.test(m[1])) break;
      cursor += m[0].length;
      nameEnd = afterLabel + cursor;
      tokenCount += 1;
    }
    if (tokenCount > 0) {
      // Trim any leading whitespace consumed into the span.
      const nameStart = afterLabel + (tail.slice(0, cursor).length - tail.slice(0, cursor).trimStart().length);
      spans.push({ kind: 'PERSON_NAME', start: nameStart, end: nameEnd });
    }
  }

  return mergeSpans(spans);
}

/**
 * Maps detected spans back onto the OCR words they overlap and returns the
 * padded boxes to paint over.
 *
 * The joining contract: words are joined with a single ' ' separator; each
 * word's [start, end) offset in that joined string is recorded, and a
 * region is emitted for every word whose range overlaps a detected span. A
 * card number split across four OCR words therefore yields four boxes —
 * you cannot mask a span, only the words under it.
 */
export function regionsForWords(words: OcrWord[], padPx = 3): RedactedRegion[] {
  if (words.length === 0) return [];

  const offsets: { start: number; end: number }[] = [];
  let cursor = 0;
  const parts: string[] = [];
  for (const word of words) {
    const start = cursor;
    const end = start + word.text.length;
    offsets.push({ start, end });
    parts.push(word.text);
    cursor = end + 1; // +1 for the joining space
  }
  const text = parts.join(' ');

  const spans = detectPii(text);
  const regions: RedactedRegion[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const offset = offsets[i];
    const word = words[i];
    if (offset === undefined || word === undefined) continue;
    for (const span of spans) {
      if (overlaps(offset.start, offset.end, span.start, span.end)) {
        regions.push({
          kind: span.kind,
          box: {
            x0: Math.max(0, word.box.x0 - padPx),
            y0: Math.max(0, word.box.y0 - padPx),
            x1: word.box.x1 + padPx,
            y1: word.box.y1 + padPx,
          },
        });
        break;
      }
    }
  }

  return regions;
}
