import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { addDays, firstDayOfNextMonth, occurrenceDate } from '../../utils/recurrence.js';
import { RECURRING_MAX_CATCHUP_PER_RUN } from '../../config/constants.js';
import * as invoiceService from './invoiceService.js';
import * as billService from './billService.js';
import * as journalService from './journalService.js';
import {
  canTransitionRecurring,
  isRecurringStatus,
  type Bill,
  type Invoice,
  type JournalEntry,
  type RecurringFrequency,
  type RecurringKind,
  type RecurringMode,
  type RecurringRun,
  type RecurringSchedule,
  type RecurringScheduleDetail,
  type RecurringStatus,
} from '../../types/accounting.js';

/**
 * Accounting recurring documents (Phase 34b) — an invoice, bill or manual
 * journal entry acts as a template; `runDueOccurrences` generates the next
 * occurrence on schedule, exactly once per due date, in one transaction with
 * its `recurring_runs` history row. A recurring journal can additionally post
 * its own reversal dated the first day of the next month.
 *
 * Documents are created only through their own services'
 * `createInvoiceOnClient` / `createBillOnClient` / `journalService`
 * functions, on this file's own checked-out transaction client (guardrails
 * rules 5 and 16). `listDueSchedules` is the one documented exception to rule
 * 1 — see its own comment.
 */

const PG_RAISE_EXCEPTION = 'P0001';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the recurring schedule';
  }
  return 'Database rejected the recurring schedule';
}

function toKind(value: string, scheduleId: string): RecurringKind {
  if (value !== 'INVOICE' && value !== 'BILL' && value !== 'JOURNAL') {
    throw new Error(`Unknown recurring kind "${value}" on schedule ${scheduleId}`);
  }
  return value;
}

function toFrequency(value: string, scheduleId: string): RecurringFrequency {
  if (value !== 'WEEKLY' && value !== 'MONTHLY' && value !== 'QUARTERLY' && value !== 'YEARLY') {
    throw new Error(`Unknown recurring frequency "${value}" on schedule ${scheduleId}`);
  }
  return value;
}

function toMode(value: string, scheduleId: string): RecurringMode {
  if (value !== 'DRAFT' && value !== 'POST') {
    throw new Error(`Unknown recurring mode "${value}" on schedule ${scheduleId}`);
  }
  return value;
}

/** Whole-day difference (to - from) between two YYYY-MM-DD dates, UTC-based like utils/recurrence.ts. */
function dayDiff(from: string, to: string): number {
  const fromParts = from.split('-');
  const toParts = to.split('-');
  const fromMs = Date.UTC(Number(fromParts[0]), Number(fromParts[1]) - 1, Number(fromParts[2]));
  const toMs = Date.UTC(Number(toParts[0]), Number(toParts[1]) - 1, Number(toParts[2]));
  return Math.round((toMs - fromMs) / 86_400_000);
}

// ---------------------------------------------------------------- row mapping

const SCHEDULE_SELECT = `SELECT s.id, s.kind, s.name,
                                 COALESCE(s.source_invoice_id, s.source_bill_id, s.source_journal_entry_id) AS source_id,
                                 s.frequency, s.interval_count, s.start_date, s.end_date,
                                 s.next_run_date, s.next_occurrence_index, s.mode, s.auto_reverse, s.status,
                                 s.last_error, s.last_error_at,
                                 (SELECT max(r.run_date) FROM recurring_runs r
                                   WHERE r.org_id = s.org_id AND r.schedule_id = s.id) AS last_run_date,
                                 s.created_by, s.created_at, s.updated_at
                            FROM recurring_schedules s`;

interface ScheduleRow {
  id: string;
  kind: string;
  name: string;
  source_id: string;
  frequency: string;
  interval_count: number;
  start_date: string;
  end_date: string | null;
  next_run_date: string | null;
  next_occurrence_index: number;
  mode: string;
  auto_reverse: boolean;
  status: string;
  last_error: string | null;
  last_error_at: Date | null;
  last_run_date: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function toSchedule(row: ScheduleRow): RecurringSchedule {
  if (!isRecurringStatus(row.status)) {
    throw new Error(`Unknown recurring status "${row.status}" on schedule ${row.id}`);
  }

  return {
    id: row.id,
    kind: toKind(row.kind, row.id),
    name: row.name,
    sourceId: row.source_id,
    frequency: toFrequency(row.frequency, row.id),
    intervalCount: row.interval_count,
    startDate: row.start_date,
    endDate: row.end_date,
    nextRunDate: row.next_run_date,
    nextOccurrenceIndex: row.next_occurrence_index,
    mode: toMode(row.mode, row.id),
    autoReverse: row.auto_reverse,
    status: row.status,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at === null ? null : row.last_error_at.toISOString(),
    lastRunDate: row.last_run_date,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface RunRow {
  id: string;
  run_date: string;
  occurrence_number: number;
  invoice_id: string | null;
  bill_id: string | null;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
  created_at: Date;
}

function toRun(row: RunRow): RecurringRun {
  return {
    id: row.id,
    runDate: row.run_date,
    occurrenceNumber: row.occurrence_number,
    invoiceId: row.invoice_id,
    billId: row.bill_id,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** Newest first, at most 50 — matches `RecurringScheduleDetail.runs`. */
async function loadRuns(orgId: string, scheduleId: string): Promise<RecurringRun[]> {
  const { rows } = await pool.query<RunRow>(
    `SELECT id, run_date, occurrence_number, invoice_id, bill_id, journal_entry_id, reversal_entry_id, created_at
       FROM recurring_runs
      WHERE org_id = $1 AND schedule_id = $2
      ORDER BY run_date DESC, occurrence_number DESC
      LIMIT 50`,
    [orgId, scheduleId],
  );
  return rows.map(toRun);
}

// ---------------------------------------------------------------------- reads

export async function listSchedules(
  orgId: string,
  filters: { kind: RecurringKind | null; status: RecurringStatus | null },
): Promise<RecurringSchedule[]> {
  const clauses = ['s.org_id = $1'];
  const values: unknown[] = [orgId];

  if (filters.kind !== null) {
    values.push(filters.kind);
    clauses.push(`s.kind = $${String(values.length)}`);
  }
  if (filters.status !== null) {
    values.push(filters.status);
    clauses.push(`s.status = $${String(values.length)}`);
  }

  const { rows } = await pool.query<ScheduleRow>(
    `${SCHEDULE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY s.next_run_date NULLS LAST, s.created_at DESC`,
    values,
  );
  return rows.map(toSchedule);
}

export async function getScheduleById(orgId: string, id: string): Promise<RecurringScheduleDetail> {
  const { rows } = await pool.query<ScheduleRow>(`${SCHEDULE_SELECT} WHERE s.id = $1 AND s.org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Recurring schedule not found');

  const runs = await loadRuns(orgId, id);
  return { ...toSchedule(row), runs };
}

// --------------------------------------------------------------------- writes

export interface CreateRecurringScheduleInput {
  kind: RecurringKind;
  sourceId: string;
  name: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  mode: RecurringMode;
  autoReverse: boolean;
}

export async function createSchedule(
  orgId: string,
  createdBy: string,
  input: CreateRecurringScheduleInput,
): Promise<RecurringSchedule> {
  return withTransaction(async (client) => {
    let sourceInvoiceId: string | null = null;
    let sourceBillId: string | null = null;
    let sourceJournalId: string | null = null;

    if (input.kind === 'INVOICE') {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM invoices WHERE id = $1 AND org_id = $2',
        [input.sourceId, orgId],
      );
      if (rows[0] === undefined) throw new ApiError(422, 'Source invoice not found');
      sourceInvoiceId = input.sourceId;
    } else if (input.kind === 'BILL') {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM bills WHERE id = $1 AND org_id = $2',
        [input.sourceId, orgId],
      );
      if (rows[0] === undefined) throw new ApiError(422, 'Source bill not found');
      sourceBillId = input.sourceId;
    } else {
      const { rows } = await client.query<{ source_type: string; reverses_entry_id: string | null }>(
        'SELECT source_type, reverses_entry_id FROM journal_entries WHERE id = $1 AND org_id = $2',
        [input.sourceId, orgId],
      );
      const entryRow = rows[0];
      if (entryRow === undefined) throw new ApiError(422, 'Source journal entry not found');
      if (entryRow.source_type !== 'manual') {
        throw new ApiError(422, 'Only a manual journal entry can recur');
      }
      if (entryRow.reverses_entry_id !== null) {
        throw new ApiError(422, 'A reversing entry cannot be a recurring template');
      }

      const { rows: orgRows } = await client.query<{ base_currency: string }>(
        'SELECT base_currency FROM organizations WHERE id = $1',
        [orgId],
      );
      const baseCurrency = orgRows[0]?.base_currency.trim();
      if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');

      const { rows: lineRows } = await client.query<{ currency_code: string; account_id: string }>(
        'SELECT currency_code, account_id FROM ledger_lines WHERE journal_entry_id = $1 AND org_id = $2',
        [input.sourceId, orgId],
      );
      if (lineRows.some((l) => l.currency_code.trim() !== baseCurrency)) {
        throw new ApiError(422, 'Only a base-currency journal entry can recur');
      }

      // Throws its own 422 (the SAP reconciliation-account rule, Phase 25).
      await journalService.assertNotControlAccountsOnClient(
        client,
        orgId,
        lineRows.map((l) => l.account_id),
      );

      if (input.mode === 'DRAFT') throw new ApiError(422, 'A recurring journal always posts');

      sourceJournalId = input.sourceId;
    }

    if (input.autoReverse && input.kind !== 'JOURNAL') {
      throw new ApiError(422, 'Only a journal can auto-reverse');
    }

    const { rows: insertRows } = await client.query<{ id: string }>(
      `INSERT INTO recurring_schedules
         (org_id, kind, name, source_invoice_id, source_bill_id, source_journal_entry_id,
          frequency, interval_count, start_date, end_date, next_run_date, next_occurrence_index,
          mode, auto_reverse, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, 0, $11, $12, $13)
       RETURNING id`,
      [
        orgId,
        input.kind,
        input.name,
        sourceInvoiceId,
        sourceBillId,
        sourceJournalId,
        input.frequency,
        input.intervalCount,
        input.startDate,
        input.endDate,
        input.mode,
        input.autoReverse,
        createdBy,
      ],
    );
    const id = insertRows[0]?.id;
    if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');

    const { rows: scheduleRows } = await client.query<ScheduleRow>(
      `${SCHEDULE_SELECT} WHERE s.id = $1 AND s.org_id = $2`,
      [id, orgId],
    );
    const row = scheduleRows[0];
    if (row === undefined) throw new Error('Recurring schedule vanished mid-transaction');
    return toSchedule(row);
  });
}

export async function transitionSchedule(
  orgId: string,
  id: string,
  target: RecurringStatus,
): Promise<RecurringSchedule> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      status: string;
      start_date: string;
      end_date: string | null;
      frequency: string;
      interval_count: number;
      next_occurrence_index: number;
    }>(
      `SELECT status, start_date, end_date, frequency, interval_count, next_occurrence_index
         FROM recurring_schedules WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Recurring schedule not found');
    if (!isRecurringStatus(row.status)) {
      throw new Error(`Unknown recurring status "${row.status}" on schedule ${id}`);
    }

    if (!canTransitionRecurring(row.status, target)) {
      throw new ApiError(409, `This schedule cannot move from ${row.status} to ${target}`);
    }

    if (target === 'ENDED') {
      await client.query(
        `UPDATE recurring_schedules SET status = 'ENDED', next_run_date = NULL WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    } else if (target === 'PAUSED') {
      await client.query(`UPDATE recurring_schedules SET status = 'PAUSED' WHERE id = $1 AND org_id = $2`, [
        id,
        orgId,
      ]);
    } else {
      // Resume (-> ACTIVE): skip missed occurrences rather than catching them
      // up — `today` is read on this same client so it agrees with whatever
      // `occurrenceDate` (a pure JS function) is compared against.
      const { rows: todayRows } = await client.query<{ today: string }>('SELECT current_date AS today');
      const today = todayRows[0]?.today;
      if (today === undefined) throw new Error('SELECT current_date produced no row');

      const frequency = toFrequency(row.frequency, id);
      let idx = row.next_occurrence_index;
      let date = occurrenceDate(row.start_date, frequency, row.interval_count, idx);
      while (date < today) {
        idx += 1;
        date = occurrenceDate(row.start_date, frequency, row.interval_count, idx);
      }

      if (row.end_date !== null && date > row.end_date) {
        await client.query(
          `UPDATE recurring_schedules
              SET status = 'ENDED', next_run_date = NULL, next_occurrence_index = $3,
                  last_error = NULL, last_error_at = NULL
            WHERE id = $1 AND org_id = $2`,
          [id, orgId, idx],
        );
      } else {
        await client.query(
          `UPDATE recurring_schedules
              SET status = 'ACTIVE', next_run_date = $3, next_occurrence_index = $4,
                  last_error = NULL, last_error_at = NULL
            WHERE id = $1 AND org_id = $2`,
          [id, orgId, date, idx],
        );
      }
    }

    const { rows: updatedRows } = await client.query<ScheduleRow>(
      `${SCHEDULE_SELECT} WHERE s.id = $1 AND s.org_id = $2`,
      [id, orgId],
    );
    const updated = updatedRows[0];
    if (updated === undefined) throw new Error('Recurring schedule vanished mid-transaction');
    return toSchedule(updated);
  });
}

// ------------------------------------------------------------------- the sweep

/**
 * RULE-1 EXCEPTION: reads across every organization. This is the scheduler
 * sweep — ids only, and every downstream call (`runDueOccurrences`) re-scopes
 * by that row's own `org_id`. The identical status `driveSyncService`'s
 * `listFoldersDueForSync` carries.
 */
export async function listDueSchedules(): Promise<Array<{ orgId: string; scheduleId: string }>> {
  const { rows } = await pool.query<{ org_id: string; id: string }>(
    `SELECT org_id, id FROM recurring_schedules
      WHERE status = 'ACTIVE' AND next_run_date <= current_date
      ORDER BY next_run_date, id
      LIMIT 500`,
  );
  return rows.map((row) => ({ orgId: row.org_id, scheduleId: row.id }));
}

interface PreReadRow {
  id: string;
  kind: string;
  source_invoice_id: string | null;
  source_bill_id: string | null;
  source_journal_entry_id: string | null;
  is_due: boolean;
}

type Template =
  | { kind: 'INVOICE'; invoice: Invoice }
  | { kind: 'BILL'; bill: Bill }
  | { kind: 'JOURNAL'; entry: JournalEntry };

/** Guarded by `chk_recurring_source_matches_kind` — a non-null id for this kind is guaranteed. */
function requireSourceId(value: string | null, kind: RecurringKind, scheduleId: string): string {
  if (value === null) {
    throw new Error(
      `Recurring schedule ${scheduleId} of kind ${kind} has no matching source id — chk_recurring_source_matches_kind should make this unreachable`,
    );
  }
  return value;
}

/**
 * The read-only template, loaded through each document's own public getter
 * (never this file's own SQL) — reading it outside the unit of work below is
 * intended, not an oversight: nothing here can mutate the template, and a
 * template cannot be deleted out from under a schedule (both `RESTRICT` FKs).
 */
async function loadTemplate(orgId: string, kind: RecurringKind, pre: PreReadRow): Promise<Template> {
  if (kind === 'INVOICE') {
    const invoice = await invoiceService.getInvoiceById(
      orgId,
      requireSourceId(pre.source_invoice_id, kind, pre.id),
    );
    return { kind: 'INVOICE', invoice };
  }
  if (kind === 'BILL') {
    const bill = await billService.getBillById(orgId, requireSourceId(pre.source_bill_id, kind, pre.id));
    return { kind: 'BILL', bill };
  }
  const entry = await journalService.getEntryById(
    orgId,
    requireSourceId(pre.source_journal_entry_id, kind, pre.id),
  );
  return { kind: 'JOURNAL', entry };
}

interface OccurrenceResult {
  invoiceId: string | null;
  billId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
}

/** Runs entirely on `client` (rule 5) — the caller owns BEGIN/COMMIT/ROLLBACK. */
async function generateOccurrence(
  client: PoolClient,
  orgId: string,
  userId: string,
  template: Template,
  runDate: string,
  mode: RecurringMode,
  autoReverse: boolean,
  scheduleId: string,
): Promise<OccurrenceResult> {
  if (template.kind === 'INVOICE') {
    const inv = template.invoice;
    const dueDate =
      inv.paymentTermsCode !== null ? undefined : addDays(runDate, dayDiff(inv.issueDate, inv.dueDate));

    const invoiceId = await invoiceService.createInvoiceOnClient(client, orgId, userId, {
      customerId: inv.customerId,
      issueDate: runDate,
      ...(dueDate !== undefined ? { dueDate } : {}),
      currencyCode: inv.currencyCode,
      notes: inv.notes,
      paymentTerms: inv.paymentTerms,
      paymentTermsCode: inv.paymentTermsCode,
      lines: inv.lines.map((l) => ({
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitPriceCents: l.unitPriceCents,
        revenueAccountId: l.revenueAccountId,
        taxRateBp: l.taxRateBp,
        itemId: l.itemId,
        stockLocationId: l.stockLocationId,
      })),
    });

    if (mode === 'POST') {
      await invoiceService.issueInvoiceOnClient(client, orgId, userId, invoiceId, null);
    }

    return { invoiceId, billId: null, journalEntryId: null, reversalEntryId: null };
  }

  if (template.kind === 'BILL') {
    const bill = template.bill;
    const dueDate =
      bill.paymentTermsCode !== null ? undefined : addDays(runDate, dayDiff(bill.billDate, bill.dueDate));

    const billId = await billService.createBillOnClient(client, orgId, userId, {
      vendorId: bill.vendorId,
      // At most 89 + 1 + 10 = 100 characters, the column's limit.
      vendorReference: `${bill.vendorReference.slice(0, 89)}-${runDate}`,
      billDate: runDate,
      ...(dueDate !== undefined ? { dueDate } : {}),
      currencyCode: bill.currencyCode,
      notes: bill.notes,
      paymentTerms: bill.paymentTerms,
      paymentTermsCode: bill.paymentTermsCode,
      lines: bill.lines.map((l) => ({
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitPriceCents: l.unitPriceCents,
        expenseAccountId: l.expenseAccountId,
        taxRateBp: l.taxRateBp,
        itemId: l.itemId,
        stockLocationId: l.stockLocationId,
      })),
    });

    if (mode === 'POST') {
      await billService.approveBillOnClient(client, orgId, userId, billId, null);
    }

    return { invoiceId: null, billId, journalEntryId: null, reversalEntryId: null };
  }

  const entry = template.entry;
  const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: runDate,
    description: entry.description,
    sourceType: 'recurring',
    sourceId: scheduleId,
    lines: entry.lines.map((l) => ({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents })),
  });

  let reversalEntryId: string | null = null;
  if (autoReverse) {
    reversalEntryId = await journalService.reverseEntryOnClient(
      client,
      orgId,
      userId,
      journalEntryId,
      firstDayOfNextMonth(runDate),
    );
  }

  return { invoiceId: null, billId: null, journalEntryId, reversalEntryId };
}

interface LockedRow {
  next_run_date: string;
  next_occurrence_index: number;
  created_by: string;
  start_date: string;
  end_date: string | null;
  frequency: string;
  interval_count: number;
  mode: string;
  auto_reverse: boolean;
}

/**
 * Generates every due occurrence of one schedule, up to
 * `RECURRING_MAX_CATCHUP_PER_RUN` per call. Lock order per iteration:
 * schedule row -> the document service's own locks -> journal.
 */
export async function runDueOccurrences(
  orgId: string,
  scheduleId: string,
): Promise<{ generated: number; lastError: string | null }> {
  let generated = 0;

  for (let attempt = 0; attempt < RECURRING_MAX_CATCHUP_PER_RUN; attempt++) {
    // Step 1 — a plain, unlocked read. `is_due` is computed in SQL so this
    // never needs a separate `current_date` round trip. The template is a
    // read-only document, so loading it here, before any transaction is
    // open, is intended (see `loadTemplate`'s own comment).
    const { rows: preRows } = await pool.query<PreReadRow>(
      `SELECT id, kind, source_invoice_id, source_bill_id, source_journal_entry_id,
              (status = 'ACTIVE' AND next_run_date IS NOT NULL AND next_run_date <= current_date) AS is_due
         FROM recurring_schedules WHERE id = $1 AND org_id = $2`,
      [scheduleId, orgId],
    );
    const pre = preRows[0];
    if (pre === undefined || !pre.is_due) break;

    const kind = toKind(pre.kind, pre.id);
    const template = await loadTemplate(orgId, kind, pre);

    const client = await pool.connect();
    try {
      await beginTransaction(client);

      // Step 2 — the row lock. `SKIP LOCKED` means a concurrent sweep tick on
      // the same schedule simply finds no row rather than blocking; a
      // `next_run_date` that no longer matches step 1's means the schedule
      // stopped being due (paused, ended, or already advanced by another
      // worker) between the two reads.
      const { rows: lockedRows } = await client.query<LockedRow>(
        `SELECT next_run_date, next_occurrence_index, created_by, start_date, end_date,
                frequency, interval_count, mode, auto_reverse
           FROM recurring_schedules
          WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' AND next_run_date <= current_date
          FOR UPDATE SKIP LOCKED`,
        [scheduleId, orgId],
      );
      const locked = lockedRows[0];

      if (locked === undefined) {
        await client.query('COMMIT');
        break;
      }

      const runDate = locked.next_run_date;
      const userId = locked.created_by;
      const mode = toMode(locked.mode, scheduleId);

      const result = await generateOccurrence(
        client,
        orgId,
        userId,
        template,
        runDate,
        mode,
        locked.auto_reverse,
        scheduleId,
      );

      const occurrenceNumber = locked.next_occurrence_index + 1;
      await client.query(
        `INSERT INTO recurring_runs
           (org_id, schedule_id, run_date, occurrence_number, invoice_id, bill_id, journal_entry_id, reversal_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orgId,
          scheduleId,
          runDate,
          occurrenceNumber,
          result.invoiceId,
          result.billId,
          result.journalEntryId,
          result.reversalEntryId,
        ],
      );

      const nextIdx = locked.next_occurrence_index + 1;
      const frequency = toFrequency(locked.frequency, scheduleId);
      const nextDate = occurrenceDate(locked.start_date, frequency, locked.interval_count, nextIdx);

      if (locked.end_date !== null && nextDate > locked.end_date) {
        // The sweep's own status change is the same ACTIVE -> ENDED edge
        // `transitionSchedule` enforces — checked here too rather than
        // assumed, so status changes always go through the one FSM table
        // (guardrails rule 10). Schedule reads only ACTIVE rows (both the
        // step-1 `is_due` check and step 2's `FOR UPDATE` predicate), so a
        // false here is a programming error, never a user-facing condition.
        if (!canTransitionRecurring('ACTIVE', 'ENDED')) {
          throw new Error('Recurring FSM forbids ACTIVE -> ENDED');
        }
        await client.query(
          `UPDATE recurring_schedules
              SET status = 'ENDED', next_run_date = NULL, next_occurrence_index = $3,
                  last_error = NULL, last_error_at = NULL
            WHERE id = $1 AND org_id = $2`,
          [scheduleId, orgId, nextIdx],
        );
      } else {
        await client.query(
          `UPDATE recurring_schedules
              SET next_run_date = $3, next_occurrence_index = $4,
                  last_error = NULL, last_error_at = NULL
            WHERE id = $1 AND org_id = $2`,
          [scheduleId, orgId, nextDate, nextIdx],
        );
      }

      await client.query('COMMIT');
      generated += 1;
    } catch (err) {
      await client.query('ROLLBACK');

      const isKnown = err instanceof ApiError || pgErrorCode(err) === PG_RAISE_EXCEPTION;
      const rawMessage = err instanceof ApiError ? err.message : pgErrorMessage(err);
      const message = isKnown ? rawMessage : 'Unexpected error generating this occurrence';
      console.error(`[recurring] schedule ${scheduleId} occurrence generation failed:`, err);

      // A new, independent statement recording the failure — not follow-up
      // work to the transaction that just rolled back (guardrails rule 5).
      try {
        await pool.query(
          `UPDATE recurring_schedules SET last_error = $3, last_error_at = now() WHERE id = $1 AND org_id = $2`,
          [scheduleId, orgId, message.slice(0, 500)],
        );
      } catch (recordErr) {
        console.error('[recurring] failed to record last_error:', recordErr);
      }

      if (isKnown) {
        // Not retried: a closed period or a control-account refusal will not
        // fix itself in seconds.
        return { generated, lastError: message };
      }
      // Unexpected — rethrow so BullMQ retries and eventually dead-letters.
      // Safe: the rollback above left nothing behind.
      throw err;
    } finally {
      client.release();
    }
  }

  return { generated, lastError: null };
}
