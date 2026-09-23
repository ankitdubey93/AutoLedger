/**
 * StockLedger (Phase 28) — GS1 GTIN-8/12/13/14 check-digit validation.
 *
 * Working from the rightmost non-check digit, weight alternately 3, 1, 3,
 * 1…. The check digit is `(10 − (sum mod 10)) mod 10`. A length other than
 * 8, 12, 13 or 14, or any non-digit character, is invalid.
 */

const GTIN_SHAPE = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;

export function isValidGtin(barcode: string): boolean {
  if (!GTIN_SHAPE.test(barcode)) return false;

  const digits = barcode.split('').map(Number);
  const checkDigit = digits[digits.length - 1] as number;
  const body = digits.slice(0, -1);

  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const distanceFromRight = body.length - 1 - i;
    const weight = distanceFromRight % 2 === 0 ? 3 : 1;
    sum += (body[i] as number) * weight;
  }

  const expected = (10 - (sum % 10)) % 10;
  return expected === checkDigit;
}
