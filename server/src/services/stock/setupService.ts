import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import * as ledgerSettingsService from '../ledger-core/settingsService.js';
import { markCompletedOnClient } from '../onboardingService.js';
import {
  COMMON_UOMS,
  STOCK_INDUSTRY_PROFILES,
  suggestIndustryProfile,
} from '../../config/stockIndustryProfiles.js';
import { exampleCode } from '../../utils/stockCodePattern.js';
import { isStockIndustryKey } from '../../types/stock.js';
import type {
  StockAttributeScope,
  StockAttributeType,
  StockIndustryKey,
  StockItemType,
  StockSettings,
  StockTrackingMode,
} from '../../types/stock.js';

/**
 * StockLedger (Phase 28) — per-organization setup: choosing an industry
 * profile and applying its starting catalogue.
 *
 * Applying a profile ADDS and never removes or overwrites — switching from
 * GENERAL to REAL_ESTATE keeps the GENERAL categories, because every write
 * in `applyIndustryProfile` is `ON CONFLICT ... DO NOTHING` (or, for the
 * default code scheme, only sets a default when the org has none yet). An
 * org owns its catalogue completely after the first apply; a second apply
 * (the same profile or a different one) only ever adds what is missing.
 */

interface StockSettingsRow {
  industry_profile: string;
  updated_at: Date;
}

/** Calling ledgerSettingsService.getSettings is the rule-16-sanctioned cross-app read — never a direct `ledger_settings` query. */
export async function getStockSettings(orgId: string): Promise<StockSettings> {
  const { rows } = await pool.query<StockSettingsRow>(
    'SELECT industry_profile, updated_at FROM stock_settings WHERE org_id = $1',
    [orgId],
  );

  const suggestedProfile = suggestIndustryProfile((await ledgerSettingsService.getSettings(orgId)).industry);

  const row = rows[0];
  if (row === undefined) {
    return { configured: false, industryProfile: null, suggestedProfile, updatedAt: null };
  }

  const industryProfile = isStockIndustryKey(row.industry_profile) ? row.industry_profile : null;
  return {
    configured: true,
    industryProfile,
    suggestedProfile,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ProfileSummary {
  key: StockIndustryKey;
  name: string;
  description: string;
  locationName: string;
  categories: {
    code: string;
    name: string;
    itemType: StockItemType;
    defaultTracking: StockTrackingMode;
    attributes: { key: string; label: string; appliesTo: StockAttributeScope; dataType: StockAttributeType }[];
  }[];
  codeSchemes: { name: string; pattern: string; isDefault: boolean; example: string }[];
}

export function listProfiles(): ProfileSummary[] {
  return STOCK_INDUSTRY_PROFILES.map((profile) => {
    const firstCategoryCode = profile.categories[0]?.code ?? '';
    return {
      key: profile.key,
      name: profile.name,
      description: profile.description,
      locationName: profile.defaultLocation.name,
      categories: profile.categories.map((category) => ({
        code: category.code,
        name: category.name,
        itemType: category.itemType,
        defaultTracking: category.defaultTracking,
        attributes: category.attributes.map((a) => ({
          key: a.key,
          label: a.label,
          appliesTo: a.appliesTo,
          dataType: a.dataType,
        })),
      })),
      codeSchemes: profile.codeSchemes.map((s) => {
        const rendered = exampleCode(s.pattern, firstCategoryCode, new Date());
        return { name: s.name, pattern: s.pattern, isDefault: s.isDefault, example: rendered.ok ? rendered.value : '' };
      }),
    };
  });
}

export interface ApplyProfileResult {
  settings: StockSettings;
  created: { uoms: number; categories: number; attributes: number; codeSchemes: number; locations: number };
}

export async function applyIndustryProfile(
  orgId: string,
  userId: string,
  key: StockIndustryKey,
): Promise<ApplyProfileResult> {
  const profile = STOCK_INDUSTRY_PROFILES.find((p) => p.key === key);
  if (profile === undefined) throw new Error(`Unknown industry profile "${key}"`);

  const created = { uoms: 0, categories: 0, attributes: 0, codeSchemes: 0, locations: 0 };

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO stock_settings (org_id, industry_profile, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE SET industry_profile = EXCLUDED.industry_profile`,
      [orgId, profile.key, userId],
    );

    for (const uom of [...COMMON_UOMS, ...profile.uoms]) {
      const result = await client.query(
        `INSERT INTO stock_uoms (org_id, code, name, decimal_places, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, code) DO NOTHING`,
        [orgId, uom.code, uom.name, uom.decimalPlaces, userId],
      );
      created.uoms += result.rowCount ?? 0;
    }

    for (const category of profile.categories) {
      const result = await client.query(
        `INSERT INTO stock_categories (org_id, code, name, item_type, default_tracking, default_uom_id, created_by)
         VALUES ($1, $2, $3, $4, $5, (SELECT id FROM stock_uoms WHERE org_id = $1 AND code = $6), $7)
         ON CONFLICT (org_id, code) DO NOTHING`,
        [orgId, category.code, category.name, category.itemType, category.defaultTracking, category.defaultUomCode, userId],
      );
      created.categories += result.rowCount ?? 0;

      for (const [index, attribute] of category.attributes.entries()) {
        const optionsJson = attribute.options === null ? null : JSON.stringify(attribute.options);
        const attrResult = await client.query(
          `INSERT INTO stock_attribute_definitions
             (org_id, category_id, applies_to, key, label, data_type, options, decimal_places, is_required, sort_order, created_by)
           SELECT $1, c.id, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10
             FROM stock_categories c WHERE c.org_id = $1 AND c.code = $11
           ON CONFLICT (org_id, category_id, applies_to, key) DO NOTHING`,
          [
            orgId,
            attribute.appliesTo,
            attribute.key,
            attribute.label,
            attribute.dataType,
            optionsJson,
            attribute.decimalPlaces,
            attribute.isRequired,
            index,
            userId,
            category.code,
          ],
        );
        created.attributes += attrResult.rowCount ?? 0;
      }
    }

    for (const s of profile.codeSchemes) {
      const result = await client.query(
        `INSERT INTO stock_code_schemes (org_id, name, pattern, is_default, created_by)
         VALUES ($1, $2, $3, false, $4)
         ON CONFLICT (org_id, name) DO NOTHING`,
        [orgId, s.name, s.pattern, userId],
      );
      created.codeSchemes += result.rowCount ?? 0;

      if (s.isDefault) {
        await client.query(
          `UPDATE stock_code_schemes SET is_default = true
            WHERE org_id = $1 AND name = $2 AND is_active
              AND NOT EXISTS (SELECT 1 FROM stock_code_schemes WHERE org_id = $1 AND is_default)`,
          [orgId, s.name],
        );
      }
    }

    const locationResult = await client.query(
      `INSERT INTO stock_locations (org_id, code, name, kind, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, profile.defaultLocation.code, profile.defaultLocation.name, profile.defaultLocation.kind, userId],
    );
    created.locations += locationResult.rowCount ?? 0;

    await markCompletedOnClient(client, orgId, 'stock');
  });

  return { settings: await getStockSettings(orgId), created };
}
