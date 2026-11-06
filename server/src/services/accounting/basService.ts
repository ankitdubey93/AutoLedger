import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { auTaxCode } from '../../config/taxPacks/au.js';
import type { BasCycle, BasMethod, GstBasis } from '../../config/regions.js';
import { ApiError } from '../../utils/apiError.js';
import { basDueDate, basPeriodContaining, isBasPeriodStart, previousBasPeriod, type BasPeriod } from '../../utils/basPeriods.js';
import {
  basSummary,
  computeWorksheet,
  divideBy11,
  FULL_LABELS,
  labelsForEvent,
  SIMPLER_LABELS,
  type BasLabels,
  type BasSummary,
} from '../../utils/basWorksheet.js';
import * as fiscalPeriodService from './fiscalPeriodService.js';
import { loadGstEvents, type GstEvent, type GstSourceKind } from './gstEventService.js';
import * as journalService from './journalService.js';
import { regionToday } from './regionService.js';
import { gstAccountOnClient } from './taxCodeService.js';

export type BasStatus = 'DRAFT' | 'FINALISED' | 'LODGED';

/** The return's lifecycle, in one table (rule 10). A lodged return has no way out. */
const BAS_TRANSITIONS: Record<BasStatus, readonly BasStatus[]> = {
  DRAFT: ['FINALISED'],
  FINALISED: ['DRAFT', 'LODGED'],
  LODGED: [],
};

function assertTransition(from: BasStatus, to: BasStatus): void {
  if (!BAS_TRANSITIONS[from].includes(to)) {
    throw new ApiError(409, `A ${from.toLowerCase()} BAS cannot become ${to.toLowerCase()}`);
  }
}

interface ReturnRow {
  id: string;
  period_start: string;
  period_end: string;
  basis: GstBasis;
  method: BasMethod;
  cycle: BasCycle;
  status: BasStatus;
  due_date: string;
  w1_cents: string;
  w2_cents: string;
  instalment_cents: string;
  lodged_on: string | null;
  ato_reference: string | null;
  clearing_journal_entry_id: string | null;
  finalised_at: Date | null;
  lodged_at: Date | null;
}

const RETURN_COLUMNS = `id, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
  basis, method, cycle, status, to_char(due_date, 'YYYY-MM-DD') AS due_date,
  w1_cents::text AS w1_cents, w2_cents::text AS w2_cents, instalment_cents::text AS instalment_cents,
  to_char(lodged_on, 'YYYY-MM-DD') AS lodged_on, ato_reference, clearing_journal_entry_id, finalised_at, lodged_at`;

export interface BasReturnSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  basis: GstBasis;
  method: BasMethod;
  cycle: BasCycle;
  status: BasStatus;
  dueDate: string;
  lodgedOn: string | null;
  atoReference: string | null;
  clearingJournalEntryId: string | null;
  w1Cents: number;
  w2Cents: number;
  instalmentCents: number;
}

function toSummary(row: ReturnRow): BasReturnSummary {
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    basis: row.basis,
    method: row.method,
    cycle: row.cycle,
    status: row.status,
    dueDate: row.due_date,
    lodgedOn: row.lodged_on,
    atoReference: row.ato_reference,
    clearingJournalEntryId: row.clearing_journal_entry_id,
    w1Cents: Number(row.w1_cents),
    w2Cents: Number(row.w2_cents),
    instalmentCents: Number(row.instalment_cents),
  };
}

export interface BasAdjustment {
  id: string;
  label: 'G7' | 'G18';
  grossCents: number;
  taxCents: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  reason: string;
}

export interface BasReconciliationSide {
  /** Movement on the GST account over the period, excluding BAS clearing journals. */
  glCents: number;
  /** GST this return reports, excluding manual adjustments. */
  reportedCents: number;
  /** On a cash basis: GST on documents issued but not yet paid, as it moved over the period. Zero on accruals. */
  unpaidMovementCents: number;
  /** What the first three leave unexplained. Should be zero. */
  differenceCents: number;
}

export interface BasWarning {
  code: 'UNCODED_LINES' | 'DEPOSITS_IN_PERIOD' | 'PERIOD_NOT_ENDED' | 'WORKSHEET_DIFFERS';
  message: string;
}

export interface BasDetail extends BasReturnSummary {
  labels: BasLabels;
  /** The labels this return's method reports, in order. */
  reportedLabels: readonly string[];
  summary: BasSummary;
  adjustments: BasAdjustment[];
  warnings: BasWarning[];
  reconciliation: { sales: BasReconciliationSide; purchases: BasReconciliationSide } | null;
  /** From the ledger, to help fill W1 and W2. Null once finalised. */
  paygSuggestion: { w1Cents: number; w2Cents: number } | null;
}

async function requireReturn(q: Pick<PoolClient, 'query'>, orgId: string, id: string, lock = false): Promise<ReturnRow> {
  const { rows } = await q.query<ReturnRow>(
    `SELECT ${RETURN_COLUMNS} FROM bas_returns WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'BAS not found');
  return row;
}

async function loadAdjustments(q: Pick<PoolClient, 'query'>, orgId: string, id: string): Promise<BasAdjustment[]> {
  const { rows } = await q.query<{
    id: string;
    label: 'G7' | 'G18';
    gross_cents: string;
    tax_cents: string;
    account_id: string;
    code: string;
    name: string;
    reason: string;
  }>(
    `SELECT j.id, j.label, j.gross_cents::text AS gross_cents, j.tax_cents::text AS tax_cents, j.account_id, a.code, a.name, j.reason
       FROM bas_return_adjustments j
       JOIN accounts a ON a.id = j.account_id AND a.org_id = j.org_id
      WHERE j.org_id = $1 AND j.bas_return_id = $2
      ORDER BY j.created_at, j.id`,
    [orgId, id],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    grossCents: Number(r.gross_cents),
    taxCents: Number(r.tax_cents),
    accountId: r.account_id,
    accountCode: r.code,
    accountName: r.name,
    reason: r.reason,
  }));
}

function eventTax(events: readonly GstEvent[], direction: 'SALES' | 'PURCHASES'): number {
  return events.reduce((sum, e) => (auTaxCode(e.taxCode)?.direction === direction ? sum + e.taxCents : sum), 0);
}

async function glMovement(orgId: string, accountId: string, side: 'CREDIT' | 'DEBIT', from: string, to: string): Promise<number> {
  const { rows } = await pool.query<{ debits: string; credits: string }>(
    `SELECT COALESCE(SUM(l.base_debit_cents), 0)::text AS debits, COALESCE(SUM(l.base_credit_cents), 0)::text AS credits
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3 AND $4
        AND e.source_type IS DISTINCT FROM 'bas_return'`,
    [orgId, accountId, from, to],
  );
  const debits = Number(rows[0]?.debits ?? '0');
  const credits = Number(rows[0]?.credits ?? '0');
  return side === 'CREDIT' ? credits - debits : debits - credits;
}

async function reconcile(orgId: string, row: ReturnRow, events: readonly GstEvent[]): Promise<BasDetail['reconciliation']> {
  const { accrualTax } = await accrualTaxTotals(orgId, row);
  const [salesAccount, purchasesAccount] = await Promise.all([
    gstAccountOnClient(pool, orgId, 'SALES'),
    gstAccountOnClient(pool, orgId, 'PURCHASES'),
  ]);
  const side = async (direction: 'SALES' | 'PURCHASES', accountId: string, normal: 'CREDIT' | 'DEBIT'): Promise<BasReconciliationSide> => {
    const glCents = await glMovement(orgId, accountId, normal, row.period_start, row.period_end);
    const reportedCents = eventTax(events, direction);
    const unpaidMovementCents = row.basis === 'CASH' ? accrualTax[direction] - reportedCents : 0;
    return { glCents, reportedCents, unpaidMovementCents, differenceCents: glCents - reportedCents - unpaidMovementCents };
  };
  return { sales: await side('SALES', salesAccount, 'CREDIT'), purchases: await side('PURCHASES', purchasesAccount, 'DEBIT') };
}

async function accrualTaxTotals(orgId: string, row: ReturnRow): Promise<{ accrualTax: Record<'SALES' | 'PURCHASES', number> }> {
  const { events } = await loadGstEvents(orgId, row.period_start, row.period_end, 'ACCRUAL');
  return { accrualTax: { SALES: eventTax(events, 'SALES'), PURCHASES: eventTax(events, 'PURCHASES') } };
}

async function warningsFor(orgId: string, row: ReturnRow, uncodedLineCount: number, labels: BasLabels): Promise<BasWarning[]> {
  const warnings: BasWarning[] = [];
  if (uncodedLineCount > 0) {
    warnings.push({
      code: 'UNCODED_LINES',
      message: `${String(uncodedLineCount)} line(s) in this period have no GST code and are left out. They were posted before this organization became Australian.`,
    });
  }
  const { rows } = await pool.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM invoices i JOIN journal_entries e ON e.id = i.journal_entry_id AND e.org_id = i.org_id
         WHERE i.org_id = $1 AND i.kind = 'DEPOSIT' AND e.entry_date BETWEEN $2 AND $3)
       +
       (SELECT count(*) FROM bills b JOIN journal_entries e ON e.id = b.journal_entry_id AND e.org_id = b.org_id
         WHERE b.org_id = $1 AND b.kind = 'DEPOSIT' AND e.entry_date BETWEEN $2 AND $3)
     )::text AS n`,
    [orgId, row.period_start, row.period_end],
  );
  const deposits = Number(rows[0]?.n ?? '0');
  if (deposits > 0) {
    warnings.push({
      code: 'DEPOSITS_IN_PERIOD',
      message: `${String(deposits)} deposit(s) were raised in this period and carry no GST. GST on a deposit may be due when it is received; check with your BAS agent and use an adjustment if so.`,
    });
  }
  if ((await regionToday(orgId)) <= row.period_end) {
    warnings.push({ code: 'PERIOD_NOT_ENDED', message: 'This period has not ended yet, so these figures can still change.' });
  }
  const salesGap = Math.abs((labels.G9 ?? 0) - (labels['1A'] ?? 0));
  const purchasesGap = Math.abs((labels.G20 ?? 0) - (labels['1B'] ?? 0));
  if (salesGap > 100 || purchasesGap > 100) {
    warnings.push({
      code: 'WORKSHEET_DIFFERS',
      message: 'GST calculated from the worksheet differs from the GST on your transactions by more than $1. Review the coded lines.',
    });
  }
  return warnings;
}

async function paygSuggestion(orgId: string, row: ReturnRow): Promise<BasDetail['paygSuggestion']> {
  const { rows } = await pool.query<{ code: string; debits: string; credits: string }>(
    `SELECT a.code, COALESCE(SUM(l.base_debit_cents), 0)::text AS debits, COALESCE(SUM(l.base_credit_cents), 0)::text AS credits
       FROM accounts a
       LEFT JOIN ledger_lines l ON l.account_id = a.id AND l.org_id = a.org_id
       LEFT JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      WHERE a.org_id = $1 AND a.code IN ('6100', '2162')
        AND (l.id IS NULL OR e.entry_date BETWEEN $2 AND $3)
        AND (e.id IS NULL OR e.source_type IS DISTINCT FROM 'bas_return')
      GROUP BY a.code`,
    [orgId, row.period_start, row.period_end],
  );
  const by = new Map(rows.map((r) => [r.code, r]));
  const wages = by.get('6100');
  const withheld = by.get('2162');
  return {
    w1Cents: wages === undefined ? 0 : Math.max(0, Number(wages.debits) - Number(wages.credits)),
    w2Cents: withheld === undefined ? 0 : Math.max(0, Number(withheld.credits) - Number(withheld.debits)),
  };
}

export async function getBas(orgId: string, id: string): Promise<BasDetail> {
  const row = await requireReturn(pool, orgId, id);
  const adjustments = await loadAdjustments(pool, orgId, id);
  const reportedLabels = row.method === 'FULL' ? FULL_LABELS : SIMPLER_LABELS;

  if (row.status === 'DRAFT') {
    const { events, uncodedLineCount } = await loadGstEvents(orgId, row.period_start, row.period_end, row.basis);
    const labels = computeWorksheet(events, adjustments);
    return {
      ...toSummary(row),
      labels,
      reportedLabels,
      summary: basSummary(labels, Number(row.w2_cents), Number(row.instalment_cents)),
      adjustments,
      warnings: await warningsFor(orgId, row, uncodedLineCount, labels),
      reconciliation: await reconcile(orgId, row, events),
      paygSuggestion: await paygSuggestion(orgId, row),
    };
  }

  const { rows: labelRows } = await pool.query<{ label: string; cents: string }>(
    'SELECT label, cents::text AS cents FROM bas_return_labels WHERE org_id = $1 AND bas_return_id = $2',
    [orgId, id],
  );
  const labels: BasLabels = Object.fromEntries(labelRows.map((r) => [r.label, Number(r.cents)]));
  return {
    ...toSummary(row),
    labels,
    reportedLabels,
    summary: basSummary(labels, Number(row.w2_cents), Number(row.instalment_cents)),
    adjustments,
    warnings: [],
    reconciliation: null,
    paygSuggestion: null,
  };
}

export interface BasPeriodSuggestion extends BasPeriod {
  dueDate: string;
}

/** Returns, newest first, plus the last completed and the current period if they have no return yet. */
export async function listBas(orgId: string): Promise<{ returns: BasReturnSummary[]; suggested: BasPeriodSuggestion[] }> {
  const { rows } = await pool.query<ReturnRow>(
    `SELECT ${RETURN_COLUMNS} FROM bas_returns WHERE org_id = $1 ORDER BY period_start DESC`,
    [orgId],
  );
  const { rows: settings } = await pool.query<{ bas_cycle: BasCycle }>('SELECT bas_cycle FROM gst_settings WHERE org_id = $1', [orgId]);
  const cycle = settings[0]?.bas_cycle ?? 'QUARTERLY';
  const current = basPeriodContaining(await regionToday(orgId), cycle);
  const candidates = [previousBasPeriod(current, cycle), current];
  const taken = (p: BasPeriod): boolean => rows.some((r) => r.period_start <= p.end && r.period_end >= p.start);
  return {
    returns: rows.map(toSummary),
    suggested: candidates.filter((p) => !taken(p)).map((p) => ({ ...p, dueDate: basDueDate(p.end, cycle) })),
  };
}

const PG_EXCLUSION_VIOLATION = '23P01';

export async function createBas(orgId: string, userId: string, periodStart: string): Promise<BasDetail> {
  const { rows: settings } = await pool.query<{ registered: boolean; basis: GstBasis; bas_method: BasMethod; bas_cycle: BasCycle }>(
    'SELECT registered, basis, bas_method, bas_cycle FROM gst_settings WHERE org_id = $1',
    [orgId],
  );
  const gst = settings[0];
  if (gst === undefined) throw new ApiError(403, 'This feature is not available for this organization\'s country');
  if (!isBasPeriodStart(periodStart, gst.bas_cycle)) {
    throw new ApiError(422, `${periodStart} is not the start of a ${gst.bas_cycle.toLowerCase()} BAS period`);
  }
  const period = basPeriodContaining(periodStart, gst.bas_cycle);
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bas_returns (org_id, period_start, period_end, basis, method, cycle, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, period.start, period.end, gst.basis, gst.bas_method, gst.bas_cycle, basDueDate(period.end, gst.bas_cycle), userId],
    );
    return await getBas(orgId, rows[0]?.id ?? '');
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_EXCLUSION_VIOLATION) {
      throw new ApiError(409, 'A BAS already covers this period');
    }
    throw err;
  }
}

export async function updateBas(
  orgId: string,
  id: string,
  input: { w1Cents?: number | undefined; w2Cents?: number | undefined; instalmentCents?: number | undefined },
): Promise<BasDetail> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    if (row.status !== 'DRAFT') throw new ApiError(409, 'Only a draft BAS can be edited');
    await client.query(
      `UPDATE bas_returns SET w1_cents = COALESCE($3, w1_cents), w2_cents = COALESCE($4, w2_cents),
              instalment_cents = COALESCE($5, instalment_cents)
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, input.w1Cents ?? null, input.w2Cents ?? null, input.instalmentCents ?? null],
    );
  });
  return getBas(orgId, id);
}

export async function deleteBas(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    if (row.status !== 'DRAFT') throw new ApiError(409, 'Only a draft BAS can be deleted');
    await client.query('DELETE FROM bas_returns WHERE org_id = $1 AND id = $2', [orgId, id]);
  });
}

export async function addAdjustment(
  orgId: string,
  userId: string,
  id: string,
  input: { label: 'G7' | 'G18'; grossCents: number; accountId: string; reason: string },
): Promise<BasDetail> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    if (row.status !== 'DRAFT') throw new ApiError(409, 'Only a draft BAS can be adjusted');
    const { rows: account } = await client.query(
      'SELECT 1 FROM accounts WHERE org_id = $1 AND id = $2 AND is_postable AND is_active',
      [orgId, input.accountId],
    );
    if (account.length === 0) throw new ApiError(422, 'Choose an active postable account for the other side of this adjustment');
    const taxCents = divideBy11(input.grossCents);
    await client.query(
      `INSERT INTO bas_return_adjustments (org_id, bas_return_id, label, gross_cents, tax_cents, account_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orgId, id, input.label, input.grossCents, taxCents, input.accountId, input.reason, userId],
    );
  });
  return getBas(orgId, id);
}

export async function removeAdjustment(orgId: string, id: string, adjustmentId: string): Promise<BasDetail> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    if (row.status !== 'DRAFT') throw new ApiError(409, 'Only a draft BAS can be adjusted');
    const { rowCount } = await client.query(
      'DELETE FROM bas_return_adjustments WHERE org_id = $1 AND bas_return_id = $2 AND id = $3',
      [orgId, id, adjustmentId],
    );
    if (rowCount === 0) throw new ApiError(404, 'Adjustment not found');
  });
  return getBas(orgId, id);
}

/**
 * Stores the labels and contributing events and closes the months covered, so
 * the return can no longer change underneath what was reported. Periods are
 * closed before computing, on this transaction, so a posting that starts after
 * the close is refused by the period trigger.
 */
export async function finaliseBas(orgId: string, userId: string, id: string): Promise<BasDetail> {
  const peek = await requireReturn(pool, orgId, id);
  assertTransition(peek.status, 'FINALISED');
  if ((await regionToday(orgId)) <= peek.period_end) {
    throw new ApiError(422, 'This period has not ended yet');
  }
  // Generation opens its own transaction and is idempotent. A date with no
  // period counts as open, so the months must exist before they can be closed.
  await fiscalPeriodService.generatePeriods(orgId, userId, peek.period_start);
  await fiscalPeriodService.generatePeriods(orgId, userId, peek.period_end);

  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    assertTransition(row.status, 'FINALISED');
    await fiscalPeriodService.closePeriodsInRangeOnClient(client, orgId, userId, row.period_start, row.period_end);

    const adjustments = await loadAdjustments(client, orgId, id);
    const { events } = await loadGstEvents(orgId, row.period_start, row.period_end, row.basis, client);
    const labels = computeWorksheet(events, adjustments);

    const entries = Object.entries(labels);
    await client.query(
      `INSERT INTO bas_return_labels (org_id, bas_return_id, label, cents)
       SELECT $1, $2, v.label, v.cents FROM unnest($3::text[], $4::bigint[]) AS v(label, cents)`,
      [orgId, id, entries.map(([label]) => label), entries.map(([, cents]) => cents)],
    );
    if (events.length > 0) {
      await client.query(
        `INSERT INTO bas_return_events
           (org_id, bas_return_id, source_kind, source_ref, document_number, party_name, event_date, tax_code, net_cents, tax_cents, prior_period)
         SELECT $1, $2, v.kind, v.ref, v.num, v.party, v.day, v.code, v.net, v.tax, v.prior
           FROM unnest($3::text[], $4::uuid[], $5::text[], $6::text[], $7::date[], $8::text[], $9::bigint[], $10::bigint[], $11::boolean[])
                AS v(kind, ref, num, party, day, code, net, tax, prior)`,
        [
          orgId,
          id,
          events.map((e) => e.sourceKind),
          events.map((e) => e.sourceId),
          events.map((e) => e.documentNumber),
          events.map((e) => e.partyName),
          events.map((e) => e.eventDate),
          events.map((e) => e.taxCode),
          events.map((e) => e.netCents),
          events.map((e) => e.taxCents),
          events.map((e) => e.priorPeriod),
        ],
      );
    }
    await client.query(
      `UPDATE bas_returns SET status = 'FINALISED', finalised_by = $3, finalised_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, id, userId],
    );
  });
  return getBas(orgId, id);
}

export async function reopenBas(orgId: string, id: string): Promise<BasDetail> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    assertTransition(row.status, 'DRAFT');
    await fiscalPeriodService.reopenPeriodsInRangeOnClient(client, orgId, row.period_start, row.period_end);
    await client.query('DELETE FROM bas_return_labels WHERE org_id = $1 AND bas_return_id = $2', [orgId, id]);
    await client.query('DELETE FROM bas_return_events WHERE org_id = $1 AND bas_return_id = $2', [orgId, id]);
    await client.query(
      `UPDATE bas_returns SET status = 'DRAFT', finalised_by = NULL, finalised_at = NULL WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
  });
  return getBas(orgId, id);
}

/** 2026-09-03 becomes 03/09/2026, for text that is stored and shown to Australian users. */
function auDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

async function clearingAccountOnClient(
  client: PoolClient,
  orgId: string,
  code: string,
  type: 'Asset' | 'Liability' | 'Expense',
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2 AND type = $3 AND is_postable AND is_active',
    [orgId, code, type],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new ApiError(422, `Account ${code} (${type}) is needed to record this lodgment`);
  return id;
}

/**
 * Records that the user lodged the return, and moves the balances to what is
 * now owed to the ATO. Whole-dollar reporting leaves a few cents behind, which
 * go to Rounding. On a cash basis 2140 and 1180 keep the GST on unpaid
 * documents, which belongs to a later return.
 */
export async function lodgeBas(
  orgId: string,
  userId: string,
  id: string,
  input: { lodgedOn: string; atoReference: string | null },
): Promise<BasDetail> {
  await withTransaction(async (client) => {
    const row = await requireReturn(client, orgId, id, true);
    assertTransition(row.status, 'LODGED');
    if (input.lodgedOn <= row.period_end) throw new ApiError(422, 'A BAS is lodged after its period ends');
    const adjustments = await loadAdjustments(client, orgId, id);

    const { rows: labelRows } = await client.query<{ label: string; cents: string }>(
      `SELECT label, cents::text AS cents FROM bas_return_labels WHERE org_id = $1 AND bas_return_id = $2 AND label IN ('1A', '1B')`,
      [orgId, id],
    );
    const labels = new Map(labelRows.map((r) => [r.label, Number(r.cents)]));
    const oneA = labels.get('1A') ?? 0;
    const oneB = labels.get('1B') ?? 0;
    const w2 = Number(row.w2_cents);
    const instalment = Number(row.instalment_cents);
    const manualSales = adjustments.filter((a) => a.label === 'G7').reduce((s, a) => s + a.taxCents, 0);
    const manualPurchases = adjustments.filter((a) => a.label === 'G18').reduce((s, a) => s + a.taxCents, 0);

    const lines: journalService.JournalLineInput[] = [];
    const debit = (accountId: string, amount: number, description: string) => {
      if (amount > 0) lines.push({ accountId, description, debitCents: amount, creditCents: 0 });
      else if (amount < 0) lines.push({ accountId, description, debitCents: 0, creditCents: -amount });
    };

    debit(await gstAccountOnClient(client, orgId, 'SALES'), oneA - manualSales, 'GST collected (1A)');
    debit(await gstAccountOnClient(client, orgId, 'PURCHASES'), -(oneB - manualPurchases), 'GST paid (1B)');
    if (w2 > 0) debit(await clearingAccountOnClient(client, orgId, '2162', 'Liability'), w2, 'PAYG withheld (W2)');
    if (instalment > 0) debit(await clearingAccountOnClient(client, orgId, '1185', 'Asset'), instalment, 'PAYG instalment');
    for (const a of adjustments) {
      debit(a.accountId, a.label === 'G7' ? a.taxCents : -a.taxCents, `BAS adjustment ${a.label}: ${a.reason}`.slice(0, 500));
    }

    const exactOwed = oneA + w2 + instalment - oneB;
    const reportedOwed = basSummary({ '1A': oneA, '1B': oneB }, w2, instalment).netPayable * 100;
    debit(await clearingAccountOnClient(client, orgId, '2150', 'Liability'), -reportedOwed, 'Owed to the ATO');
    if (exactOwed !== reportedOwed) {
      debit(await clearingAccountOnClient(client, orgId, '6830', 'Expense'), reportedOwed - exactOwed, 'BAS whole-dollar rounding');
    }

    let entryId: string | null = null;
    if (lines.length > 0) {
      entryId = await journalService.createEntryOnClient(client, orgId, userId, {
        entryDate: input.lodgedOn,
        description: `BAS ${auDate(row.period_start)} to ${auDate(row.period_end)}`,
        sourceType: 'bas_return',
        sourceId: id,
        lines,
      });
    }
    await client.query(
      `UPDATE bas_returns
          SET status = 'LODGED', lodged_on = $3, ato_reference = $4, lodged_by = $5, lodged_at = now(), clearing_journal_entry_id = $6
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, input.lodgedOn, input.atoReference, userId, entryId],
    );
  });
  return getBas(orgId, id);
}

export interface BasEventRow {
  sourceKind: GstSourceKind;
  sourceId: string;
  documentNumber: string | null;
  partyName: string | null;
  eventDate: string;
  taxCode: string;
  taxLabel: string;
  netCents: number;
  taxCents: number;
  grossCents: number;
  labels: string[];
}

/** The transactions behind a return, optionally for one label. Stored once finalised, live while a draft. */
export async function listBasEvents(orgId: string, id: string, label: string | null): Promise<BasEventRow[]> {
  const row = await requireReturn(pool, orgId, id);
  let events: GstEvent[];
  if (row.status === 'DRAFT') {
    events = (await loadGstEvents(orgId, row.period_start, row.period_end, row.basis)).events;
  } else {
    const { rows } = await pool.query<{
      source_kind: GstSourceKind;
      source_ref: string;
      document_number: string | null;
      party_name: string | null;
      event_date: string;
      tax_code: string;
      net_cents: string;
      tax_cents: string;
      prior_period: boolean;
    }>(
      `SELECT source_kind, source_ref, document_number, party_name, to_char(event_date, 'YYYY-MM-DD') AS event_date,
              tax_code, net_cents::text AS net_cents, tax_cents::text AS tax_cents, prior_period
         FROM bas_return_events WHERE org_id = $1 AND bas_return_id = $2`,
      [orgId, id],
    );
    events = rows.map((r) => ({
      sourceKind: r.source_kind,
      sourceId: r.source_ref,
      documentNumber: r.document_number,
      partyId: null,
      partyName: r.party_name,
      eventDate: r.event_date,
      taxCode: r.tax_code,
      netCents: Number(r.net_cents),
      taxCents: Number(r.tax_cents),
      priorPeriod: r.prior_period,
    }));
  }
  const taxLabelFor = (e: GstEvent): string[] => {
    const direction = auTaxCode(e.taxCode)?.direction;
    return [...labelsForEvent(e.taxCode, e.priorPeriod), direction === 'SALES' ? '1A' : '1B'];
  };
  return events
    .filter((e) => label === null || (taxLabelFor(e).includes(label) && (!label.startsWith('1') || e.taxCents !== 0)))
    .map((e) => ({
      sourceKind: e.sourceKind,
      sourceId: e.sourceId,
      documentNumber: e.documentNumber,
      partyName: e.partyName,
      eventDate: e.eventDate,
      taxCode: e.taxCode,
      taxLabel: auTaxCode(e.taxCode)?.label ?? e.taxCode,
      netCents: e.netCents,
      taxCents: e.taxCents,
      grossCents: e.netCents + e.taxCents,
      labels: taxLabelFor(e),
    }))
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : a.sourceId < b.sourceId ? -1 : 1));
}

