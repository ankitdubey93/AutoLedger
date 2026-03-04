import { loadCsvRules, findBestRule } from './csvParser';
import type { CsvRule } from './csvParser';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  name: string;
  code: string;
  type: string;
}

// ── CSV rule singleton ────────────────────────────────────────────────────────

// Loaded lazily on first call so tests can control filesystem access timing.
let _csvRules: CsvRule[] | null = null;

function getCsvRules(): CsvRule[] {
  if (_csvRules === null) {
    _csvRules = loadCsvRules();
  }
  return _csvRules;
}

/** Invalidates the in-memory CSV cache. Call after appending a new training row. */
export function invalidateCsvCache(): void {
  _csvRules = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generic money/liquid-asset synonyms used across CSV training data.
 * When the CSV says "Bank" or "Cash" but the user's chart has "Cash On Hand"
 * or "Checking Account", we match by this synonym set + account type = Asset.
 */
const MONEY_SYNONYMS = new Set(['bank', 'cash', 'petty cash', 'checking', 'wallet', 'card']);

/**
 * Infers the AccountType from a CSV account name string by inspecting
 * known suffixes and keywords embedded in the name.
 *
 * This lets us do a type-based fallback when the user's chart doesn't have
 * an account with the exact same name as the CSV training data.
 *
 * Examples:
 *   "Utility Expense"      → "Expense"
 *   "Accrued Liabilities"  → "Liability"
 *   "Service Revenue"      → "Revenue"
 *   "Prepaid Insurance"    → "Asset"
 *   "Bank"                 → "Asset"
 */
function inferAccountType(csvName: string): string | null {
  const n = csvName.toLowerCase();
  if (/expense|cost|depreciation|amortization|loss/.test(n))          return 'Expense';
  if (/revenue|income|sales|gain/.test(n))                            return 'Revenue';
  if (/payable|liability|liabilities|unearned|deferred|loan|bond|note|tax payable/.test(n)) return 'Liability';
  if (/receivable|prepaid|inventory|asset|equipment|vehicle|deposit|investment|intangible|accumulated/.test(n)) return 'Asset';
  if (/capital|equity|drawings|retained|dividend/.test(n))            return 'Equity';
  // Generic money accounts
  if (MONEY_SYNONYMS.has(n))                                          return 'Asset';
  return null;
}

export interface MissingAccount {
  /** The account name the CSV rule expected (e.g. "Utility Expense") */
  suggestedName: string;
  /** The AccountType inferred from the CSV name */
  suggestedType: string;
}

/**
 * Result of resolveAccount.
 * - Pass 1-3: matched account, no missing signal
 * - Pass 4:   matched account (type fallback) + missing signal for the frontend
 * - null return from the function: nothing could be resolved at all
 */
interface ResolveResult {
  matched: Account;
  /** Non-null only when matched via type-fallback (Pass 4) */
  missing: MissingAccount | null;
}

/**
 * Resolves a CSV account name string against a live accounts array.
 *
 * Pass 1 — exact case-insensitive match
 * Pass 2 — partial containment (e.g. "Bank" ↔ "Bank Account")
 * Pass 3 — money synonym fallback: CSV says "Bank"/"Cash", user has "Cash On Hand"
 * Pass 4 — type-based fallback: infer expected AccountType from the CSV name,
 *           pick the first account of that type, but also flag it as missing so
 *           the frontend can prompt the user to create a specific account.
 *
 * Returns a ResolveResult — always has either matched or missing, never both null.
 * Returns null if neither name nor type could be resolved at all.
 */
function resolveAccount(csvName: string, accounts: Account[]): ResolveResult | null {
  const needle = csvName.toLowerCase().trim();

  // Pass 1: exact case-insensitive
  const exact = accounts.find(acc => acc.name.toLowerCase() === needle);
  if (exact) return { matched: exact, missing: null };

  // Pass 2: partial containment (e.g. "Bank" ↔ "Bank Account")
  const partial = accounts.find(acc => {
    const accName = acc.name.toLowerCase();
    return accName.includes(needle) || needle.includes(accName);
  });
  if (partial) return { matched: partial, missing: null };

  // Pass 3: money synonym fallback — find any Asset whose name contains a money word
  if (MONEY_SYNONYMS.has(needle)) {
    const money = accounts.find(acc =>
      acc.type === 'Asset' &&
      [...MONEY_SYNONYMS].some(syn => acc.name.toLowerCase().includes(syn)),
    );
    if (money) return { matched: money, missing: null };
  }

  // Pass 4: type-based fallback — use a generic account of the right type but flag as missing
  const expectedType = inferAccountType(csvName);
  if (expectedType) {
    const fallback = accounts.find(acc => acc.type === expectedType);
    if (fallback) {
      return {
        matched: fallback,
        missing: { suggestedName: csvName, suggestedType: expectedType },
      };
    }
  }

  return null;
}

/**
 * Verifies that the sum of debits equals the sum of credits (in integer cents).
 * Throws if the entry is unbalanced — the engine must never produce bad data.
 */
function assertBalanced(lines: Array<{ debit: number; credit: number }>): void {
  const toCents = (n: number) => Math.round(Number(n) * 100);
  const debitSum = lines.reduce((s, l) => s + toCents(l.debit), 0);
  const creditSum = lines.reduce((s, l) => s + toCents(l.credit), 0);
  if (debitSum !== creditSum) {
    throw new Error(
      `Rule engine produced an unbalanced entry: debit ${debitSum}¢ ≠ credit ${creditSum}¢. Please rephrase your transaction.`,
    );
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export const parseTransaction = (sentence: string, accounts: Account[]) => {
  const input = sentence.toLowerCase();

  // 1. Extract ALL numbers found in the sentence (required by both paths).
  const numbers = sentence.match(/(\d+(\.\d{1,2})?)/g)?.map(Number) || [];
  if (numbers.length === 0) throw new Error('Please include an amount (e.g., 100).');

  // 2. CSV-first path — keyword scoring against the training data.
  const bestRule = findBestRule(sentence, getCsvRules());

  if (bestRule !== null) {
    // If the user explicitly names a liquid payment account in their sentence
    // (e.g. "using petty cash", "from cash on hand", "via bank"), override the
    // CSV's credit account with that account rather than the CSV default.
    // We restrict this to known money synonyms so we don't accidentally match
    // non-payment assets like "Prepaid Insurance" or "Accounts Receivable".
    // Sort longest-first so "petty cash" is tested before "cash",
    // ensuring the most specific match wins.
    const sortedSynonyms = [...MONEY_SYNONYMS].sort((a, b) => b.length - a.length);
    const explicitPaymentAccount = accounts.find(acc => {
      const accName = acc.name.toLowerCase();
      return (
        acc.type === 'Asset' &&
        sortedSynonyms.some(syn => accName.includes(syn) && input.includes(syn))
      );
    });

    const debitResult  = resolveAccount(bestRule.debitAccount,  accounts);
    const creditResult = explicitPaymentAccount
      ? { matched: explicitPaymentAccount, missing: null }
      : resolveAccount(bestRule.creditAccount, accounts);

    const debitAcc  = debitResult?.matched  ?? null;
    const creditAcc = creditResult?.matched ?? null;

    if (debitAcc !== null && creditAcc !== null) {
      const amount = numbers[0];
      const lines = [
        { accountId: debitAcc.id,  accountName: debitAcc.name,  debit: amount, credit: 0      },
        { accountId: creditAcc.id, accountName: creditAcc.name, debit: 0,      credit: amount },
      ];
      assertBalanced(lines);

      // Collect accounts that were resolved via type-fallback (Pass 4) — these
      // are candidates the user might want to create as proper named accounts.
      const missingAccounts: MissingAccount[] = [
        debitResult?.missing ?? null,
        creditResult?.missing ?? null,
      ].filter((m): m is MissingAccount => m !== null);

      return { description: sentence, lines, missingAccounts };
    }
    // If either side returned null entirely, fall through to legacy path.
  }

  // 3. Legacy path — intent detection + account name matching.

  const isSpending = /paid|spent|bought|bill|purchase|expense/.test(input);
  const isEarning  = /received|sold|earned|income|revenue|deposit/.test(input);

  // Guard: ambiguous input matches both spending and earning keywords.
  if (isSpending && isEarning) {
    throw new Error(
      'Ambiguous transaction: description matches both spending and earning keywords. Please rephrase.',
    );
  }

  // Find ALL mentioned accounts by name or partial word.
  const mentionedAccounts = accounts.filter(acc =>
    input.includes(acc.name.toLowerCase()) ||
    acc.name.toLowerCase().split(' ').some(word => word.length > 3 && input.includes(word)),
  );

  // Identify the "money" side (Cash / Bank).
  const moneyAccount = accounts.find(acc => /bank|cash|card|wallet/.test(acc.name.toLowerCase()));

  let lines: Array<{ accountId: string; accountName: string; debit: number; credit: number }> = [];

  if (mentionedAccounts.length >= 2) {
    mentionedAccounts.forEach((acc, index) => {
      const amount = numbers[index] ?? numbers[0];
      const isAsset = acc.type === 'Asset';
      const isExp   = acc.type === 'Expense';

      lines.push({
        accountId:   acc.id,
        accountName: acc.name,
        debit:  (isSpending && isExp)   || (isEarning && isAsset)  ? amount : 0,
        credit: (isSpending && isAsset) || (isEarning && !isAsset) ? amount : 0,
      });
    });
  } else {
    // FALLBACK: single-account "Amount + Category" logic.
    const category =
      mentionedAccounts[0] ??
      accounts.find(acc => acc.type === (isSpending ? 'Expense' : 'Revenue'));
    const amount = numbers[0];

    if (!category || !moneyAccount) {
      throw new Error("Could not identify accounts. Try mentioning 'Cash' or 'Bank'.");
    }

    lines = [
      {
        accountId:   category.id,
        accountName: category.name,
        debit:  isSpending ? amount : 0,
        credit: isEarning  ? amount : 0,
      },
      {
        accountId:   moneyAccount.id,
        accountName: moneyAccount.name,
        debit:  isEarning  ? amount : 0,
        credit: isSpending ? amount : 0,
      },
    ];
  }

  assertBalanced(lines);
  return { description: sentence, lines };
};
