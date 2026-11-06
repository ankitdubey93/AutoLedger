import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import { auDefaultTaxCode, auTaxCode, type GstDirection } from '../../config/taxPacks/au.js';
import { computeLineTotals, type TaxMode } from '../../utils/documentTotals.js';

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

export interface GrossSplit {
  taxCode: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
  /** Where the tax posts. Null when there is no tax to post. */
  taxAccountId: string | null;
  /** +1 for the code's normal side, -1 for a refund the other way. */
  sign: 1 | -1;
}

async function gstAccountOnClient(q: Queryable, orgId: string, direction: GstDirection): Promise<string> {
  const { rows } =
    direction === 'SALES'
      ? await q.query<{ id: string | null }>(
          `SELECT COALESCE(
             (SELECT tax_payable_account_id FROM ledger_invoice_settings WHERE org_id = $1),
             (SELECT id FROM accounts WHERE org_id = $1 AND code = '2140' AND is_postable)
           ) AS id`,
          [orgId],
        )
      : await q.query<{ id: string | null }>(
          `SELECT COALESCE(
             (SELECT tax_input_account_id FROM ledger_settings WHERE org_id = $1),
             (SELECT id FROM accounts WHERE org_id = $1 AND code = '1180' AND is_postable)
           ) AS id`,
          [orgId],
        );
  const id = rows[0]?.id ?? null;
  if (id === null) throw new ApiError(422, `No GST ${direction === 'SALES' ? 'collected' : 'paid'} account is available`);
  return id;
}

/**
 * Phase 49c — takes GST out of a gross amount that moved without a document.
 * `side` is the side the non-GST account is posted on.
 *
 * Returns null when there is nothing to record: no code given and no default on
 * the account, which is how wages and transfers stay off the BAS.
 */
export async function splitGrossOnClient(
  q: Queryable,
  orgId: string,
  input: { taxCode: string | null | undefined; accountId: string; grossCents: number; side: 'DEBIT' | 'CREDIT' },
): Promise<GrossSplit | null> {
  const { rows } = await q.query<{ registered: boolean }>('SELECT registered FROM gst_settings WHERE org_id = $1', [orgId]);
  const settings = rows[0];
  if (settings === undefined) {
    if (input.taxCode !== undefined && input.taxCode !== null) {
      throw new ApiError(422, 'GST codes are for Australian organizations');
    }
    return null;
  }

  let code = input.taxCode ?? null;
  if (code === null) {
    // An account's default applies only on its normal side, so a refund is a deliberate choice.
    const naturalDirection: GstDirection = input.side === 'CREDIT' ? 'SALES' : 'PURCHASES';
    const { rows: accounts } = await q.query<{ code: string | null }>(
      'SELECT default_tax_code AS code FROM accounts WHERE org_id = $1 AND id = $2',
      [orgId, input.accountId],
    );
    const accountDefault = accounts[0]?.code ?? null;
    if (accountDefault !== null && auTaxCode(accountDefault)?.direction === naturalDirection) code = accountDefault;
  }
  if (code === null) return null;

  const taxCode = auTaxCode(code);
  if (taxCode === undefined) throw new ApiError(422, `Unknown GST code "${code}"`);
  if (!settings.registered && taxCode.reported) {
    throw new ApiError(422, 'An organization not registered for GST can only use a BAS-excluded code');
  }

  const [total] = computeLineTotals(
    [{ unitPriceCents: input.grossCents, quantityMilli: 1000, taxRateBp: taxCode.rateBp }],
    'INCLUSIVE',
  );
  const netCents = total?.netCents ?? input.grossCents;
  const taxCents = total?.taxCents ?? 0;
  const normalSide = taxCode.direction === 'SALES' ? 'CREDIT' : 'DEBIT';
  return {
    taxCode: code,
    taxRateBp: taxCode.rateBp,
    netCents,
    taxCents,
    taxAccountId: taxCents > 0 ? await gstAccountOnClient(q, orgId, taxCode.direction) : null,
    sign: input.side === normalSide ? 1 : -1,
  };
}

export async function recordJournalTaxOnClient(
  q: Queryable,
  orgId: string,
  journalEntryId: string,
  details: readonly (GrossSplit & { accountId: string })[],
): Promise<void> {
  if (details.length === 0) return;
  await q.query(
    `INSERT INTO journal_tax_details
       (org_id, journal_entry_id, account_id, tax_code, tax_rate_bp, sign, net_cents, tax_cents)
     SELECT $1, $2, v.account_id, v.tax_code, v.tax_rate_bp, v.sign, v.net_cents, v.tax_cents
       FROM unnest($3::uuid[], $4::text[], $5::int[], $6::smallint[], $7::bigint[], $8::bigint[])
            AS v(account_id, tax_code, tax_rate_bp, sign, net_cents, tax_cents)`,
    [
      orgId,
      journalEntryId,
      details.map((d) => d.accountId),
      details.map((d) => d.taxCode),
      details.map((d) => d.taxRateBp),
      details.map((d) => d.sign),
      details.map((d) => d.netCents),
      details.map((d) => d.taxCents),
    ],
  );
}

/** Phase 49c — refuses a stored code that could only fail later, when a rule or draft is applied. */
export async function assertTaxCodesUsableOnClient(
  q: Queryable,
  orgId: string,
  codes: readonly (string | null | undefined)[],
): Promise<void> {
  const present = codes.filter((c): c is string => c !== null && c !== undefined);
  if (present.length === 0) return;
  const { rows } = await q.query<{ registered: boolean }>('SELECT registered FROM gst_settings WHERE org_id = $1', [orgId]);
  const settings = rows[0];
  if (settings === undefined) throw new ApiError(422, 'GST codes are for Australian organizations');
  for (const code of present) {
    const taxCode = auTaxCode(code);
    if (taxCode === undefined) throw new ApiError(422, `Unknown GST code "${code}"`);
    if (!settings.registered && taxCode.reported) {
      throw new ApiError(422, 'An organization not registered for GST can only use a BAS-excluded code');
    }
  }
}
