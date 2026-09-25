import { describe, expect, it } from 'vitest';
import {
  CODE_SCHEME_PRESETS,
  COMMON_UOMS,
  STOCK_INDUSTRY_PROFILES,
  suggestIndustryProfile,
} from '../config/inventoryIndustryProfiles.js';
import { parseCodePattern } from '../utils/stockCodePattern.js';
import { STOCK_INDUSTRY_KEYS } from '../types/inventory.js';

/** Inventory (Phase 28) — the industry-profile catalogue. Pure unit tier. */

describe('STOCK_INDUSTRY_PROFILES', () => {
  it('has one profile per industry key', () => {
    const keys = STOCK_INDUSTRY_PROFILES.map((p) => p.key).sort();
    expect(keys).toEqual([...STOCK_INDUSTRY_KEYS].sort());
  });

  it('every profile has exactly one default scheme and every scheme parses', () => {
    for (const profile of STOCK_INDUSTRY_PROFILES) {
      const defaults = profile.codeSchemes.filter((s) => s.isDefault);
      expect(defaults, `${profile.key} default count`).toHaveLength(1);
      for (const s of profile.codeSchemes) {
        const parsed = parseCodePattern(s.pattern);
        expect(parsed.ok, `${profile.key} scheme "${s.name}" (${s.pattern}) must parse`).toBe(true);
      }
    }
  });

  it('every category default UoM exists in COMMON_UOMS or the profile uoms', () => {
    const commonCodes = new Set(COMMON_UOMS.map((u) => u.code));
    for (const profile of STOCK_INDUSTRY_PROFILES) {
      const profileCodes = new Set(profile.uoms.map((u) => u.code));
      for (const category of profile.categories) {
        const available = commonCodes.has(category.defaultUomCode) || profileCodes.has(category.defaultUomCode);
        expect(available, `${profile.key}/${category.code} default UoM "${category.defaultUomCode}"`).toBe(true);
      }
    }
  });

  it('serial categories use a whole-number UoM', () => {
    const commonByCode = new Map(COMMON_UOMS.map((u) => [u.code, u]));
    for (const profile of STOCK_INDUSTRY_PROFILES) {
      const profileByCode = new Map(profile.uoms.map((u) => [u.code, u]));
      for (const category of profile.categories) {
        if (category.defaultTracking !== 'SERIAL') continue;
        const uom = commonByCode.get(category.defaultUomCode) ?? profileByCode.get(category.defaultUomCode);
        expect(uom, `${profile.key}/${category.code} UoM must exist`).toBeDefined();
        expect(uom?.decimalPlaces, `${profile.key}/${category.code} UoM must be whole-number`).toBe(0);
      }
    }
  });

  it('category codes and attribute keys are unique and valid', () => {
    const codeShape = /^[A-Z0-9]{2,10}$/;
    for (const profile of STOCK_INDUSTRY_PROFILES) {
      const codes = profile.categories.map((c) => c.code);
      expect(new Set(codes).size, `${profile.key} category codes unique`).toBe(codes.length);
      for (const category of profile.categories) {
        expect(category.code, `${profile.key}/${category.code} code shape`).toMatch(codeShape);
        const keys = category.attributes.map((a) => a.key);
        expect(new Set(keys).size, `${profile.key}/${category.code} attribute keys unique`).toBe(keys.length);
      }
    }
  });

  it('SELECT attributes have options; others do not', () => {
    for (const profile of STOCK_INDUSTRY_PROFILES) {
      for (const category of profile.categories) {
        for (const attribute of category.attributes) {
          if (attribute.dataType === 'SELECT') {
            expect(attribute.options, `${profile.key}/${category.code}/${attribute.key}`).not.toBeNull();
            expect((attribute.options ?? []).length).toBeGreaterThan(0);
          } else {
            expect(attribute.options, `${profile.key}/${category.code}/${attribute.key}`).toBeNull();
          }
        }
      }
    }
  });
});

describe('CODE_SCHEME_PRESETS', () => {
  it('every preset parses', () => {
    expect(CODE_SCHEME_PRESETS).toHaveLength(7);
    for (const preset of CODE_SCHEME_PRESETS) {
      const parsed = parseCodePattern(preset.pattern);
      expect(parsed.ok, `preset "${preset.name}" (${preset.pattern}) must parse`).toBe(true);
    }
  });
});

describe('suggestIndustryProfile', () => {
  it('suggests MANUFACTURING for "Steel fabrication"', () => {
    expect(suggestIndustryProfile('Steel fabrication')).toBe('MANUFACTURING');
  });

  it('suggests REAL_ESTATE for "Real Estate Developer"', () => {
    expect(suggestIndustryProfile('Real Estate Developer')).toBe('REAL_ESTATE');
  });

  it('suggests GENERAL for null and for "Consulting"', () => {
    expect(suggestIndustryProfile(null)).toBe('GENERAL');
    expect(suggestIndustryProfile('Consulting')).toBe('GENERAL');
  });
});
