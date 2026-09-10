/**
 * Digit-string checksum algorithms, hand-written like `utils/levenshtein.ts`
 * and `utils/csv.ts` (guardrails rule 14 — no dependency before the phase
 * that needs it, and these never need one).
 *
 * Twelve digits is not an Aadhaar number, and sixteen digits is not a card
 * number — without a checksum the PII detector (`utils/pii.ts`) fires on
 * invoice numbers, order references and phone numbers, and a redactor that
 * masks everything is as useless as one that masks nothing.
 */

/** Luhn (mod-10) check, used by payment card numbers. Input must be digits only. */
export function luhn(digits: string): boolean {
  if (digits.length === 0 || !/^[0-9]+$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// The Verhoeff (dihedral D5) multiplication table.
const D_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// The permutation table, applied at each digit position (mod 8).
const P_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff (dihedral D5) check, used by Aadhaar. Input must be digits only. */
export function verhoeff(digits: string): boolean {
  if (digits.length === 0 || !/^[0-9]+$/.test(digits)) return false;

  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const d = reversed[i]?.charCodeAt(0);
    if (d === undefined) return false;
    const digit = d - 48;
    const pRow = P_TABLE[i % 8];
    const permuted = pRow?.[digit];
    if (permuted === undefined) return false;
    const dRow = D_TABLE[c];
    const next = dRow?.[permuted];
    if (next === undefined) return false;
    c = next;
  }
  return c === 0;
}
