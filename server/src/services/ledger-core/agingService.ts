import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import { allocatedCentsSubquery } from './paymentService.js';
import { AGING_BUCKETS, AGING_BUCKET_LABELS, type AgingReport } from '../../types/ledger-core.js';

/**
 * AR/AP aging and subledger reconciliation, computed from `invoices`/`bills`
 * and `ledger_lines` on every request — no summary table, same discipline as
 * `reportService.trialBalance` and `dashboardService`.
 *
 * `arAging` and `apAging` both delegate to `aging(orgId, asOf, kind)`; the
 * only differences between the two reports — table, open status,
 * counterparty table/column, allocation column, control-account fallback
 * code and normal balance side — are chosen from `AGING_CONFIG`, a
 * compile-time constant map keyed by `kind`, never built from request input
 * (guardrails rule 4).
 */

interface AgingConfig {
  table: 'invoices' | 'bills';
  openStatus: 'ISSUED' | 'POSTED';
  counterpartyTable: 'customers' | 'vendors';
  counterpartyColumn: 'customer_id' | 'vendor_id';
  allocationColumn: 'invoice_id' | 'bill_id';
  fallbackControlCode: string;
  /** Asset (AR) is debit-normal; Liability (AP) is credit-normal. */
  controlIsDebitNormal: boolean;
}

const AGING_CONFIG: Record<'AR' | 'AP', AgingConfig> = {
  AR: {
    table: 'invoices',
    openStatus: 'ISSUED',
    counterpartyTable: 'customers',
    counterpartyColumn: 'customer_id',
    allocationColumn: 'invoice_id',
    fallbackControlCode: '1120',
    controlIsDebitNormal: true,
  },
  AP: {
    table: 'bills',
    openStatus: 'POSTED',
    counterpartyTable: 'vendors',
    counterpartyColumn: 'vendor_id',
    allocationColumn: 'bill_id',
    fallbackControlCode: '2100',
    controlIsDebitNormal: false,
  },
};

/**
 * The open, outstanding documents for one report, as a `WITH` fragment. `d`
 * and `cp` are this query's own aliases — `config` fields interpolated here
 * are the frozen `AGING_CONFIG` values above, never request input.
 *
 * Base currency, not native (Phase 8): the reporting currency is the
 * organization's base currency, and a document's native amount may be in any
 * currency — summing native amounts across currencies is meaningless. Every
 * figure this CTE produces (and everything derived from it — the buckets,
 * the per-counterparty rows, the totals, and the reconciles check against
 * the base-currency GL control balance) is a base-currency figure.
 */
function buildOpenDocsCte(config: AgingConfig): string {
  return `open_docs AS (
    SELECT d.id,
           d.due_date,
           d.${config.counterpartyColumn} AS counterparty_id,
           cp.name AS counterparty_name,
           (d.base_total_cents - ${allocatedCentsSubquery('d', config.allocationColumn, 'base_amount_cents')}::bigint) AS outstanding_cents,
           CASE
             WHEN d.due_date >= $2::date THEN 'CURRENT'
             WHEN d.due_date >  $2::date - INTERVAL '30 days' THEN 'D1_30'
             WHEN d.due_date >  $2::date - INTERVAL '60 days' THEN 'D31_60'
             WHEN d.due_date >  $2::date - INTERVAL '90 days' THEN 'D61_90'
             ELSE 'D90_PLUS'
           END AS bucket
      FROM ${config.table} d
      JOIN ${config.counterpartyTable} cp ON cp.id = d.${config.counterpartyColumn} AND cp.org_id = d.org_id
     WHERE d.org_id = $1
       AND d.status = '${config.openStatus}'
  )`;
}

interface BucketRow {
  bucket: string;
  amount_cents: string;
  document_count: string;
}

async function loadBuckets(
  orgId: string,
  asOf: string,
  config: AgingConfig,
): Promise<{ buckets: AgingReport['buckets']; totalOutstandingCents: number; totalOverdueCents: number }> {
  const { rows } = await pool.query<BucketRow>(
    `WITH ${buildOpenDocsCte(config)}
     SELECT b.bucket,
            COALESCE(SUM(od.outstanding_cents), 0)::text AS amount_cents,
            COUNT(od.id)::text AS document_count
       FROM (VALUES ('CURRENT'), ('D1_30'), ('D31_60'), ('D61_90'), ('D90_PLUS')) AS b(bucket)
       LEFT JOIN open_docs od ON od.bucket = b.bucket AND od.outstanding_cents > 0
      GROUP BY b.bucket`,
    [orgId, asOf],
  );

  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  let totalOutstandingCents = 0;
  let totalOverdueCents = 0;

  const buckets = AGING_BUCKETS.map((bucket) => {
    const row = byBucket.get(bucket);
    const amountCents = row === undefined ? 0 : parseCents(row.amount_cents);
    totalOutstandingCents += amountCents;
    if (bucket !== 'CURRENT') totalOverdueCents += amountCents;
    return {
      bucket,
      label: AGING_BUCKET_LABELS[bucket],
      amountCents,
      documentCount: row === undefined ? 0 : Number(row.document_count),
    };
  });

  return { buckets, totalOutstandingCents, totalOverdueCents };
}

interface CounterpartyRow {
  counterparty_id: string;
  counterparty_name: string;
  current_cents: string;
  d1_30_cents: string;
  d31_60_cents: string;
  d61_90_cents: string;
  d90_plus_cents: string;
  total_cents: string;
}

async function loadCounterpartyRows(
  orgId: string,
  asOf: string,
  config: AgingConfig,
): Promise<AgingReport['rows']> {
  const { rows } = await pool.query<CounterpartyRow>(
    `WITH ${buildOpenDocsCte(config)}
     SELECT counterparty_id, counterparty_name,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE bucket = 'CURRENT' AND outstanding_cents > 0), 0)::text AS current_cents,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE bucket = 'D1_30'   AND outstanding_cents > 0), 0)::text AS d1_30_cents,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE bucket = 'D31_60'  AND outstanding_cents > 0), 0)::text AS d31_60_cents,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE bucket = 'D61_90'  AND outstanding_cents > 0), 0)::text AS d61_90_cents,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE bucket = 'D90_PLUS' AND outstanding_cents > 0), 0)::text AS d90_plus_cents,
            COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0), 0)::text AS total_cents
       FROM open_docs
      GROUP BY counterparty_id, counterparty_name
     HAVING COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0), 0) > 0
      ORDER BY counterparty_name ASC`,
    [orgId, asOf],
  );

  return rows.map((row) => ({
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    currentCents: parseCents(row.current_cents),
    d1to30Cents: parseCents(row.d1_30_cents),
    d31to60Cents: parseCents(row.d31_60_cents),
    d61to90Cents: parseCents(row.d61_90_cents),
    d90PlusCents: parseCents(row.d90_plus_cents),
    totalCents: parseCents(row.total_cents),
  }));
}

interface ControlAccount {
  id: string;
  code: string;
  name: string;
}

async function resolveControlAccount(
  orgId: string,
  kind: 'AR' | 'AP',
  config: AgingConfig,
): Promise<ControlAccount | null> {
  const settingsQuery =
    kind === 'AR'
      ? 'SELECT receivable_account_id AS account_id FROM ledger_invoice_settings WHERE org_id = $1'
      : 'SELECT payable_account_id AS account_id FROM ledger_settings WHERE org_id = $1';

  const { rows: settingsRows } = await pool.query<{ account_id: string | null }>(settingsQuery, [orgId]);
  const configuredId = settingsRows[0]?.account_id ?? null;

  const { rows } = await pool.query<{ id: string; code: string; name: string }>(
    configuredId !== null
      ? 'SELECT id, code, name FROM accounts WHERE org_id = $1 AND id = $2'
      : 'SELECT id, code, name FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, configuredId ?? config.fallbackControlCode],
  );

  return rows[0] ?? null;
}

async function loadControlAccountBalance(
  orgId: string,
  account: ControlAccount,
  asOf: string,
  controlIsDebitNormal: boolean,
): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(${controlIsDebitNormal ? 'l.base_debit_cents - l.base_credit_cents' : 'l.base_credit_cents - l.base_debit_cents'}), 0)::text AS balance
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.account_id = $2
        AND e.entry_date <= $3::date`,
    [orgId, account.id, asOf],
  );
  return parseCents(rows[0]?.balance ?? '0');
}

async function aging(orgId: string, asOf: string | null, kind: 'AR' | 'AP'): Promise<AgingReport> {
  const config = AGING_CONFIG[kind];
  const on = asOf ?? new Date().toISOString().slice(0, 10);

  const [{ buckets, totalOutstandingCents, totalOverdueCents }, rows, account] = await Promise.all([
    loadBuckets(orgId, on, config),
    loadCounterpartyRows(orgId, on, config),
    resolveControlAccount(orgId, kind, config),
  ]);

  let controlAccount: AgingReport['controlAccount'] = null;
  let reconciles: boolean | null = null;

  if (account !== null) {
    const balanceCents = await loadControlAccountBalance(orgId, account, on, config.controlIsDebitNormal);
    controlAccount = { id: account.id, code: account.code, name: account.name, balanceCents };
    // Integer equality — never a tolerance (guardrails rule 3).
    reconciles = totalOutstandingCents === balanceCents;
  }

  return {
    asOf: on,
    kind,
    buckets,
    totalOutstandingCents,
    totalOverdueCents,
    controlAccount,
    reconciles,
    rows,
  };
}

export async function arAging(orgId: string, asOf: string | null): Promise<AgingReport> {
  return aging(orgId, asOf, 'AR');
}

export async function apAging(orgId: string, asOf: string | null): Promise<AgingReport> {
  return aging(orgId, asOf, 'AP');
}
