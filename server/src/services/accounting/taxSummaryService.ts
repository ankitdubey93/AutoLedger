import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { loadDocumentLineEvents, type DocumentDirection } from './documentLineEvents.js';
import type {
  TaxSummary,
  TaxSummaryAccountCheck,
  TaxSummaryDirection,
  TaxSummaryRow,
} from '../../types/accounting.js';

async function summarize(
  orgId: string,
  direction: DocumentDirection,
  from: string,
  to: string,
): Promise<TaxSummaryDirection> {
  const events = await loadDocumentLineEvents(orgId, direction, from, to);
  const byRate = new Map<number, { netCents: number; taxCents: number; docs: Set<string> }>();
  for (const ev of events) {
    let bucket = byRate.get(ev.taxRateBp);
    if (!bucket) {
      bucket = { netCents: 0, taxCents: 0, docs: new Set() };
      byRate.set(ev.taxRateBp, bucket);
    }
    bucket.netCents += ev.baseNetCents;
    bucket.taxCents += ev.baseTaxCents;
    bucket.docs.add(`${ev.documentKind}:${ev.documentId}:${ev.sign}`);
  }
  const rows: TaxSummaryRow[] = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBp, v]) => ({ rateBp, netCents: v.netCents, taxCents: v.taxCents, documentCount: v.docs.size }));
  return {
    rows,
    netCents: rows.reduce((s, r) => s + r.netCents, 0),
    taxCents: rows.reduce((s, r) => s + r.taxCents, 0),
  };
}

async function resolveAccount(
  orgId: string,
  configuredId: string | null | undefined,
  fallbackCode: string,
): Promise<{ id: string; code: string; name: string } | null> {
  if (configuredId !== null && configuredId !== undefined) {
    const { rows } = await pool.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM accounts WHERE org_id = $1 AND id = $2',
      [orgId, configuredId],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM accounts WHERE org_id = $1 AND code = $2 AND is_postable',
    [orgId, fallbackCode],
  );
  return rows[0] ?? null;
}

async function accountCheck(
  orgId: string,
  account: { id: string; code: string; name: string } | null,
  side: 'OUTPUT' | 'INPUT',
  reportTaxCents: number,
  from: string,
  to: string,
): Promise<TaxSummaryAccountCheck> {
  if (!account) return { account: null, glCents: 0, differenceCents: 0 - reportTaxCents };
  const { rows } = await pool.query<{ debits: string; credits: string }>(
    `SELECT COALESCE(SUM(l.base_debit_cents), 0)::text AS debits,
            COALESCE(SUM(l.base_credit_cents), 0)::text AS credits
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3 AND $4`,
    [orgId, account.id, from, to],
  );
  const debits = Number(rows[0]?.debits ?? '0');
  const credits = Number(rows[0]?.credits ?? '0');
  const glCents = side === 'OUTPUT' ? credits - debits : debits - credits;
  return { account, glCents, differenceCents: glCents - reportTaxCents };
}

export async function taxSummary(orgId: string, from: string, to: string): Promise<TaxSummary> {
  if (from > to) throw new ApiError(422, 'from must not be after to');

  const [output, input] = await Promise.all([
    summarize(orgId, 'SALES', from, to),
    summarize(orgId, 'PURCHASES', from, to),
  ]);

  const [invoiceSettings, ledgerSettings] = await Promise.all([
    pool.query<{ tax_payable_account_id: string | null }>(
      'SELECT tax_payable_account_id FROM ledger_invoice_settings WHERE org_id = $1',
      [orgId],
    ),
    pool.query<{ tax_input_account_id: string | null }>(
      'SELECT tax_input_account_id FROM ledger_settings WHERE org_id = $1',
      [orgId],
    ),
  ]);
  const [outputAccount, inputAccount] = await Promise.all([
    resolveAccount(orgId, invoiceSettings.rows[0]?.tax_payable_account_id, '2140'),
    resolveAccount(orgId, ledgerSettings.rows[0]?.tax_input_account_id, '1180'),
  ]);

  const [outputCheck, inputCheck] = await Promise.all([
    accountCheck(orgId, outputAccount, 'OUTPUT', output.taxCents, from, to),
    accountCheck(orgId, inputAccount, 'INPUT', input.taxCents, from, to),
  ]);

  return {
    from,
    to,
    output,
    input,
    netTaxPayableCents: output.taxCents - input.taxCents,
    outputCheck,
    inputCheck,
  };
}
