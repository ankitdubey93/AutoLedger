import { describe, expect, it } from 'vitest';
import {
  parsePercentBp,
  parseQuantityMilli,
  parseImportCell,
  suggestDateFormat,
  type CellSpec,
} from '../utils/importValues.js';

/** Unit tier — no database. Pure parsing logic for import cells. */

describe('parsePercentBp', () => {
  it('plain, suffixed and embedded', () => {
    expect(parsePercentBp('10')).toBe(1000);
    expect(parsePercentBp('12.5%')).toBe(1250);
    expect(parsePercentBp('GST on Income (15%)')).toBe(1500);
    expect(parsePercentBp('0')).toBe(0);
  });

  it('exempt words are zero', () => {
    expect(parsePercentBp('Tax Exempt')).toBe(0);
  });

  it('rejects garbage, 3 decimals and >100%', () => {
    expect(parsePercentBp('abc')).toBe(null);
    expect(parsePercentBp('10.125')).toBe(null);
    expect(parsePercentBp('101')).toBe(null);
  });
});

describe('parseQuantityMilli', () => {
  it('integers, decimals, thousands', () => {
    expect(parseQuantityMilli('12')).toBe(12000);
    expect(parseQuantityMilli('0.5')).toBe(500);
    expect(parseQuantityMilli('1,250.125')).toBe(1250125);
  });

  it('rejects negative and 4 decimals', () => {
    expect(parseQuantityMilli('-1')).toBe(null);
    expect(parseQuantityMilli('1.2345')).toBe(null);
  });
});

describe('parseImportCell', () => {
  it('empty is null for every type', () => {
    const textSpec: CellSpec = {
      label: 'Text',
      type: 'text',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const moneySpec: CellSpec = {
      label: 'Amount',
      type: 'money',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const percentSpec: CellSpec = {
      label: 'Rate',
      type: 'percent',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const quantitySpec: CellSpec = {
      label: 'Qty',
      type: 'quantity',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const dateSpec: CellSpec = {
      label: 'Date',
      type: 'date',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };

    expect(parseImportCell(textSpec, '', 'ISO')).toEqual({ ok: true, value: null });
    expect(parseImportCell(moneySpec, '', 'ISO')).toEqual({ ok: true, value: null });
    expect(parseImportCell(percentSpec, '', 'ISO')).toEqual({ ok: true, value: null });
    expect(parseImportCell(quantitySpec, '', 'ISO')).toEqual({ ok: true, value: null });
    expect(parseImportCell(dateSpec, '', 'ISO')).toEqual({ ok: true, value: null });
  });

  it('money negative is an error', () => {
    const spec: CellSpec = {
      label: 'Amount',
      type: 'money',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const result = parseImportCell(spec, '-10.00', 'ISO');
    expect(result).toEqual({
      ok: false,
      error: 'Amount cannot be negative',
    });
  });

  it('enum maps aliases and lists labels on failure', () => {
    const spec: CellSpec = {
      label: 'Type',
      type: 'enum',
      maxLength: null,
      enumAliases: { service: 'SERVICE', services: 'SERVICE' },
      enumLabels: ['Service', 'Non-inventory'],
    };
    expect(parseImportCell(spec, 'service', 'ISO')).toEqual({
      ok: true,
      value: 'SERVICE',
    });
    const badResult = parseImportCell(spec, 'bad', 'ISO');
    expect(badResult).toEqual({
      ok: false,
      error: 'Type "bad" must be one of: Service, Non-inventory',
    });
  });

  it('text over maxLength is an error', () => {
    const spec: CellSpec = {
      label: 'Name',
      type: 'text',
      maxLength: 5,
      enumAliases: null,
      enumLabels: null,
    };
    const result = parseImportCell(spec, 'toolong', 'ISO');
    expect(result).toEqual({
      ok: false,
      error: 'Name is longer than 5 characters',
    });
  });

  it('date in DMY', () => {
    const spec: CellSpec = {
      label: 'Date',
      type: 'date',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const result = parseImportCell(spec, '31/01/2026', 'DMY');
    expect(result).toEqual({
      ok: true,
      value: '2026-01-31',
    });
  });

  it('signedMoney keeps the sign', () => {
    const spec: CellSpec = {
      label: 'Amount',
      type: 'signedMoney',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    expect(parseImportCell(spec, '-12.50', 'ISO')).toEqual({ ok: true, value: -1250 });
    expect(parseImportCell(spec, '12.50', 'ISO')).toEqual({ ok: true, value: 1250 });
  });

  it('signedMoney rejects words', () => {
    const spec: CellSpec = {
      label: 'Amount',
      type: 'signedMoney',
      maxLength: null,
      enumAliases: null,
      enumLabels: null,
    };
    const result = parseImportCell(spec, 'abc', 'ISO');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('is not an amount');
  });
});

describe('suggestDateFormat', () => {
  it('covers various cases', () => {
    expect(suggestDateFormat(['2026-01-31'])).toBe('ISO');
    expect(suggestDateFormat(['31/01/2026'])).toBe('DMY');
    expect(suggestDateFormat(['01/31/2026'])).toBe('MDY');
    expect(suggestDateFormat(['01/02/2026'])).toBe(null);
    expect(suggestDateFormat([])).toBe('ISO');
  });
});
