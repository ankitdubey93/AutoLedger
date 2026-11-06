/**
 * Australian Business Numbers. Pure.
 *
 * The ABR's check: subtract 1 from the first digit, multiply each digit by its
 * weight, and the sum must divide by 89. Verified against the ABR's own worked
 * example, 51 824 753 556. A checksum proves a number is well formed, not that
 * it is registered to anyone; that takes ABN Lookup.
 */
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

export function abnDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function isValidAbn(value: string): boolean {
  const digits = abnDigits(value);
  if (!/^\d{11}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const digit = Number(digits[i]) - (i === 0 ? 1 : 0);
    sum += digit * (WEIGHTS[i] ?? 0);
  }
  return sum % 89 === 0;
}

/** 51824753556 becomes 51 824 753 556, the way the ABR writes it. */
export function formatAbn(value: string): string {
  const d = abnDigits(value);
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 11)}`;
}

/** Eleven digits and nothing else: meant as an ABN, so a bad one is a typo rather than a foreign tax number. */
export function looksLikeAbn(value: string): boolean {
  return /^\d{11}$/.test(abnDigits(value));
}
