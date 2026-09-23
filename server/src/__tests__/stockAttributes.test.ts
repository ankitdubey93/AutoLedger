import { describe, expect, it } from 'vitest';
import { validateAttributes } from '../utils/stockAttributes.js';
import type { StockAttributeDefinition, StockAttributeType } from '../types/stock.js';

/** StockLedger (Phase 28) — the custom-field validator. Pure unit tier. */

let counter = 0;

function def(overrides: Partial<StockAttributeDefinition> & { key: string; dataType: StockAttributeType }) {
  counter += 1;
  const fixture: StockAttributeDefinition = {
    id: `def-${String(counter)}`,
    categoryId: 'cat-1',
    appliesTo: 'ITEM',
    key: overrides.key,
    label: overrides.key,
    dataType: overrides.dataType,
    options: null,
    decimalPlaces: null,
    isRequired: false,
    sortOrder: 0,
    isActive: true,
  };
  return { ...fixture, ...overrides };
}

describe('validateAttributes', () => {
  it('accepts a valid real-estate unit', () => {
    const definitions = [
      def({ key: 'floor', label: 'Floor', dataType: 'NUMBER', decimalPlaces: 0, isRequired: true }),
      def({ key: 'carpet_area_sqft', label: 'Carpet area (sq ft)', dataType: 'NUMBER', decimalPlaces: 2, isRequired: true }),
      def({
        key: 'facing',
        label: 'Facing',
        dataType: 'SELECT',
        options: ['North', 'South', 'East', 'West'],
        isRequired: false,
      }),
      def({ key: 'corner', label: 'Corner', dataType: 'BOOLEAN', isRequired: false }),
    ];

    const result = validateAttributes(definitions, {
      floor: '12',
      carpet_area_sqft: '1250.50',
      facing: 'North',
      corner: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { floor: '12', carpet_area_sqft: '1250.50', facing: 'North', corner: true },
    });
  });

  it('rejects unknown key', () => {
    const result = validateAttributes([], { mystery: 'value' });
    expect(result).toEqual({ ok: false, errors: ['Unknown attribute "mystery"'] });
  });

  it('rejects missing required', () => {
    const definitions = [def({ key: 'brand', label: 'Brand', dataType: 'TEXT', isRequired: true })];
    const result = validateAttributes(definitions, {});
    expect(result).toEqual({ ok: false, errors: ['Attribute "Brand" is required'] });
  });

  it('drops empty optional', () => {
    const definitions = [def({ key: 'brand', label: 'Brand', dataType: 'TEXT', isRequired: false })];
    const result = validateAttributes(definitions, { brand: '   ' });
    expect(result).toEqual({ ok: true, value: {} });
  });

  it('rejects a JS number for NUMBER', () => {
    const definitions = [def({ key: 'area', label: 'Area', dataType: 'NUMBER', decimalPlaces: 2 })];
    const result = validateAttributes(definitions, { area: 12.5 });
    expect(result).toEqual({
      ok: false,
      errors: ['Attribute "Area" must be a number with at most 2 decimal places'],
    });
  });

  it('rejects too many decimals', () => {
    const definitions = [def({ key: 'area', label: 'Area', dataType: 'NUMBER', decimalPlaces: 2 })];
    const result = validateAttributes(definitions, { area: '1.234' });
    expect(result).toEqual({
      ok: false,
      errors: ['Attribute "Area" must be a number with at most 2 decimal places'],
    });
  });

  it('rejects 2026-02-30', () => {
    const definitions = [def({ key: 'made', label: 'Made on', dataType: 'DATE' })];
    const result = validateAttributes(definitions, { made: '2026-02-30' });
    expect(result).toEqual({ ok: false, errors: ['Attribute "Made on" must be a date (YYYY-MM-DD)'] });
  });

  it('rejects SELECT outside options', () => {
    const definitions = [
      def({ key: 'storage', label: 'Storage', dataType: 'SELECT', options: ['Ambient', 'Chilled', 'Frozen'] }),
    ];
    const result = validateAttributes(definitions, { storage: 'Boiling' });
    expect(result).toEqual({
      ok: false,
      errors: ['Attribute "Storage" must be one of: Ambient, Chilled, Frozen'],
    });
  });

  it('rejects non-boolean', () => {
    const definitions = [def({ key: 'sterile', label: 'Sterile', dataType: 'BOOLEAN' })];
    const result = validateAttributes(definitions, { sterile: 'true' });
    expect(result).toEqual({ ok: false, errors: ['Attribute "Sterile" must be true or false'] });
  });

  it('reports every error at once', () => {
    const definitions = [
      def({ key: 'brand', label: 'Brand', dataType: 'TEXT' }),
      def({ key: 'area', label: 'Area', dataType: 'NUMBER', decimalPlaces: 2 }),
      def({ key: 'storage', label: 'Storage', dataType: 'SELECT', options: ['Ambient', 'Chilled'] }),
    ];
    const result = validateAttributes(definitions, {
      brand: 'x'.repeat(201),
      area: '1.234',
      storage: 'Boiling',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});
