import { describe, expect, it } from 'vitest';
import { loadFixture, loadManifest, resolveMonth } from '../../services/sandbox/sandboxManifest.js';
import {
  accountsFixtureSchema,
  customersFixtureSchema,
  vendorsFixtureSchema,
  fxRatesFixtureSchema,
  bankImportFixtureSchema,
  forecasterPlanFixtureSchema,
  fpaModelFixtureSchema,
  uniteconSettingsFixtureSchema,
  apFlowDocumentsFixtureSchema,
  taxguardActFixtureSchema,
} from '../../schemas/sandboxSchema.js';

/**
 * Unit tier — no database. Every sandbox fixture parses against its schema,
 * and the relative-date / decimal-money rules `sandbox/README.md` states
 * are actually followed, not merely documented. A malformed fixture fails
 * here, in CI, rather than at demo time.
 */

const ABSOLUTE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Recursively asserts no string value in `value` looks like an absolute date. */
function assertNoAbsoluteDates(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (ABSOLUTE_DATE.test(value)) {
      throw new Error(`Absolute date "${value}" found at ${path} — fixtures must use monthOffset/day`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoAbsoluteDates(v, `${path}[${String(i)}]`);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      assertNoAbsoluteDates(v, `${path}.${k}`);
    }
  }
}

/** Recursively asserts every value under a money-ish key is a decimal string, never a bare number. */
function assertMoneyLooksLikeStrings(value: unknown, path: string): void {
  // fieldConfidence is a Record<string, number> of 0..1 confidence scores —
  // its keys ("subtotal", "tax", ...) name the FIELD being scored, not an
  // amount, and a legitimate float lives under each one.
  if (path.endsWith('.fieldConfidence')) return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertMoneyLooksLikeStrings(v, `${path}[${String(i)}]`);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      // Fields ending in "Cents" or "Bps" are legitimately integers in these
      // fixtures (forecaster/fpa-engine take pre-scaled integer inputs
      // directly) — only the free-text decimal-money fields ("amount",
      // "total", "subtotal", "tax", the FX "rate") must stay strings.
      if (/^(amount|total|subtotal|tax)$/i.test(k) && typeof v !== 'string') {
        throw new Error(`Money field "${k}" at ${path} is not a string: ${JSON.stringify(v)}`);
      }
      assertMoneyLooksLikeStrings(v, `${path}.${k}`);
    }
  }
}

describe('sandbox fixtures', () => {
  it('manifest.json parses and declares all seven app slugs', async () => {
    const manifest = await loadManifest();
    expect(manifest.apps.sort()).toEqual(
      ['ledger-core', 'ap-flow', 'forecaster', 'fpa-engine', 'unitecon', 'boarddeck', 'taxguard'].sort(),
    );
    expect(manifest.months).toBe(24);
  });

  it('every ledger-core fixture parses against its schema', async () => {
    await expect(loadFixture('ledger-core/accounts.json', accountsFixtureSchema)).resolves.toBeDefined();
    await expect(loadFixture('ledger-core/customers.json', customersFixtureSchema)).resolves.toBeDefined();
    await expect(loadFixture('ledger-core/vendors.json', vendorsFixtureSchema)).resolves.toBeDefined();
    await expect(loadFixture('ledger-core/fx-rates.json', fxRatesFixtureSchema)).resolves.toBeDefined();
    await expect(loadFixture('ledger-core/bank-import.json', bankImportFixtureSchema)).resolves.toBeDefined();
  });

  it('every forecaster/fpa-engine/unitecon fixture parses against its schema', async () => {
    await expect(
      loadFixture('forecaster/plan.json', forecasterPlanFixtureSchema),
    ).resolves.toBeDefined();
    await expect(loadFixture('fpa-engine/model.json', fpaModelFixtureSchema)).resolves.toBeDefined();
    await expect(
      loadFixture('unitecon/settings.json', uniteconSettingsFixtureSchema),
    ).resolves.toBeDefined();
  });

  it('every ap-flow and taxguard fixture parses against its schema', async () => {
    await expect(
      loadFixture('ap-flow/documents.json', apFlowDocumentsFixtureSchema),
    ).resolves.toBeDefined();
    await expect(loadFixture('taxguard/sample-act.json', taxguardActFixtureSchema)).resolves.toBeDefined();
  });

  it('no fixture contains an absolute date', async () => {
    const customers = await loadFixture('ledger-core/customers.json', customersFixtureSchema);
    const vendors = await loadFixture('ledger-core/vendors.json', vendorsFixtureSchema);
    const fxRates = await loadFixture('ledger-core/fx-rates.json', fxRatesFixtureSchema);
    const bankImport = await loadFixture('ledger-core/bank-import.json', bankImportFixtureSchema);
    const plan = await loadFixture('forecaster/plan.json', forecasterPlanFixtureSchema);
    const model = await loadFixture('fpa-engine/model.json', fpaModelFixtureSchema);
    const apFlow = await loadFixture('ap-flow/documents.json', apFlowDocumentsFixtureSchema);

    for (const [name, fixture] of Object.entries({ customers, vendors, fxRates, bankImport, plan, model, apFlow })) {
      assertNoAbsoluteDates(fixture, name);
    }
  });

  it('every free-text money value is a decimal string, never a JSON number', async () => {
    const customers = await loadFixture('ledger-core/customers.json', customersFixtureSchema);
    const vendors = await loadFixture('ledger-core/vendors.json', vendorsFixtureSchema);
    const apFlow = await loadFixture('ap-flow/documents.json', apFlowDocumentsFixtureSchema);
    const bankImport = await loadFixture('ledger-core/bank-import.json', bankImportFixtureSchema);

    for (const c of customers.customers) {
      for (const m of c.monthly) expect(typeof m).toBe('string');
    }
    for (const v of vendors.vendors) {
      for (const m of v.monthly) expect(typeof m).toBe('string');
    }
    assertMoneyLooksLikeStrings(apFlow, 'ap-flow/documents.json');
    assertMoneyLooksLikeStrings(bankImport, 'ledger-core/bank-import.json');
  });

  describe('resolveMonth', () => {
    it('resolves an offset and day against an anchor month', () => {
      expect(resolveMonth('2026-09-01', -23, 15)).toBe('2024-10-15');
      expect(resolveMonth('2026-09-01', 0, 1)).toBe('2026-09-01');
      expect(resolveMonth('2026-09-01', -1, 28)).toBe('2026-08-28');
    });

    it('rolls over a year boundary correctly', () => {
      expect(resolveMonth('2026-01-01', -1, 1)).toBe('2025-12-01');
      expect(resolveMonth('2025-12-01', 1, 1)).toBe('2026-01-01');
    });

    it('throws on a day outside 1..28', () => {
      expect(() => resolveMonth('2026-09-01', 0, 29)).toThrow(/day must be 1..28/);
      expect(() => resolveMonth('2026-09-01', 0, 0)).toThrow(/day must be 1..28/);
    });

    it('throws on a malformed anchor month', () => {
      expect(() => resolveMonth('2026-09-15', 0, 1)).toThrow(/anchorMonth must be/);
    });
  });
});
