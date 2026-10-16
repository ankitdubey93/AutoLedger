import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { comparisonPeriods, type ComparisonMode } from '../../utils/comparisonPeriods.js';
import { loadDocumentLineEvents, type DocumentLineEvent } from './documentLineEvents.js';
import type { SalesPurchasesReport, SalesPurchasesReportKind, SalesPurchasesRow } from '../../types/accounting.js';

interface Group {
  key: string;
  label: string;
  netCents: number;
  taxCents: number;
  quantityMilli: number;
  docs: Set<string>;
}

function groupEvents(events: DocumentLineEvent[], byItem: boolean): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const ev of events) {
    const key = byItem ? (ev.itemId ?? 'none') : ev.partyId;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: byItem ? '' : ev.partyName, netCents: 0, taxCents: 0, quantityMilli: 0, docs: new Set() };
      groups.set(key, g);
    }
    g.netCents += ev.baseNetCents;
    g.taxCents += ev.baseTaxCents;
    g.quantityMilli += ev.quantityMilli;
    g.docs.add(`${ev.documentKind}:${ev.documentId}:${ev.sign}`);
  }
  return groups;
}

export async function salesPurchasesReport(
  orgId: string,
  kind: SalesPurchasesReportKind,
  from: string,
  to: string,
  compare: ComparisonMode | null,
): Promise<SalesPurchasesReport> {
  if (from > to) throw new ApiError(422, 'from must not be after to');

  const direction = kind.startsWith('sales') ? 'SALES' : 'PURCHASES';
  const byItem = kind.endsWith('-by-item');

  const current = groupEvents(await loadDocumentLineEvents(orgId, direction, from, to), byItem);

  let comparison: SalesPurchasesReport['comparison'] = null;
  let prior = new Map<string, Group>();
  if (compare !== null) {
    const period = comparisonPeriods(from, to, compare, 1)[1];
    if (!period) throw new Error('comparisonPeriods returned no prior period');
    comparison = { from: period.from, to: period.to, label: period.label };
    prior = groupEvents(await loadDocumentLineEvents(orgId, direction, period.from, period.to), byItem);
  }

  const itemInfo = new Map<string, { code: string; name: string }>();
  if (byItem) {
    const ids = [...new Set([...current.keys(), ...prior.keys()])].filter((k) => k !== 'none');
    if (ids.length > 0) {
      const { rows } = await pool.query<{ id: string; code: string; name: string }>(
        'SELECT id, code, name FROM items WHERE org_id = $1 AND id = ANY($2::uuid[])',
        [orgId, ids],
      );
      for (const r of rows) itemInfo.set(r.id, { code: r.code, name: r.name });
    }
  }

  const keys = new Set<string>([...current.keys(), ...prior.keys()]);
  const rows: SalesPurchasesRow[] = [];
  for (const key of keys) {
    const cur = current.get(key);
    const pri = prior.get(key);
    let label: string;
    let code: string | null = null;
    if (byItem) {
      if (key === 'none') label = 'No item';
      else {
        const info = itemInfo.get(key);
        label = info?.name ?? key;
        code = info?.code ?? null;
      }
    } else {
      label = (cur ?? pri)?.label ?? key;
    }
    const netCents = cur?.netCents ?? 0;
    const taxCents = cur?.taxCents ?? 0;
    rows.push({
      key,
      label,
      code,
      quantityMilli: byItem ? (cur?.quantityMilli ?? 0) : null,
      netCents,
      taxCents,
      grossCents: netCents + taxCents,
      documentCount: cur?.docs.size ?? 0,
      comparisonNetCents: compare === null ? null : (pri?.netCents ?? 0),
    });
  }

  rows.sort((a, b) => {
    if (a.key === 'none' && b.key !== 'none') return 1;
    if (b.key === 'none' && a.key !== 'none') return -1;
    if (a.netCents !== b.netCents) return b.netCents - a.netCents;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  const totalNetCents = rows.reduce((s, r) => s + r.netCents, 0);
  const totalTaxCents = rows.reduce((s, r) => s + r.taxCents, 0);
  return {
    kind,
    from,
    to,
    comparison,
    rows,
    totalNetCents,
    totalTaxCents,
    totalGrossCents: totalNetCents + totalTaxCents,
    totalComparisonNetCents: compare === null ? null : rows.reduce((s, r) => s + (r.comparisonNetCents ?? 0), 0),
  };
}
