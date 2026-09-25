import QRCode from 'qrcode';
import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { LOCATION_TREE_CTE } from './locationService.js';
import type { StockLabel, StockLabelKind } from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — QR label generation.
 *
 * The QR payload is `${FRONTEND_URL}/inventory/scan/<kind>/<id>` — a route
 * and a UUID, nothing else. Labels printed before Phase 33 encode
 * `/app/stock/scan/...`; the client redirects that shape permanently
 * (client/src/routes/LegacyAppRedirect.tsx), so both keep working. No org id, no name, no price is ever encoded:
 * resolving the label requires a logged-in member of the owning
 * organization, because the scan page it opens calls org-scoped endpoints
 * (`lookupService.lookupById`, `itemService.getItem`). A label photographed
 * or lost therefore leaks nothing on its own — it is as useful as a bare
 * UUID to anyone who isn't already an authenticated member of that org.
 */

const MAX_LABELS = 500;

export interface LabelTarget {
  kind: StockLabelKind;
  id: string;
  copies: number;
}

interface ItemInfo {
  code: string;
  name: string;
  categoryName: string;
  uomCode: string;
}

async function loadItems(orgId: string, ids: string[]): Promise<Map<string, ItemInfo>> {
  const { rows } = await pool.query<{ id: string; code: string; name: string; category_name: string; uom_code: string }>(
    `SELECT i.id, i.code, i.name, c.name AS category_name, u.code AS uom_code
       FROM stock_items i
       JOIN stock_categories c ON c.id = i.category_id AND c.org_id = i.org_id
       JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
      WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const map = new Map<string, ItemInfo>();
  for (const row of rows) {
    map.set(row.id, { code: row.code, name: row.name, categoryName: row.category_name, uomCode: row.uom_code });
  }
  return map;
}

interface LotInfo {
  lotNumber: string;
  expiresOn: string | null;
  itemCode: string;
  itemName: string;
}

async function loadLots(orgId: string, ids: string[]): Promise<Map<string, LotInfo>> {
  const { rows } = await pool.query<{
    id: string;
    lot_number: string;
    expires_on: string | null;
    item_code: string;
    item_name: string;
  }>(
    `SELECT l.id, l.lot_number, l.expires_on, i.code AS item_code, i.name AS item_name
       FROM stock_lots l JOIN stock_items i ON i.id = l.item_id AND i.org_id = l.org_id
      WHERE l.org_id = $1 AND l.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const map = new Map<string, LotInfo>();
  for (const row of rows) {
    map.set(row.id, { lotNumber: row.lot_number, expiresOn: row.expires_on, itemCode: row.item_code, itemName: row.item_name });
  }
  return map;
}

interface SerialInfo {
  serialNumber: string;
  itemCode: string;
  itemName: string;
}

async function loadSerials(orgId: string, ids: string[]): Promise<Map<string, SerialInfo>> {
  const { rows } = await pool.query<{ id: string; serial_number: string; item_code: string; item_name: string }>(
    `SELECT s.id, s.serial_number, i.code AS item_code, i.name AS item_name
       FROM stock_serials s JOIN stock_items i ON i.id = s.item_id AND i.org_id = s.org_id
      WHERE s.org_id = $1 AND s.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const map = new Map<string, SerialInfo>();
  for (const row of rows) map.set(row.id, { serialNumber: row.serial_number, itemCode: row.item_code, itemName: row.item_name });
  return map;
}

interface LocationInfo {
  code: string;
  name: string;
  path: string;
}

async function loadLocations(orgId: string, ids: string[]): Promise<Map<string, LocationInfo>> {
  const { rows } = await pool.query<{ id: string; code: string; name: string; path: string }>(
    `${LOCATION_TREE_CTE}
     SELECT loc.id, loc.code, loc.name, tree.path
       FROM stock_locations loc JOIN tree ON tree.id = loc.id
      WHERE loc.org_id = $1 AND loc.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const map = new Map<string, LocationInfo>();
  for (const row of rows) map.set(row.id, { code: row.code, name: row.name, path: row.path });
  return map;
}

export async function buildLabels(orgId: string, targets: LabelTarget[]): Promise<StockLabel[]> {
  const totalCopies = targets.reduce((sum, t) => sum + t.copies, 0);
  if (totalCopies > MAX_LABELS) throw new ApiError(422, 'A label sheet is limited to 500 labels');

  const itemIds = targets.filter((t) => t.kind === 'ITEM').map((t) => t.id);
  const lotIds = targets.filter((t) => t.kind === 'LOT').map((t) => t.id);
  const serialIds = targets.filter((t) => t.kind === 'SERIAL').map((t) => t.id);
  const locationIds = targets.filter((t) => t.kind === 'LOCATION').map((t) => t.id);

  const [items, lots, serials, locations] = await Promise.all([
    itemIds.length > 0 ? loadItems(orgId, itemIds) : Promise.resolve(new Map<string, ItemInfo>()),
    lotIds.length > 0 ? loadLots(orgId, lotIds) : Promise.resolve(new Map<string, LotInfo>()),
    serialIds.length > 0 ? loadSerials(orgId, serialIds) : Promise.resolve(new Map<string, SerialInfo>()),
    locationIds.length > 0 ? loadLocations(orgId, locationIds) : Promise.resolve(new Map<string, LocationInfo>()),
  ]);

  const base = env.FRONTEND_URL.replace(/\/+$/, '');
  const qrCache = new Map<string, string>();

  async function qrFor(payload: string): Promise<string> {
    const cached = qrCache.get(payload);
    if (cached !== undefined) return cached;
    const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    qrCache.set(payload, svg);
    return svg;
  }

  const labels: StockLabel[] = [];
  for (const target of targets) {
    let code: string;
    let title: string;
    let subtitle: string;

    if (target.kind === 'ITEM') {
      const item = items.get(target.id);
      if (item === undefined) throw new ApiError(404, 'Item not found');
      code = item.code;
      title = item.name;
      subtitle = `${item.categoryName} · ${item.uomCode}`;
    } else if (target.kind === 'LOT') {
      const lot = lots.get(target.id);
      if (lot === undefined) throw new ApiError(404, 'Lot not found');
      code = `${lot.itemCode} / ${lot.lotNumber}`;
      title = lot.itemName;
      subtitle = lot.expiresOn === null ? 'No expiry' : `Exp ${lot.expiresOn}`;
    } else if (target.kind === 'SERIAL') {
      const serial = serials.get(target.id);
      if (serial === undefined) throw new ApiError(404, 'Serial not found');
      code = serial.serialNumber;
      title = serial.itemName;
      subtitle = serial.itemCode;
    } else {
      const location = locations.get(target.id);
      if (location === undefined) throw new ApiError(404, 'Location not found');
      code = location.code;
      title = location.name;
      subtitle = location.path;
    }

    const payload = `${base}/inventory/scan/${target.kind.toLowerCase()}/${target.id}`;
    const qrSvg = await qrFor(payload);

    labels.push({ kind: target.kind, id: target.id, code, title, subtitle, payload, qrSvg, copies: target.copies });
  }

  return labels;
}
