import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import { auDefaultTaxCode, auTaxCode, type GstDirection } from '../../config/taxPacks/au.js';
import type { TaxMode } from '../../utils/documentTotals.js';

type Queryable = Pick<PoolClient, 'query'>;

export interface TaxableLine {
  taxRateBp: number;
  taxCode?: string | null | undefined;
  itemId?: string | null | undefined;
}

export interface PreparedTax<T> {
  lines: (T & { taxCode: string | null })[];
  taxMode: TaxMode;
}

/**
 * Phase 49b — the one place a document line's GST is decided, before totals.
 *
 * GENERIC: lines pass through untouched, and a tax code or inclusive pricing is
 * refused rather than silently ignored.
 *
 * AU: the code is what was sent, else the item's default, else the account's,
 * else the region default. The rate always comes from the code and the
 * client's `taxRateBp` is ignored, so a line can't claim "GST free" at 10%.
 * An unregistered business charges no GST and claims none, so it can only use
 * the BAS-excluded codes.
 */
export async function prepareTaxOnClient<T extends TaxableLine>(
  q: Queryable,
  orgId: string,
  direction: GstDirection,
  input: { lines: readonly T[]; taxMode?: TaxMode | undefined },
  accountOf: (line: T) => string | null | undefined,
): Promise<PreparedTax<T>> {
  const taxMode: TaxMode = input.taxMode ?? 'EXCLUSIVE';
  const { rows } = await q.query<{ registered: boolean }>('SELECT registered FROM gst_settings WHERE org_id = $1', [orgId]);
  const settings = rows[0];

  if (settings === undefined) {
    if (taxMode !== 'EXCLUSIVE') throw new ApiError(422, 'Tax-inclusive pricing is for Australian organizations');
    if (input.lines.some((l) => l.taxCode !== undefined && l.taxCode !== null)) {
      throw new ApiError(422, 'GST codes are for Australian organizations');
    }
    return { lines: input.lines.map((l) => ({ ...l, taxCode: null })), taxMode };
  }

  const itemIds = [...new Set(input.lines.flatMap((l) => (l.itemId === undefined || l.itemId === null ? [] : [l.itemId])))];
  const accountIds = [...new Set(input.lines.flatMap((l) => accountOf(l) ?? []))];
  const itemColumn = direction === 'SALES' ? 'sale_tax_code' : 'purchase_tax_code';
  const [items, accounts] = await Promise.all([
    q.query<{ id: string; code: string | null }>(
      `SELECT id, ${itemColumn} AS code FROM items WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, itemIds],
    ),
    q.query<{ id: string; code: string | null }>(
      'SELECT id, default_tax_code AS code FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [orgId, accountIds],
    ),
  ]);
  const itemDefaults = new Map(items.rows.map((r) => [r.id, r.code]));
  const accountDefaults = new Map(accounts.rows.map((r) => [r.id, r.code]));

  const lines = input.lines.map((line, i) => {
    const account = accountOf(line);
    const accountDefault = account === undefined || account === null ? null : (accountDefaults.get(account) ?? null);
    // An account's default may be for the other direction (a shared Asset account); it then simply does not apply.
    const usableAccountDefault = accountDefault !== null && auTaxCode(accountDefault)?.direction === direction ? accountDefault : null;
    const itemDefault = line.itemId === undefined || line.itemId === null ? null : (itemDefaults.get(line.itemId) ?? null);
    const fallback = settings.registered ? itemDefault ?? usableAccountDefault : null;
    const code = line.taxCode ?? fallback ?? auDefaultTaxCode(direction, settings.registered);

    const taxCode = auTaxCode(code);
    if (taxCode === undefined) throw new ApiError(422, `Line ${String(i + 1)}: unknown GST code "${code}"`);
    if (taxCode.direction !== direction) {
      throw new ApiError(422, `Line ${String(i + 1)}: "${taxCode.label}" is a ${taxCode.direction === 'SALES' ? 'sales' : 'purchase'} code`);
    }
    if (!settings.registered && taxCode.reported) {
      throw new ApiError(422, `Line ${String(i + 1)}: an organization not registered for GST can only use a BAS-excluded code`);
    }
    return { ...line, taxCode: code, taxRateBp: taxCode.rateBp };
  });

  return { lines, taxMode };
}

/**
 * Refuses to post a document with an uncoded line: a draft saved before the
 * organization became Australian. Runs at issue and approve, so nothing reaches
 * the BAS without a code. A deposit is exempt: it is a 0% liability movement,
 * and GST on advances is not built.
 */
export async function assertLinesCodedOnClient(
  q: Queryable,
  orgId: string,
  spec: { table: 'invoice_lines' | 'bill_lines' | 'credit_note_lines' | 'debit_note_lines'; fk: string; parent?: 'invoices' | 'bills' },
  documentId: string,
): Promise<void> {
  const { rows } = await q.query<{ uncoded: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${spec.table} l
        WHERE l.org_id = $1 AND l.${spec.fk} = $2 AND l.tax_code IS NULL
     ) AND EXISTS (SELECT 1 FROM gst_settings g WHERE g.org_id = $1)
       ${spec.parent === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM ${spec.parent} d WHERE d.org_id = $1 AND d.id = $2 AND d.kind = 'DEPOSIT')`}
       AS uncoded`,
    [orgId, documentId],
  );
  if (rows[0]?.uncoded === true) {
    throw new ApiError(422, 'Choose a GST code on every line before posting: edit and save this draft');
  }
}
