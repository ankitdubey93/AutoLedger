import { ApiError } from './apiError.js';

/**
 * A hand-written RFC 4180 CSV parser for bank statement exports.
 *
 * Real bank CSVs are messy: a leading BOM, quoted fields containing commas
 * or embedded newlines, doubled-quote escaping, and any of comma/semicolon/
 * tab as the delimiter depending on the bank's locale. A regex split on `,`
 * breaks on the first quoted amount or memo field, so this is a small
 * character-by-character state machine instead — the same reasoning
 * `utils/levenshtein.ts` gives for being hand-written rather than a
 * dependency (guardrails rule 14; roadmap Phase 6 requires both hand-rolled).
 *
 * See study/node-express/parsing-untrusted-csv.md.
 */

export interface CsvTable {
  /** Header cells, trimmed, with the BOM stripped from the first one. */
  headers: string[];
  /** Data rows. Every row is padded with '' to headers.length. */
  rows: string[][];
  /** The delimiter that was detected: ',', ';' or '\t'. */
  delimiter: string;
}

const CANDIDATE_DELIMITERS = [',', ';', '\t'] as const;

/** Counts a candidate delimiter's occurrences in `line`, ignoring anything inside quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delimiter) {
      count++;
    }
  }
  return count;
}

function detectDelimiter(firstLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Splits `input` into physical records, respecting quotes so an embedded
 * `\r`/`\n` inside a quoted field is not treated as a record boundary.
 * Throws on an unterminated quote. Each record is the raw text between
 * delimiters, still containing its quote characters — field-level parsing
 * happens afterward in `splitFields`.
 */
function splitRecords(input: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          current += '""';
          i += 2;
          continue;
        }
        inQuotes = false;
        current += '"';
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      current += '"';
      i++;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      records.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (inQuotes) {
    throw new ApiError(400, 'Malformed CSV: an opening quote is never closed');
  }

  if (current !== '') {
    records.push(current);
  }

  return records;
}

/** Splits one physical record into fields on `delimiter`, unescaping quotes. */
function splitFields(record: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;
  const len = record.length;

  function endField(): void {
    fields.push(current.trim());
    current = '';
    fieldStarted = false;
  }

  while (i < len) {
    const ch = record[i];

    if (inQuotes) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }

    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }

    current += ch;
    fieldStarted = true;
    i++;
  }

  endField();
  return fields;
}

export function parseCsv(text: string): CsvTable {
  // Strip a leading UTF-8 BOM.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const firstLineEnd = (() => {
    const idx = input.search(/\r\n|\r|\n/);
    return idx === -1 ? input.length : idx;
  })();
  const delimiter = detectDelimiter(input.slice(0, firstLineEnd));

  const records = splitRecords(input);

  const allRows: string[][] = [];
  for (const record of records) {
    const fields = splitFields(record, delimiter);
    const isBlank = fields.every((cell) => cell === '');
    if (isBlank) continue;
    allRows.push(fields);
  }

  if (allRows.length === 0) {
    throw new ApiError(400, 'The file is empty');
  }

  const headers = allRows[0];
  if (headers === undefined) {
    throw new ApiError(400, 'The file is empty');
  }
  const headerCount = headers.length;

  const rows: string[][] = [];
  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r];
    if (row === undefined) continue;
    // rowNumber is 1-based including the header row.
    const rowNumber = r + 1;
    if (row.length > headerCount) {
      throw new ApiError(
        400,
        `Malformed CSV: row ${String(rowNumber)} has ${String(row.length)} cells but the header has ${String(headerCount)}`,
      );
    }
    const padded = row.slice();
    while (padded.length < headerCount) padded.push('');
    rows.push(padded);
  }

  return { headers, rows, delimiter };
}
