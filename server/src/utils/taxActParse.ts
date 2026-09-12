/**
 * TaxGuard AI (Phase 16) — splitting a tax act's raw extracted text into
 * citation-labelled chunks ready for embedding. A pure function: no database
 * import, no clock, no I/O. Mirrors the posture `utils/boarddeckVariance.ts`
 * and `utils/forecasterBuild.ts` established.
 *
 * **Documented limitation:** the heading regex below is tuned for
 * Indian/UK-style statute drafting ("Section 80C(2)(a)"). US IRC-style
 * headings ("§ 61(a)(1)") will not match and the whole document falls
 * through to the single-chunk path (rule 3 below). Deliberate for this
 * phase, not a bug — see docs/taxguard.md's gaps list.
 */

export interface ParsedChunk {
  ordinal: number;
  citation: string;
  heading: string | null;
  content: string;
  tokenEstimate: number;
}

export interface ParseTaxActOptions {
  /** Citation prefix, e.g. 'Income-tax Act, 1961'. Prepended to every citation. */
  actLabel: string;
  /** Hard ceiling on a chunk's estimated tokens before it is split. Default 500. */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 500;

/**
 * Matches a section-heading line: "Section 80C(2)(a). Deductions", "Sec. 4
 * Charge", "S. 5 Scope". Capture group 1 is the section number (including
 * any parenthesised subsection suffix), group 2 the (possibly empty) heading
 * text on the rest of the line.
 */
const HEADING_RE = /^\s*(?:Section|Sec\.?|S\.)\s*([0-9]+[A-Z]*(?:\([0-9a-zA-Z]+\))*)\s*[.\-—:]?\s*(.*)$/gim;

/** Whitespace-normalised length / 4, rounded up, minimum 1. */
export function estimateTokens(text: string): number {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return 1;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function normalizeLineEndings(rawText: string): string {
  return rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
}

interface RawSection {
  sectionNumber: string;
  heading: string | null;
  body: string;
}

/** Splits normalised text into raw sections on HEADING_RE matches. Text
 *  before the first heading is returned separately (the preamble). */
function splitIntoSections(text: string): { preamble: string; sections: RawSection[] } {
  const matches = [...text.matchAll(HEADING_RE)];
  if (matches.length === 0) {
    return { preamble: text, sections: [] };
  }

  const firstMatch = matches[0];
  if (firstMatch === undefined || firstMatch.index === undefined) {
    return { preamble: text, sections: [] };
  }
  const preamble = text.slice(0, firstMatch.index);

  const sections: RawSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match === undefined || match.index === undefined) continue;
    const sectionNumber = match[1] ?? '';
    const headingText = (match[2] ?? '').trim();
    const headingLineEnd = match.index + match[0].length;
    const next = matches[i + 1];
    const bodyEnd = next?.index ?? text.length;
    const body = text.slice(headingLineEnd, bodyEnd);
    sections.push({
      sectionNumber,
      heading: headingText.length > 0 ? headingText : null,
      body,
    });
  }

  return { preamble, sections };
}

/** Splits an oversized section body on paragraph boundaries. A single
 *  paragraph longer than maxTokens is emitted whole, never split further. */
function splitOversizedBody(body: string, maxTokens: number): string[] {
  if (estimateTokens(body) <= maxTokens) return [body];

  const paragraphs = body.split(/\n\n/);
  const parts: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (estimateTokens(candidate) > maxTokens && current.length > 0) {
      parts.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.trim().length > 0 || parts.length === 0) {
    parts.push(current);
  }
  return parts;
}

export function parseTaxAct(rawText: string, options: ParseTaxActOptions): ParsedChunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const text = normalizeLineEndings(rawText);
  const { sections } = splitIntoSections(text);

  const chunks: ParsedChunk[] = [];
  let ordinal = 0;

  if (sections.length === 0) {
    // No heading matched anywhere in the document — emit one chunk for the
    // whole thing, unless it is empty.
    const content = text.trim();
    if (content.length > 0) {
      chunks.push({
        ordinal: ordinal++,
        citation: options.actLabel,
        heading: null,
        content,
        tokenEstimate: estimateTokens(content),
      });
    }
    return chunks;
  }

  for (const section of sections) {
    const body = section.body.trim();
    if (body.length === 0) continue;

    const parts = splitOversizedBody(body, maxTokens);
    const baseCitation = `${options.actLabel}, Section ${section.sectionNumber}`;

    if (parts.length === 1) {
      const content = parts[0]?.trim() ?? '';
      if (content.length === 0) continue;
      chunks.push({
        ordinal: ordinal++,
        citation: baseCitation,
        heading: section.heading,
        content,
        tokenEstimate: estimateTokens(content),
      });
    } else {
      parts.forEach((part, i) => {
        const content = part.trim();
        if (content.length === 0) return;
        chunks.push({
          ordinal: ordinal++,
          citation: `${baseCitation} (part ${i + 1})`,
          heading: section.heading,
          content,
          tokenEstimate: estimateTokens(content),
        });
      });
    }
  }

  return chunks;
}
