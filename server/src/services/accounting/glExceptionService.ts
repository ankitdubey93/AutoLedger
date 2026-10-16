import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { groupedCents } from '../../utils/reportCellText.js';
import {
  GL_EXCEPTION_AMOUNT_EXEMPT_SOURCES,
  GL_EXCEPTION_BASELINE_MONTHS,
  GL_EXCEPTION_CONTRA_SHARE_BP,
  GL_EXCEPTION_DUPLICATE_WINDOW_DAYS,
  GL_EXCEPTION_MAX_RANGE_DAYS,
  GL_EXCEPTION_MIN_HISTORY_LINES,
  GL_EXCEPTION_MODIFIED_Z_THRESHOLD,
  GL_EXCEPTION_RESULT_CAP,
  GL_EXCEPTION_SIDE_EXEMPT_SOURCES,
  GL_EXCEPTION_TAX_MIN_HISTORY_LINES,
} from '../../config/constants.js';
import {
  GL_EXCEPTION_RULES,
  GL_EXCEPTION_RULE_SUBJECT,
  type CreateGlExceptionReviewInput,
  type GlException,
  type GlExceptionReport,
  type GlExceptionReview,
  type GlExceptionRule,
  type GlExceptionSubjectType,
} from '../../types/accounting.js';
import * as reportService from './reportService.js';

/**
 * Phase 45 — the GL exception report: four deterministic rules over posted
 * ledger data, plus remembered review decisions. Every query is scoped by
 * `org_id` (guardrails rule 1); statistics stay in SQL `numeric` and money
 * crosses into TypeScript as text parsed by `parseCents` (rule 3).
 */

const PG_UNIQUE_VIOLATION = '23505';
const MS_PER_DAY = 86_400_000;

/** One rule's result: rows (at most the cap) and whether the cap was hit. */
interface RuleResult {
  rows: GlException[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// UNUSUAL_AMOUNT
// ---------------------------------------------------------------------------

const UNUSUAL_AMOUNT_SQL = `
  WITH history AS (
    SELECT l.account_id,
           CASE WHEN l.base_debit_cents > 0 THEN 'D' ELSE 'C' END AS side,
           GREATEST(l.base_debit_cents, l.base_credit_cents)::numeric AS amount
      FROM ledger_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
     WHERE l.org_id = $1
       AND e.entry_date >= ($2::date - make_interval(months => $4))
       AND e.entry_date < $2::date
  ), medians AS (
    SELECT account_id, side, count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median
      FROM history GROUP BY account_id, side HAVING count(*) >= $5
  ), stats AS (
    SELECT h.account_id, h.side, m.n, m.median,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(h.amount - m.median)) AS mad
      FROM history h JOIN medians m ON m.account_id = h.account_id AND m.side = h.side
     GROUP BY h.account_id, h.side, m.n, m.median
  )
  SELECT l.id AS ledger_line_id, e.id AS entry_id, e.entry_date, a.id AS account_id, a.code, a.name,
         x.side, x.amount::bigint::text AS amount, round(s.median)::bigint::text AS median, s.n::text AS n,
         CASE WHEN s.mad > 0 THEN round((0.6745 * (x.amount - s.median) / s.mad)::numeric, 1)::text END AS z
    FROM ledger_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
    JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN l.base_debit_cents > 0 THEN 'D' ELSE 'C' END AS side,
             GREATEST(l.base_debit_cents, l.base_credit_cents)::numeric AS amount
    ) x
    JOIN stats s ON s.account_id = l.account_id AND s.side = x.side
   WHERE l.org_id = $1
     AND e.entry_date BETWEEN $2::date AND $3::date
     AND e.reverses_entry_id IS NULL
     AND e.source_type <> ALL ($7::text[])
     AND x.amount > s.median
     AND ((s.mad > 0 AND 0.6745 * (x.amount - s.median) / s.mad > $6::numeric)
       OR (s.mad = 0 AND x.amount > 2 * s.median))
   ORDER BY e.entry_date, l.id
   LIMIT $8`;

interface UnusualAmountRow {
  ledger_line_id: string;
  entry_id: string;
  entry_date: string;
  account_id: string;
  code: string;
  name: string;
  side: 'D' | 'C';
  amount: string;
  median: string;
  n: string;
  z: string | null;
}

async function unusualAmount(orgId: string, from: string, to: string, baseCurrency: string): Promise<RuleResult> {
  const { rows } = await pool.query<UnusualAmountRow>(UNUSUAL_AMOUNT_SQL, [
    orgId,
    from,
    to,
    GL_EXCEPTION_BASELINE_MONTHS,
    GL_EXCEPTION_MIN_HISTORY_LINES,
    GL_EXCEPTION_MODIFIED_Z_THRESHOLD,
    [...GL_EXCEPTION_AMOUNT_EXEMPT_SOURCES],
    GL_EXCEPTION_RESULT_CAP + 1,
  ]);
  const mapped = rows.map<GlException>((r) => {
    const median = groupedCents(parseCents(r.median));
    const amount = groupedCents(parseCents(r.amount));
    return {
      rule: 'UNUSUAL_AMOUNT',
      subjectType: 'LEDGER_LINE',
      subjectId: r.ledger_line_id,
      entryDate: r.entry_date,
      journalEntryId: r.entry_id,
      documentType: null,
      documentId: null,
      documentNumber: null,
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      amountCents: parseCents(r.amount),
      currencyCode: baseCurrency,
      expected: `Usually about ${median} (${r.side === 'D' ? 'debit' : 'credit'})`,
      actual: amount,
      reason:
        r.z !== null
          ? `Modified z-score ${r.z} against ${r.n} lines in the prior ${GL_EXCEPTION_BASELINE_MONTHS} months (threshold ${GL_EXCEPTION_MODIFIED_Z_THRESHOLD})`
          : `More than twice the usual amount; the prior ${r.n} lines were all ${median}`,
      review: null,
    };
  });
  return capped(mapped);
}

// ---------------------------------------------------------------------------
// UNEXPECTED_SIDE
// ---------------------------------------------------------------------------

const UNEXPECTED_SIDE_SQL = `
  WITH share AS (
    SELECT l.account_id, count(*) AS n, count(*) FILTER (WHERE l.base_debit_cents > 0) AS debit_n
      FROM ledger_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
     WHERE l.org_id = $1 AND e.entry_date >= ($2::date - make_interval(months => $4)) AND e.entry_date < $2::date
     GROUP BY l.account_id
  ), classified AS (
    SELECT l.id AS ledger_line_id, e.id AS entry_id, e.entry_date, a.id AS account_id, a.code, a.name, a.type,
           CASE WHEN l.base_debit_cents > 0 THEN 'D' ELSE 'C' END AS line_side,
           GREATEST(l.base_debit_cents, l.base_credit_cents)::text AS amount,
           CASE
             WHEN s.n >= $5 AND (CASE WHEN a.type = 'Revenue' THEN s.debit_n ELSE s.n - s.debit_n END) * 10000 >= s.n * $6
               THEN CASE WHEN a.type = 'Revenue' THEN 'D' ELSE 'C' END
             ELSE CASE WHEN a.type = 'Revenue' THEN 'C' ELSE 'D' END
           END AS expected_side,
           (s.n >= $5 AND (CASE WHEN a.type = 'Revenue' THEN s.debit_n ELSE s.n - s.debit_n END) * 10000 >= s.n * $6) AS is_contra
      FROM ledger_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
      LEFT JOIN share s      ON s.account_id = l.account_id
     WHERE l.org_id = $1 AND e.entry_date BETWEEN $2::date AND $3::date
       AND a.type IN ('Revenue', 'Expense')
       AND e.reverses_entry_id IS NULL
       AND e.source_type <> ALL ($7::text[])
  )
  SELECT * FROM classified WHERE line_side <> expected_side ORDER BY entry_date, ledger_line_id LIMIT $8`;

interface UnexpectedSideRow {
  ledger_line_id: string;
  entry_id: string;
  entry_date: string;
  account_id: string;
  code: string;
  name: string;
  type: string;
  line_side: 'D' | 'C';
  amount: string;
  expected_side: 'D' | 'C';
  is_contra: boolean | null;
}

async function unexpectedSide(orgId: string, from: string, to: string, baseCurrency: string): Promise<RuleResult> {
  const { rows } = await pool.query<UnexpectedSideRow>(UNEXPECTED_SIDE_SQL, [
    orgId,
    from,
    to,
    GL_EXCEPTION_BASELINE_MONTHS,
    GL_EXCEPTION_MIN_HISTORY_LINES,
    GL_EXCEPTION_CONTRA_SHARE_BP,
    [...GL_EXCEPTION_SIDE_EXEMPT_SOURCES],
    GL_EXCEPTION_RESULT_CAP + 1,
  ]);
  const sideName = (s: 'D' | 'C'): string => (s === 'D' ? 'Debit' : 'Credit');
  const mapped = rows.map<GlException>((r) => {
    const expected = sideName(r.expected_side);
    const actual = sideName(r.line_side);
    return {
      rule: 'UNEXPECTED_SIDE',
      subjectType: 'LEDGER_LINE',
      subjectId: r.ledger_line_id,
      entryDate: r.entry_date,
      journalEntryId: r.entry_id,
      documentType: null,
      documentId: null,
      documentNumber: null,
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      amountCents: parseCents(r.amount),
      currencyCode: baseCurrency,
      expected,
      actual,
      reason:
        `A ${actual.toLowerCase()} to ${r.type} account ${r.code}` +
        (r.is_contra === true ? `; this account usually carries ${expected.toLowerCase()}s` : ''),
      review: null,
    };
  });
  return capped(mapped);
}

// ---------------------------------------------------------------------------
// NON_DEFAULT_TAX
// ---------------------------------------------------------------------------

const NON_DEFAULT_TAX_INVOICE_SQL = `
  WITH modal AS (
    SELECT il.revenue_account_id AS account_id, il.tax_rate_bp,
           row_number() OVER (PARTITION BY il.revenue_account_id ORDER BY count(*) DESC, il.tax_rate_bp ASC) AS rk,
           sum(count(*)) OVER (PARTITION BY il.revenue_account_id) AS total_n
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id AND i.org_id = il.org_id
     WHERE il.org_id = $1 AND i.status = 'ISSUED' AND i.kind = 'STANDARD'
       AND i.issue_date >= ($2::date - make_interval(months => $4)) AND i.issue_date < $2::date
     GROUP BY il.revenue_account_id, il.tax_rate_bp
  )
  SELECT il.id AS line_id, i.id AS document_id, i.invoice_number AS document_number, i.issue_date AS entry_date,
         i.journal_entry_id, i.currency_code, il.net_cents::text AS net_cents, il.tax_rate_bp,
         a.id AS account_id, a.code, a.name,
         CASE WHEN it.id IS NOT NULL THEN 'ITEM' WHEN m.account_id IS NOT NULL THEN 'ACCOUNT' ELSE 'ORGANIZATION' END AS expected_source,
         COALESCE(it.sale_tax_rate_bp, m.tax_rate_bp, s.default_tax_rate_bp) AS expected_bp
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id AND i.org_id = il.org_id
    JOIN accounts a ON a.id = il.revenue_account_id AND a.org_id = il.org_id
    LEFT JOIN items it ON it.id = il.item_id AND it.org_id = il.org_id
    LEFT JOIN modal m ON m.account_id = il.revenue_account_id AND m.rk = 1 AND m.total_n >= $5
    LEFT JOIN ledger_invoice_settings s ON s.org_id = il.org_id
   WHERE il.org_id = $1 AND i.status = 'ISSUED' AND i.kind = 'STANDARD'
     AND i.issue_date BETWEEN $2::date AND $3::date
     AND il.tax_rate_bp <> COALESCE(it.sale_tax_rate_bp, m.tax_rate_bp, s.default_tax_rate_bp)
   ORDER BY i.issue_date, il.id
   LIMIT $6`;

const NON_DEFAULT_TAX_BILL_SQL = `
  WITH modal AS (
    SELECT bl.expense_account_id AS account_id, bl.tax_rate_bp,
           row_number() OVER (PARTITION BY bl.expense_account_id ORDER BY count(*) DESC, bl.tax_rate_bp ASC) AS rk,
           sum(count(*)) OVER (PARTITION BY bl.expense_account_id) AS total_n
      FROM bill_lines bl
      JOIN bills b ON b.id = bl.bill_id AND b.org_id = bl.org_id
     WHERE bl.org_id = $1 AND b.status = 'POSTED' AND b.kind = 'STANDARD'
       AND b.bill_date >= ($2::date - make_interval(months => $4)) AND b.bill_date < $2::date
     GROUP BY bl.expense_account_id, bl.tax_rate_bp
  )
  SELECT bl.id AS line_id, b.id AS document_id, b.vendor_reference AS document_number, b.bill_date AS entry_date,
         b.journal_entry_id, b.currency_code, bl.net_cents::text AS net_cents, bl.tax_rate_bp,
         a.id AS account_id, a.code, a.name,
         CASE WHEN it.id IS NOT NULL THEN 'ITEM' ELSE 'ACCOUNT' END AS expected_source,
         COALESCE(it.purchase_tax_rate_bp, m.tax_rate_bp) AS expected_bp
    FROM bill_lines bl
    JOIN bills b ON b.id = bl.bill_id AND b.org_id = bl.org_id
    JOIN accounts a ON a.id = bl.expense_account_id AND a.org_id = bl.org_id
    LEFT JOIN items it ON it.id = bl.item_id AND it.org_id = bl.org_id
    LEFT JOIN modal m ON m.account_id = bl.expense_account_id AND m.rk = 1 AND m.total_n >= $5
   WHERE bl.org_id = $1 AND b.status = 'POSTED' AND b.kind = 'STANDARD'
     AND b.bill_date BETWEEN $2::date AND $3::date
     AND bl.tax_rate_bp <> COALESCE(it.purchase_tax_rate_bp, m.tax_rate_bp)
   ORDER BY b.bill_date, bl.id
   LIMIT $6`;

interface NonDefaultTaxRow {
  line_id: string;
  document_id: string;
  document_number: string | null;
  entry_date: string;
  journal_entry_id: string | null;
  currency_code: string;
  net_cents: string;
  tax_rate_bp: number;
  account_id: string;
  code: string;
  name: string;
  expected_source: 'ITEM' | 'ACCOUNT' | 'ORGANIZATION';
  expected_bp: number;
}

const EXPECTED_SOURCE_LABEL: Readonly<Record<NonDefaultTaxRow['expected_source'], string>> = {
  ITEM: 'item default',
  ACCOUNT: 'usual rate for this account',
  ORGANIZATION: 'organization default',
};

async function nonDefaultTax(orgId: string, from: string, to: string): Promise<RuleResult> {
  const params = [
    orgId,
    from,
    to,
    GL_EXCEPTION_BASELINE_MONTHS,
    GL_EXCEPTION_TAX_MIN_HISTORY_LINES,
    GL_EXCEPTION_RESULT_CAP + 1,
  ];
  const [invoices, bills] = await Promise.all([
    pool.query<NonDefaultTaxRow>(NON_DEFAULT_TAX_INVOICE_SQL, params),
    pool.query<NonDefaultTaxRow>(NON_DEFAULT_TAX_BILL_SQL, params),
  ]);
  const map = (r: NonDefaultTaxRow, kind: 'INVOICE' | 'BILL'): GlException => ({
    rule: 'NON_DEFAULT_TAX',
    subjectType: kind === 'INVOICE' ? 'INVOICE_LINE' : 'BILL_LINE',
    subjectId: r.line_id,
    entryDate: r.entry_date,
    journalEntryId: r.journal_entry_id,
    documentType: kind,
    documentId: r.document_id,
    documentNumber: r.document_number,
    accountId: r.account_id,
    accountCode: r.code,
    accountName: r.name,
    amountCents: parseCents(r.net_cents),
    currencyCode: r.currency_code.trim(),
    expected: `${r.expected_bp / 100}% (${EXPECTED_SOURCE_LABEL[r.expected_source]})`,
    actual: `${r.tax_rate_bp / 100}%`,
    reason: 'Tax rate differs from the default for this line',
    review: null,
  });
  const truncated =
    invoices.rows.length > GL_EXCEPTION_RESULT_CAP || bills.rows.length > GL_EXCEPTION_RESULT_CAP;
  const rows = [
    ...invoices.rows.slice(0, GL_EXCEPTION_RESULT_CAP).map((r) => map(r, 'INVOICE')),
    ...bills.rows.slice(0, GL_EXCEPTION_RESULT_CAP).map((r) => map(r, 'BILL')),
  ];
  return { rows, truncated };
}

// ---------------------------------------------------------------------------
// POSSIBLE_DUPLICATE
// ---------------------------------------------------------------------------

const DUPLICATE_BILL_SQL = `
  SELECT DISTINCT ON (b2.id)
         b2.id AS document_id, b2.journal_entry_id, b2.bill_date AS entry_date, b2.vendor_reference AS document_number,
         b2.total_cents::text AS total_cents, b2.currency_code, v.name AS party_name,
         b1.vendor_reference AS earlier_number, b1.bill_date AS earlier_date
    FROM bills b2
    JOIN bills b1 ON b1.org_id = b2.org_id AND b1.vendor_id = b2.vendor_id AND b1.id <> b2.id
                 AND b1.status = 'POSTED' AND b1.kind = 'STANDARD'
                 AND b1.total_cents = b2.total_cents AND b1.currency_code = b2.currency_code
                 AND b1.bill_date >= b2.bill_date - $4::int
                 AND (b1.bill_date < b2.bill_date OR (b1.bill_date = b2.bill_date AND b1.created_at < b2.created_at))
    JOIN vendors v ON v.id = b2.vendor_id AND v.org_id = b2.org_id
   WHERE b2.org_id = $1 AND b2.status = 'POSTED' AND b2.kind = 'STANDARD'
     AND b2.bill_date BETWEEN $2::date AND $3::date
   ORDER BY b2.id, b1.bill_date DESC
   LIMIT $5`;

const DUPLICATE_INVOICE_SQL = `
  SELECT DISTINCT ON (i2.id)
         i2.id AS document_id, i2.journal_entry_id, i2.issue_date AS entry_date, i2.invoice_number AS document_number,
         i2.total_cents::text AS total_cents, i2.currency_code, c.name AS party_name,
         i1.invoice_number AS earlier_number, i1.issue_date AS earlier_date
    FROM invoices i2
    JOIN invoices i1 ON i1.org_id = i2.org_id AND i1.customer_id = i2.customer_id AND i1.id <> i2.id
                    AND i1.status = 'ISSUED' AND i1.kind = 'STANDARD'
                    AND i1.total_cents = i2.total_cents AND i1.currency_code = i2.currency_code
                    AND i1.issue_date >= i2.issue_date - $4::int
                    AND (i1.issue_date < i2.issue_date OR (i1.issue_date = i2.issue_date AND i1.created_at < i2.created_at))
    JOIN customers c ON c.id = i2.customer_id AND c.org_id = i2.org_id
   WHERE i2.org_id = $1 AND i2.status = 'ISSUED' AND i2.kind = 'STANDARD'
     AND i2.issue_date BETWEEN $2::date AND $3::date
   ORDER BY i2.id, i1.issue_date DESC
   LIMIT $5`;

interface DuplicateRow {
  document_id: string;
  journal_entry_id: string | null;
  entry_date: string;
  document_number: string | null;
  total_cents: string;
  currency_code: string;
  party_name: string;
  earlier_number: string | null;
  earlier_date: string;
}

async function possibleDuplicate(orgId: string, from: string, to: string): Promise<RuleResult> {
  const params = [orgId, from, to, GL_EXCEPTION_DUPLICATE_WINDOW_DAYS, GL_EXCEPTION_RESULT_CAP + 1];
  const [bills, invoices] = await Promise.all([
    pool.query<DuplicateRow>(DUPLICATE_BILL_SQL, params),
    pool.query<DuplicateRow>(DUPLICATE_INVOICE_SQL, params),
  ]);
  const map = (r: DuplicateRow, documentType: 'BILL' | 'INVOICE'): GlException | null => {
    if (r.journal_entry_id === null) return null;
    const kind = documentType === 'BILL' ? 'bill' : 'invoice';
    return {
      rule: 'POSSIBLE_DUPLICATE',
      subjectType: 'JOURNAL_ENTRY',
      subjectId: r.journal_entry_id,
      entryDate: r.entry_date,
      journalEntryId: r.journal_entry_id,
      documentType,
      documentId: r.document_id,
      documentNumber: r.document_number,
      accountId: null,
      accountCode: null,
      accountName: null,
      amountCents: parseCents(r.total_cents),
      currencyCode: r.currency_code.trim(),
      expected: `No other ${kind} for ${r.party_name} with this total within ${GL_EXCEPTION_DUPLICATE_WINDOW_DAYS} days`,
      actual: `Same total as ${r.earlier_number ?? `an earlier ${kind}`} dated ${r.earlier_date}`,
      reason: `Same party and total within ${GL_EXCEPTION_DUPLICATE_WINDOW_DAYS} days`,
      review: null,
    };
  };
  const truncated =
    bills.rows.length > GL_EXCEPTION_RESULT_CAP || invoices.rows.length > GL_EXCEPTION_RESULT_CAP;
  const rows = [
    ...bills.rows.slice(0, GL_EXCEPTION_RESULT_CAP).map((r) => map(r, 'BILL')),
    ...invoices.rows.slice(0, GL_EXCEPTION_RESULT_CAP).map((r) => map(r, 'INVOICE')),
  ].filter((r): r is GlException => r !== null);
  return { rows, truncated };
}

function capped(rows: GlException[]): RuleResult {
  return {
    rows: rows.slice(0, GL_EXCEPTION_RESULT_CAP),
    truncated: rows.length > GL_EXCEPTION_RESULT_CAP,
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

interface ReviewRow {
  id: string;
  rule_code: GlExceptionRule;
  ledger_line_id: string | null;
  journal_entry_id: string | null;
  invoice_line_id: string | null;
  bill_line_id: string | null;
  note: string;
  reviewed_at: Date;
  reviewed_by_name: string;
}

/** Table and column per subject type — frozen maps, never request input (rule 4). */
const SUBJECT_TABLE: Readonly<Record<GlExceptionSubjectType, string>> = Object.freeze({
  LEDGER_LINE: 'ledger_lines',
  JOURNAL_ENTRY: 'journal_entries',
  INVOICE_LINE: 'invoice_lines',
  BILL_LINE: 'bill_lines',
});

const SUBJECT_COLUMN: Readonly<Record<GlExceptionSubjectType, string>> = Object.freeze({
  LEDGER_LINE: 'ledger_line_id',
  JOURNAL_ENTRY: 'journal_entry_id',
  INVOICE_LINE: 'invoice_line_id',
  BILL_LINE: 'bill_line_id',
});

async function loadReviews(orgId: string, found: GlException[]): Promise<Map<string, GlExceptionReview>> {
  const ids: Record<GlExceptionSubjectType, string[]> = {
    LEDGER_LINE: [],
    JOURNAL_ENTRY: [],
    INVOICE_LINE: [],
    BILL_LINE: [],
  };
  for (const e of found) ids[e.subjectType].push(e.subjectId);
  const byKey = new Map<string, GlExceptionReview>();
  if (found.length === 0) return byKey;

  const { rows } = await pool.query<ReviewRow>(
    `SELECT r.id, r.rule_code, r.ledger_line_id, r.journal_entry_id, r.invoice_line_id, r.bill_line_id,
            r.note, r.reviewed_at, u.name AS reviewed_by_name
       FROM gl_exception_reviews r JOIN users u ON u.id = r.reviewed_by
      WHERE r.org_id = $1
        AND (r.ledger_line_id = ANY($2::uuid[]) OR r.journal_entry_id = ANY($3::uuid[])
          OR r.invoice_line_id = ANY($4::uuid[]) OR r.bill_line_id = ANY($5::uuid[]))`,
    [orgId, ids.LEDGER_LINE, ids.JOURNAL_ENTRY, ids.INVOICE_LINE, ids.BILL_LINE],
  );
  for (const r of rows) {
    const subjectId = r.ledger_line_id ?? r.journal_entry_id ?? r.invoice_line_id ?? r.bill_line_id;
    if (subjectId === null) continue;
    byKey.set(`${r.rule_code}:${subjectId}`, {
      id: r.id,
      note: r.note,
      reviewedAt: r.reviewed_at.toISOString(),
      reviewedByName: r.reviewed_by_name,
    });
  }
  return byKey;
}

function inclusiveDaySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY) + 1;
}

export async function listExceptions(
  orgId: string,
  options: { from: string; to: string; rules: GlExceptionRule[]; includeReviewed: boolean },
): Promise<GlExceptionReport> {
  const { from, to, includeReviewed } = options;
  if (from > to) throw new ApiError(422, 'from must not be after to');
  if (inclusiveDaySpan(from, to) > GL_EXCEPTION_MAX_RANGE_DAYS) {
    throw new ApiError(422, `The exception report covers at most ${GL_EXCEPTION_MAX_RANGE_DAYS} days`);
  }

  const requested = GL_EXCEPTION_RULES.filter((r) => options.rules.includes(r));
  const { baseCurrency } = await reportService.loadReportContext(orgId);

  const runners: Record<GlExceptionRule, () => Promise<RuleResult>> = {
    UNUSUAL_AMOUNT: () => unusualAmount(orgId, from, to, baseCurrency),
    UNEXPECTED_SIDE: () => unexpectedSide(orgId, from, to, baseCurrency),
    NON_DEFAULT_TAX: () => nonDefaultTax(orgId, from, to),
    POSSIBLE_DUPLICATE: () => possibleDuplicate(orgId, from, to),
  };
  const results = await Promise.all(requested.map((rule) => runners[rule]()));

  let truncated = false;
  const found: GlException[] = [];
  for (const result of results) {
    if (result.truncated) truncated = true;
    found.push(...result.rows);
  }

  const reviews = await loadReviews(orgId, found);
  const counts = Object.fromEntries(GL_EXCEPTION_RULES.map((r) => [r, { open: 0, reviewed: 0 }])) as Record<
    GlExceptionRule,
    { open: number; reviewed: number }
  >;
  for (const e of found) {
    e.review = reviews.get(`${e.rule}:${e.subjectId}`) ?? null;
    if (e.review === null) counts[e.rule].open += 1;
    else counts[e.rule].reviewed += 1;
  }

  const ruleOrder = (r: GlExceptionRule): number => GL_EXCEPTION_RULES.indexOf(r);
  const exceptions = found
    .filter((e) => includeReviewed || e.review === null)
    .sort(
      (a, b) =>
        (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
        ruleOrder(a.rule) - ruleOrder(b.rule) ||
        (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0),
    );

  return { from, to, rules: requested, includeReviewed, counts, exceptions, truncated };
}

export async function createReview(
  orgId: string,
  reviewedBy: string,
  input: CreateGlExceptionReviewInput,
): Promise<GlExceptionReview & { rule: GlExceptionRule; subjectType: GlExceptionSubjectType; subjectId: string }> {
  const { rule, subjectType, subjectId, note } = input;
  if (!GL_EXCEPTION_RULE_SUBJECT[rule].includes(subjectType)) {
    throw new ApiError(422, `Rule ${rule} does not apply to a ${subjectType}`);
  }

  // Table and column names come from the frozen maps above, never from input.
  const exists = await pool.query(`SELECT 1 FROM ${SUBJECT_TABLE[subjectType]} WHERE org_id = $1 AND id = $2`, [
    orgId,
    subjectId,
  ]);
  if (exists.rows.length === 0) throw new ApiError(404, 'Exception subject not found');

  let row: { id: string; note: string; reviewed_at: Date };
  try {
    const { rows } = await pool.query<{ id: string; note: string; reviewed_at: Date }>(
      `INSERT INTO gl_exception_reviews (org_id, rule_code, ${SUBJECT_COLUMN[subjectType]}, note, reviewed_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, note, reviewed_at`,
      [orgId, rule, subjectId, note, reviewedBy],
    );
    const inserted = rows[0];
    if (inserted === undefined) throw new ApiError(500, 'Review was not saved');
    row = inserted;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'This exception is already marked reviewed');
    }
    throw err;
  }

  const user = await pool.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [reviewedBy]);
  return {
    id: row.id,
    note: row.note,
    reviewedAt: row.reviewed_at.toISOString(),
    reviewedByName: user.rows[0]?.name ?? '',
    rule,
    subjectType,
    subjectId,
  };
}

export async function deleteReview(orgId: string, id: string): Promise<void> {
  const result = await pool.query('DELETE FROM gl_exception_reviews WHERE org_id = $1 AND id = $2', [orgId, id]);
  if (result.rowCount === 0) throw new ApiError(404, 'Review not found');
}
