import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { todayInZone } from '../../utils/orgDate.js';
import {
  AU_BASE_CURRENCY,
  AU_CHART_ADDITIONS,
  AU_CHART_RENAMES,
} from '../../config/taxPacks/au.js';
import { isRegion, type BasCycle, type BasMethod, type GstBasis, type Region } from '../../config/regions.js';

/** Both `pool` and a checked-out `PoolClient` satisfy this. */
type Queryable = Pick<PoolClient, 'query'>;

export interface GstSettingsInput {
  registered: boolean;
  basis: GstBasis;
  basCycle: BasCycle;
  basMethod: BasMethod;
}

export async function getRegionOnClient(q: Queryable, orgId: string): Promise<Region> {
  const { rows } = await q.query<{ region: string }>('SELECT region FROM organizations WHERE id = $1', [orgId]);
  const region = rows[0]?.region;
  if (region === undefined) throw new ApiError(404, 'Organization not found');
  if (!isRegion(region)) throw new Error(`Unknown region "${region}" on organization ${orgId}`);
  return region;
}

export function getRegion(orgId: string): Promise<Region> {
  return getRegionOnClient(pool, orgId);
}

/**
 * The calendar date that "today" means for this organization's documents and
 * default report ranges.
 *
 * An AU organization gets its own zone: at 9am in Sydney the UTC date is still
 * yesterday, which on the first day of a quarter is the wrong BAS period. A
 * GENERIC organization keeps UTC exactly as before, even if it set a timezone
 * for its quotes (Phase 42), because that is the behaviour it signed up to.
 */
export async function regionTodayOnClient(q: Queryable, orgId: string, now: Date = new Date()): Promise<string> {
  const { rows } = await q.query<{ time_zone: string }>('SELECT time_zone FROM gst_settings WHERE org_id = $1', [orgId]);
  const zone = rows[0]?.time_zone;
  return zone === undefined ? now.toISOString().slice(0, 10) : todayInZone(zone, now);
}

export function regionToday(orgId: string, now: Date = new Date()): Promise<string> {
  return regionTodayOnClient(pool, orgId, now);
}

async function applyAustralianChartOnClient(q: Queryable, orgId: string): Promise<void> {
  // ON CONFLICT DO NOTHING keeps this idempotent and leaves alone an account
  // the organization already created under one of these codes.
  await q.query(
    `INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
     SELECT $1, v.code, v.name, v.type, true,
            (SELECT p.id FROM accounts p WHERE p.org_id = $1 AND p.code = v.parent_code)
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS v(code, name, type, parent_code)
     ON CONFLICT (org_id, code) DO NOTHING`,
    [
      orgId,
      AU_CHART_ADDITIONS.map((a) => a.code),
      AU_CHART_ADDITIONS.map((a) => a.name),
      AU_CHART_ADDITIONS.map((a) => a.type),
      AU_CHART_ADDITIONS.map((a) => a.parent),
    ],
  );

  for (const rename of AU_CHART_RENAMES) {
    await q.query('UPDATE accounts SET name = $4 WHERE org_id = $1 AND code = $2 AND name = $3', [
      orgId,
      rename.code,
      rename.from,
      rename.to,
    ]);
  }
}

/**
 * Switches an organization onto the Australian pack, on the caller's
 * transaction so the setup wizard's writes and this one commit together
 * (rule 5). Safe to repeat: a double submit from the wizard is harmless.
 *
 * Base currency: a BAS is reported in Australian dollars and base currency is
 * immutable once ledger lines exist, so an organization with postings in
 * another currency cannot become Australian. One with no postings is simply
 * moved to AUD. The organization row is locked for the check-then-write, so a
 * concurrent first posting cannot slip between them; FOR NO KEY UPDATE rather
 * than FOR UPDATE so it does not stall every foreign-key check on that row.
 */
export async function activateAustraliaOnClient(
  client: Queryable,
  orgId: string,
  gst: GstSettingsInput,
  timeZone: string,
): Promise<void> {
  const { rows } = await client.query<{ base_currency: string; has_lines: boolean }>(
    `SELECT o.base_currency,
            EXISTS (SELECT 1 FROM ledger_lines l WHERE l.org_id = o.id) AS has_lines
       FROM organizations o
      WHERE o.id = $1
      FOR NO KEY UPDATE OF o`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  if (row.base_currency.trim() !== AU_BASE_CURRENCY && row.has_lines) {
    throw new ApiError(
      409,
      `The Australian edition reports in ${AU_BASE_CURRENCY}, and this organization already has entries in ${row.base_currency.trim()}. Base currency cannot change once journal entries exist.`,
    );
  }

  await client.query(`UPDATE organizations SET region = 'AU', base_currency = $2 WHERE id = $1`, [
    orgId,
    AU_BASE_CURRENCY,
  ]);

  await client.query(
    `INSERT INTO gst_settings (org_id, registered, basis, bas_cycle, bas_method, time_zone)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET
       registered = EXCLUDED.registered,
       basis = EXCLUDED.basis,
       bas_cycle = EXCLUDED.bas_cycle,
       bas_method = EXCLUDED.bas_method,
       time_zone = EXCLUDED.time_zone`,
    [orgId, gst.registered, gst.basis, gst.basCycle, gst.basMethod, timeZone],
  );

  // An UPDATE, not an upsert: a ledger_settings row means "onboarded", so it is
  // the wizard's to create. Quotes read this column (Phase 42).
  await client.query('UPDATE ledger_settings SET timezone = $2 WHERE org_id = $1', [orgId, timeZone]);

  await applyAustralianChartOnClient(client, orgId);
}

export async function activateAustralia(orgId: string, gst: GstSettingsInput, timeZone: string): Promise<void> {
  await withTransaction((client) => activateAustraliaOnClient(client, orgId, gst, timeZone));
}

/**
 * Back to GENERIC, for an organization that chose Australia by mistake. Keeps
 * the added accounts and renames: they may already carry postings, and a chart
 * is the organization's own once created.
 */
export async function deactivateAustralia(orgId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
    const { rows } = await client.query(`SELECT 1 FROM bas_returns WHERE org_id = $1 AND status <> 'DRAFT' LIMIT 1`, [orgId]);
    if (rows.length > 0) {
      throw new ApiError(409, 'This organization has finalised a BAS, so it cannot leave the Australian edition');
    }
    await client.query(`DELETE FROM bas_returns WHERE org_id = $1`, [orgId]);
    await client.query(`UPDATE organizations SET region = 'GENERIC' WHERE id = $1`, [orgId]);
    await client.query('DELETE FROM gst_settings WHERE org_id = $1', [orgId]);
  });
}

export async function updateGstSettings(
  orgId: string,
  patch: Partial<GstSettingsInput> & { timeZone?: string },
): Promise<void> {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE gst_settings SET
         registered = COALESCE($2, registered),
         basis = COALESCE($3, basis),
         bas_cycle = COALESCE($4, bas_cycle),
         bas_method = COALESCE($5, bas_method),
         time_zone = COALESCE($6, time_zone)
       WHERE org_id = $1`,
      [
        orgId,
        patch.registered ?? null,
        patch.basis ?? null,
        patch.basCycle ?? null,
        patch.basMethod ?? null,
        patch.timeZone ?? null,
      ],
    );
    if (rowCount === 0) throw new ApiError(404, 'GST settings not found');
    if (patch.timeZone !== undefined) {
      await client.query('UPDATE ledger_settings SET timezone = $2 WHERE org_id = $1', [orgId, patch.timeZone]);
    }
  });
}
