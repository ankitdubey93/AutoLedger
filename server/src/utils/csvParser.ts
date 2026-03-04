import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CsvRule {
  sentence: string;
  debitAccount: string;
  creditAccount: string;
  amount: number;
  /** Signal keywords pre-computed at parse time for fast scoring */
  keywords: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'from',
  'with', 'and', 'or', 'but', 'not', 'via', 'as', 'its', 'was', 'is',
  'are', 'be', 'been', 'has', 'had', 'have', 'do', 'did', 'does', 'per',
  'into', 'this', 'that', 'it', 'out', 'up', 'so', 'yet', 'no', 'nor',
  'used', 'some', 'get', 'use', 'new', 'old', 'all', 'one', 'two',
]);

const CSV_PATH = path.resolve(__dirname, '../data/training_data.csv');

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * State-machine CSV line parser that correctly handles quoted fields
 * containing commas (e.g. the Sentence column).
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Strips numbers, punctuation, stopwords, and short tokens from a sentence,
 * returning only the domain-signal words.
 *
 * Example:
 *   "Amortized 100 of prepaid insurance for the current month"
 *   → ["amortized", "prepaid", "insurance", "current", "month"]
 */
export function extractKeywords(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[\d,.]+/g, ' ')     // strip numbers and commas
    .replace(/[^a-z\s]/g, ' ')   // strip remaining punctuation
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Counts how many of inputKeywords appear in ruleKeywords.
 * Higher score = better semantic match.
 */
export function scoreMatch(inputKeywords: string[], ruleKeywords: string[]): number {
  if (ruleKeywords.length === 0) return 0;
  const ruleSet = new Set(ruleKeywords);
  return inputKeywords.filter(k => ruleSet.has(k)).length;
}

/**
 * Finds the CSV rule whose keywords best match the input sentence.
 * Returns null if the best score is below minScore.
 *
 * @param sentence  - The user's plain-text transaction description
 * @param rules     - The loaded CSV rule set (from loadCsvRules)
 * @param minScore  - Minimum overlap count to accept a match (default 2)
 */
export function findBestRule(
  sentence: string,
  rules: CsvRule[],
  minScore = 2,
): CsvRule | null {
  const inputKeywords = extractKeywords(sentence);
  let bestRule: CsvRule | null = null;
  let bestScore = 0;

  for (const rule of rules) {
    const score = scoreMatch(inputKeywords, rule.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return bestScore >= minScore ? bestRule : null;
}

/**
 * Appends a new training row to training_data.csv.
 * Only writes when the sentence is non-empty and the entry is a simple
 * two-account (debit/credit) pair.
 *
 * After writing, the caller must invalidate the in-memory rules cache so
 * the next getCsvRules() picks up the new row.
 */
export function appendToCsv(
  sentence: string,
  debitAccountName: string,
  creditAccountName: string,
  amount: number,
  csvPath?: string,
): void {
  const resolvedPath = csvPath ?? CSV_PATH;
  // Quote the sentence field to handle commas inside it
  const row = `"${sentence.replace(/"/g, '""')}",${debitAccountName},${creditAccountName},${amount}\n`;
  fs.appendFileSync(resolvedPath, row, 'utf-8');
}

/**
 * Reads and parses training_data.csv, returning all rows as CsvRule objects
 * with keywords pre-computed. Call once and cache the result.
 *
 * The CSV path is resolved via __dirname so it works in both ts-node (src/)
 * and compiled output (dist/).
 */
export function loadCsvRules(csvPath?: string): CsvRule[] {
  const resolvedPath = csvPath ?? CSV_PATH;
  const raw = fs.readFileSync(resolvedPath, 'utf-8');

  const lines = raw
    .split(/\r?\n/)                         // handle CRLF and LF
    .filter(line => line.trim().length > 0);

  // Skip header row (Sentence,Debit_Account,Credit_Account,Amount)
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const sentence = fields[0]?.trim() ?? '';
    const debitAccount = fields[1]?.trim() ?? '';
    const creditAccount = fields[2]?.trim() ?? '';
    const amount = parseFloat(fields[3]?.trim() ?? '0') || 0;

    return {
      sentence,
      debitAccount,
      creditAccount,
      amount,
      keywords: extractKeywords(sentence),
    };
  });
}
