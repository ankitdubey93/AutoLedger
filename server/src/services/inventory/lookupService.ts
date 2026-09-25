import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import type { StockLabelKind, StockLookupMatch } from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — scan-and-lookup: resolving an item code,
 * barcode, serial number, lot number or location code (typed, pasted from
 * a keyboard-wedge scanner, or decoded from a QR label's payload) to what
 * it names. Every branch of the UNION carries its own `org_id = $1`
 * (guardrails rule 1) — a single unscoped branch would leak another
 * tenant's code into a match list.
 */

interface MatchRow {
  kind: string;
  id: string;
  item_id: string | null;
  code: string;
  title: string;
}

function toMatch(row: MatchRow): StockLookupMatch {
  return { kind: row.kind as StockLabelKind, id: row.id, itemId: row.item_id, code: row.code, title: row.title };
}

/** `q` is trimmed, 1-100 characters — enforced by the controller before this runs. */
export async function lookup(orgId: string, q: string): Promise<StockLookupMatch[]> {
  const { rows } = await pool.query<MatchRow>(
    `SELECT 'ITEM' AS kind, i.id, i.id AS item_id, i.code, i.name AS title
       FROM stock_items i WHERE i.org_id = $1 AND i.code = upper($2)
     UNION ALL
     SELECT 'ITEM' AS kind, i.id, i.id AS item_id, i.code, i.name AS title
       FROM stock_items i WHERE i.org_id = $1 AND i.barcode = $2
     UNION ALL
     SELECT 'SERIAL' AS kind, s.id, s.item_id, s.serial_number AS code, i.name AS title
       FROM stock_serials s JOIN stock_items i ON i.id = s.item_id AND i.org_id = s.org_id
      WHERE s.org_id = $1 AND upper(s.serial_number) = upper($2)
     UNION ALL
     SELECT 'LOT' AS kind, l.id, l.item_id, (i.code || ' / ' || l.lot_number) AS code, i.name AS title
       FROM stock_lots l JOIN stock_items i ON i.id = l.item_id AND i.org_id = l.org_id
      WHERE l.org_id = $1 AND upper(l.lot_number) = upper($2)
     UNION ALL
     SELECT 'LOCATION' AS kind, loc.id, NULL AS item_id, loc.code, loc.name AS title
       FROM stock_locations loc WHERE loc.org_id = $1 AND loc.code = upper($2)
     LIMIT 20`,
    [orgId, q],
  );
  return rows.map(toMatch);
}

/** Resolves a scanned lot/serial label (whose payload carries only the id) to its match, including itemId. */
export async function lookupById(orgId: string, kind: 'LOT' | 'SERIAL', id: string): Promise<StockLookupMatch> {
  if (kind === 'LOT') {
    const { rows } = await pool.query<MatchRow>(
      `SELECT 'LOT' AS kind, l.id, l.item_id, (i.code || ' / ' || l.lot_number) AS code, i.name AS title
         FROM stock_lots l JOIN stock_items i ON i.id = l.item_id AND i.org_id = l.org_id
        WHERE l.org_id = $1 AND l.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Lot not found');
    return toMatch(row);
  }

  const { rows } = await pool.query<MatchRow>(
    `SELECT 'SERIAL' AS kind, s.id, s.item_id, s.serial_number AS code, i.name AS title
       FROM stock_serials s JOIN stock_items i ON i.id = s.item_id AND i.org_id = s.org_id
      WHERE s.org_id = $1 AND s.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Serial not found');
  return toMatch(row);
}
