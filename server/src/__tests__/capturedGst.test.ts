import { describe, expect, it } from 'vitest';
import { abnDigits, formatAbn, isValidAbn, looksLikeAbn } from '../utils/abn.js';
import { decideCapturedGst } from '../utils/capturedGst.js';
import { detectPii } from '../utils/pii.js';

describe('ABN', () => {
  it.each(['51 824 753 556', '51824753556', '51-824-753-556'])('accepts the ABR example written as %s', (abn) => {
    expect(isValidAbn(abn)).toBe(true);
  });

  it.each(['51 824 753 557', '11 111 111 111', '1234', '', 'abcdefghijk', '518247535560'])('refuses %s', (abn) => {
    expect(isValidAbn(abn)).toBe(false);
  });

  it('formats the way the ABR does', () => {
    expect(formatAbn('51824753556')).toBe('51 824 753 556');
    expect(abnDigits('51 824-753 556')).toBe('51824753556');
  });

  it('tells a mistyped ABN from a foreign tax number', () => {
    expect(looksLikeAbn('51 824 753 557')).toBe(true);
    expect(looksLikeAbn('GB123456789')).toBe(false);
    expect(looksLikeAbn('US-12345')).toBe(false);
  });
});

describe('PII masking and Australian numbers', () => {
  it('does not mask an ABN, which the model must be able to read', () => {
    expect(detectPii('Supplier ABN 51 824 753 556')).toEqual([]);
  });

  it('masks a labelled tax file number', () => {
    const text = 'TFN: 123 456 782';
    const spans = detectPii(text);
    expect(spans.map((s) => s.kind)).toEqual(['TFN']);
    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe('123 456 782');
    expect(detectPii('Tax File Number 123456782').map((s) => s.kind)).toEqual(['TFN']);
  });

  it('leaves an unlabelled nine digits alone, and a bad checksum even when labelled', () => {
    // About 1 in 11 random numbers pass the checksum, so masking without the label would hit invoice numbers.
    expect(detectPii('Invoice 123456782')).toEqual([]);
    expect(detectPii('TFN: 123 456 789')).toEqual([]);
  });
});

const line = (amountCents: number, extractedTaxCents: number | null = null, chosenCode: string | null = null) => ({
  amountCents,
  extractedTaxCents,
  chosenCode,
});

describe('deciding GST on a captured bill', () => {
  const decide = (lines: ReturnType<typeof line>[], taxCents: number, totalCents: number, registered = true) =>
    decideCapturedGst({ registered, lines, taxCents, totalCents });

  it('all taxable, lines exclusive', () => {
    expect(decide([line(10_000), line(5_000)], 1_500, 16_500)).toEqual({
      ok: true,
      lines: [
        { taxCode: 'P_GST', netCents: 10_000, taxCents: 1_000 },
        { taxCode: 'P_GST', netCents: 5_000, taxCents: 500 },
      ],
    });
  });

  it('all taxable, lines already including GST', () => {
    expect(decide([line(11_000)], 1_000, 11_000)).toEqual({
      ok: true,
      lines: [{ taxCode: 'P_GST', netCents: 10_000, taxCents: 1_000 }],
    });
  });

  it('no GST at all', () => {
    const decision = decide([line(5_000)], 0, 5_000);
    expect(decision).toEqual({ ok: true, lines: [{ taxCode: 'P_FREE', netCents: 5_000, taxCents: 0 }] });
  });

  it('uses GST printed per line on a mixed receipt', () => {
    expect(decide([line(10_000, 1_000), line(5_000, 0)], 1_000, 16_000)).toEqual({
      ok: true,
      lines: [
        { taxCode: 'P_GST', netCents: 10_000, taxCents: 1_000 },
        { taxCode: 'P_FREE', netCents: 5_000, taxCents: 0 },
      ],
    });
  });

  it('holds a mixed receipt for review rather than taxing the GST-free line', () => {
    const decision = decide([line(10_000), line(5_000)], 1_000, 16_000);
    expect(decision.ok).toBe(false);
  });

  it('holds a receipt whose printed line GST does not add up', () => {
    expect(decide([line(10_000, 700), line(5_000, 0)], 1_000, 16_000).ok).toBe(false);
  });

  it('follows what a reviewer chose', () => {
    expect(decide([line(10_000, null, 'P_GST'), line(5_000, null, 'P_FREE')], 1_000, 16_000)).toEqual({
      ok: true,
      lines: [
        { taxCode: 'P_GST', netCents: 10_000, taxCents: 1_000 },
        { taxCode: 'P_FREE', netCents: 5_000, taxCents: 0 },
      ],
    });
  });

  it('refuses a choice that contradicts the receipt', () => {
    expect(decide([line(10_000, null, 'P_FREE')], 1_000, 11_000).ok).toBe(false);
    expect(decide([line(10_000, null, 'P_GST')], 0, 10_000).ok).toBe(false);
  });

  it('claims nothing for an unregistered business: the GST is part of the cost', () => {
    expect(decide([line(10_000)], 1_000, 11_000, false)).toEqual({
      ok: true,
      lines: [{ taxCode: 'P_EXCLUDED', netCents: 11_000, taxCents: 0 }],
    });
    expect(decide([line(11_000)], 1_000, 11_000, false)).toEqual({
      ok: true,
      lines: [{ taxCode: 'P_EXCLUDED', netCents: 11_000, taxCents: 0 }],
    });
  });

  it('always adds back to the total', () => {
    for (const [lines, tax, total] of [
      [[line(3_333), line(3_334)], 667, 7_334],
      [[line(1_999), line(2_001)], 364, 4_000],
    ] as const) {
      const decision = decide([...lines], tax, total);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.lines.reduce((s, l) => s + l.netCents + l.taxCents, 0)).toBe(total);
    }
  });
});
