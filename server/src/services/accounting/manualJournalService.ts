import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import {
  canTransitionManualJournal,
  isManualJournalStatus,
  MANUAL_JOURNAL_ORIGINS,
  type ManualJournal,
  type ManualJournalLine,
  type ManualJournalOrigin,
  type ManualJournalSummary,
} from '../../types/accounting.js';
import * as journalService from './journalService.js';

/**
 * Manual journals — Phase 44.
 *
 * A manual journal is a document (DRAFT -> POSTED -> VOIDED, plus the TEMPLATE
 * a repeating schedule runs) that owns one immutable GL posting, the way an
 * invoice owns its entry. Every statement is scoped by `org_id` (rule 1) and
 * every amount is integer cents (rule 3). Posted rows are never updated except
 * for the void transition, which the database trigger also enforces (rule 6).
 *
 * Dependency direction (fixed, no cycles): recurringService -> this file ->
 * journalService. This file never imports recurringService.
 *
 * Lock order: manual_journals row (FOR UPDATE) -> (inside createEntryOnClient)
 * period/settings reads -> journal_entries insert. For recurring, the schedule
 * row is locked first, by recurringService.
 */

// ------------------------------------------------------------------- types

export interface ManualJournalLineInput {
  accountId: string | null;
  description: string | null;
  debitCents: number;
  creditCents: number;
}

export interface ManualJournalInput {
  narration: string;
  entryDate: string;
  lines: ManualJournalLineInput[];
}

export type ManualJournalListStatus = 'all' | 'draft' | 'posted' | 'voided';

export interface ListManualJournalsOptions {
  status: ManualJournalListStatus;
  q: string | null;
  from: string | null;
  to: string | null;
  page: number;
  limit: number;
}

interface PostContext {
  sourceType: 'manual' | 'recurring' | 'migration_import';
  sourceId: string | null;
  occurrence: number | null;
}

// ------------------------------------------------------------- error mapping

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FEATURE_NOT_SUPPORTED = '0A000';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the journal';
  }
  return 'Database rejected the journal';
}

/** Mirrors the old journalService.createEntry catch: our own trigger errors become domain errors. */
function mapPgError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  const code = pgErrorCode(err);
  if (code === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
  if (code === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Entry has already been reversed');
  if (code === PG_FEATURE_NOT_SUPPORTED) throw new ApiError(409, pgErrorMessage(err));
  throw err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return mapPgError(err);
  }
}

// -------------------------------------------------------------- row mapping

interface JournalRow {
  id: string;
  status: string;
  origin: string;
  narration: string;
  narration_template: string | null;
  entry_date: string;
  journal_entry_id: string | null;
  void_journal_entry_id: string | null;
  recurring_schedule_id: string | null;
  posted_at: Date | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  total_debit: string | null;
  total_credit: string | null;
  template_schedule_id: string | null;
}

interface LineRow {
  id: string;
  manual_journal_id: string;
  line_number: number;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  description: string | null;
  debit_cents: string;
  credit_cents: string;
}

const JOURNAL_SELECT = `SELECT m.id, m.status, m.origin, m.narration, m.narration_template, m.entry_date,
                               m.journal_entry_id, m.void_journal_entry_id, m.recurring_schedule_id,
                               m.posted_at, m.voided_at, m.created_by, m.created_at, m.updated_at,
                               u.name AS created_by_name,
                               t.d AS total_debit, t.c AS total_credit,
                               (SELECT s.id FROM recurring_schedules s
                                 WHERE s.org_id = m.org_id AND s.source_manual_journal_id = m.id
                                 LIMIT 1) AS template_schedule_id
                          FROM manual_journals m
                          LEFT JOIN users u ON u.id = m.created_by
                          LEFT JOIN LATERAL (
                                SELECT sum(l.debit_cents) AS d, sum(l.credit_cents) AS c
                                  FROM manual_journal_lines l
                                 WHERE l.org_id = m.org_id AND l.manual_journal_id = m.id
                               ) t ON true`;

function isOrigin(value: string): value is ManualJournalOrigin {
  return (MANUAL_JOURNAL_ORIGINS as readonly string[]).includes(value);
}

function toSummary(row: JournalRow): ManualJournalSummary {
  if (!isManualJournalStatus(row.status)) {
    throw new Error(`Unknown manual journal status "${row.status}" on ${row.id}`);
  }
  if (!isOrigin(row.origin)) {
    throw new Error(`Unknown manual journal origin "${row.origin}" on ${row.id}`);
  }
  return {
    id: row.id,
    status: row.status,
    origin: row.origin,
    narration: row.narration,
    narrationTemplate: row.narration_template,
    entryDate: row.entry_date,
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    recurringScheduleId: row.recurring_schedule_id,
    templateScheduleId: row.template_schedule_id,
    postedAt: row.posted_at === null ? null : row.posted_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    totalDebitCents: parseCents(String(row.total_debit ?? '0')),
    totalCreditCents: parseCents(String(row.total_credit ?? '0')),
  };
}

function toLine(row: LineRow): ManualJournalLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    description: row.description,
    debitCents: parseCents(row.debit_cents),
    creditCents: parseCents(row.credit_cents),
  };
}

async function loadLines(
  q: Pick<PoolClient, 'query'>,
  orgId: string,
  ids: string[],
): Promise<Map<string, ManualJournalLine[]>> {
  const byJournal = new Map<string, ManualJournalLine[]>();
  if (ids.length === 0) return byJournal;
  // LEFT join: a draft line may have no account yet.
  const { rows } = await q.query<LineRow>(
    `SELECT l.id, l.manual_journal_id, l.line_number, l.account_id,
            a.code AS account_code, a.name AS account_name,
            l.description, l.debit_cents, l.credit_cents
       FROM manual_journal_lines l
       LEFT JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1 AND l.manual_journal_id = ANY($2::uuid[])
      ORDER BY l.manual_journal_id, l.line_number`,
    [orgId, ids],
  );
  for (const row of rows) {
    const list = byJournal.get(row.manual_journal_id) ?? [];
    list.push(toLine(row));
    byJournal.set(row.manual_journal_id, list);
  }
  return byJournal;
}

// -------------------------------------------------------------------- reads

/** Constant map (rule 4): the status filter is never built from the request. */
const STATUS_PREDICATES: Record<ManualJournalListStatus, string> = {
  all: "m.status <> 'TEMPLATE'",
  draft: "m.status = 'DRAFT'",
  posted: "m.status = 'POSTED'",
  voided: "m.status = 'VOIDED'",
};

function buildFilters(
  orgId: string,
  opts: Pick<ListManualJournalsOptions, 'q' | 'from' | 'to'>,
): { clauses: string[]; values: unknown[] } {
  const clauses = ['m.org_id = $1'];
  const values: unknown[] = [orgId];
  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }
  if (opts.from !== null) add((p) => `m.entry_date >= ${p}::date`, opts.from);
  if (opts.to !== null) add((p) => `m.entry_date <= ${p}::date`, opts.to);
  if (opts.q !== null) add((p) => `m.narration ILIKE '%' || ${p} || '%'`, opts.q);
  return { clauses, values };
}

export async function listManualJournals(
  orgId: string,
  opts: ListManualJournalsOptions,
): Promise<{
  journals: ManualJournalSummary[];
  totalCount: number;
  counts: { all: number; draft: number; posted: number; voided: number };
}> {
  const { clauses, values } = buildFilters(orgId, opts);
  const where = [...clauses, STATUS_PREDICATES[opts.status]].join(' AND ');
  const offset = (opts.page - 1) * opts.limit;

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM manual_journals m WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const { rows } = await pool.query<JournalRow>(
    `${JOURNAL_SELECT}
      WHERE ${where}
      ORDER BY m.entry_date DESC, m.created_at DESC, m.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, opts.limit, offset],
  );

  const { rows: tally } = await pool.query<{ a: string; d: string; p: string; v: string }>(
    `SELECT count(*) FILTER (WHERE m.status <> 'TEMPLATE') AS a,
            count(*) FILTER (WHERE m.status = 'DRAFT')     AS d,
            count(*) FILTER (WHERE m.status = 'POSTED')    AS p,
            count(*) FILTER (WHERE m.status = 'VOIDED')    AS v
       FROM manual_journals m
      WHERE ${clauses.join(' AND ')}`,
    values,
  );
  const t = tally[0];

  return {
    journals: rows.map(toSummary),
    totalCount,
    counts: {
      all: Number(t?.a ?? '0'),
      draft: Number(t?.d ?? '0'),
      posted: Number(t?.p ?? '0'),
      voided: Number(t?.v ?? '0'),
    },
  };
}

async function getManualJournalOnQueryable(
  q: Pick<PoolClient, 'query'>,
  orgId: string,
  id: string,
): Promise<ManualJournal> {
  const { rows } = await q.query<JournalRow>(`${JOURNAL_SELECT} WHERE m.id = $1 AND m.org_id = $2`, [id, orgId]);
  const row = rows[0];
  // 404, not 403: a 403 would confirm the id exists in another organization.
  if (row === undefined) throw new ApiError(404, 'Manual journal not found');
  const lines = await loadLines(q, orgId, [row.id]);
  return { ...toSummary(row), lines: lines.get(row.id) ?? [] };
}

export async function getManualJournalById(orgId: string, id: string): Promise<ManualJournal> {
  return getManualJournalOnQueryable(pool, orgId, id);
}

// --------------------------------------------------------- shared validation

function assertLineCountAndAccounts(lines: ManualJournalLineInput[]): void {
  if (lines.length < 1 || lines.length > 200) {
    throw new ApiError(422, 'A journal has between 1 and 200 lines');
  }
}

async function assertAccountsExistOnClient(
  client: PoolClient,
  orgId: string,
  lines: ManualJournalLineInput[],
): Promise<void> {
  const ids = [...new Set(lines.flatMap((l) => (l.accountId === null ? [] : [l.accountId])))];
  if (ids.length === 0) return;
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, ids],
  );
  if (rows.length !== ids.length) throw new ApiError(422, 'Account not found');
}

/** Post-time rules 1-5, in order, with 1-based line numbers. */
async function assertPostableOnClient(
  client: PoolClient,
  orgId: string,
  lines: ManualJournalLineInput[],
): Promise<void> {
  if (lines.length < 2) throw new ApiError(422, 'A journal needs at least two lines');

  const accountIds: string[] = [];
  lines.forEach((line, index) => {
    if (line.accountId === null) throw new ApiError(422, `Line ${String(index + 1)} has no account`);
    accountIds.push(line.accountId);
  });
  lines.forEach((line, index) => {
    if (line.debitCents === 0 && line.creditCents === 0) {
      throw new ApiError(422, `Line ${String(index + 1)} needs a debit or a credit`);
    }
  });

  const debits = sumCents(lines.map((l) => cents(l.debitCents)));
  const credits = sumCents(lines.map((l) => cents(l.creditCents)));
  if (debits !== credits) {
    throw new ApiError(422, `Journal is unbalanced: debits ${String(debits)}, credits ${String(credits)}`);
  }

  await journalService.assertManualJournalAccountsOnClient(client, orgId, accountIds);
}

async function insertLinesOnClient(
  client: PoolClient,
  orgId: string,
  manualJournalId: string,
  lines: ManualJournalLineInput[],
): Promise<void> {
  await client.query(
    `INSERT INTO manual_journal_lines
       (org_id, manual_journal_id, line_number, account_id, description, debit_cents, credit_cents)
     SELECT $1, $2, v.line_number, v.account_id, v.description, v.debit_cents, v.credit_cents
       FROM unnest($3::smallint[], $4::uuid[], $5::text[], $6::bigint[], $7::bigint[])
            AS v(line_number, account_id, description, debit_cents, credit_cents)`,
    [
      orgId,
      manualJournalId,
      lines.map((_, index) => index + 1),
      lines.map((l) => l.accountId),
      lines.map((l) => l.description),
      lines.map((l) => l.debitCents),
      lines.map((l) => l.creditCents),
    ],
  );
}

async function insertHeaderOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  status: 'DRAFT' | 'TEMPLATE',
  origin: ManualJournalOrigin,
  recurringScheduleId: string | null,
  input: ManualJournalInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO manual_journals
       (org_id, status, origin, narration, entry_date, recurring_schedule_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [orgId, status, origin, input.narration, input.entryDate, recurringScheduleId, createdBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return id;
}

interface LockedRow {
  status: string;
  narration: string;
  entry_date: string;
  journal_entry_id: string | null;
}

async function lockOnClient(client: PoolClient, orgId: string, id: string): Promise<LockedRow> {
  const { rows } = await client.query<LockedRow>(
    `SELECT status, narration, entry_date, journal_entry_id
       FROM manual_journals
      WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Manual journal not found');
  return row;
}

// ------------------------------------------------------------------- writes

export async function createManualJournal(
  orgId: string,
  createdBy: string,
  input: ManualJournalInput,
  action: 'draft' | 'post',
): Promise<ManualJournal> {
  const id = await guarded(() =>
    withTransaction(async (client) => {
      assertLineCountAndAccounts(input.lines);
      await assertAccountsExistOnClient(client, orgId, input.lines);
      const newId = await insertHeaderOnClient(client, orgId, createdBy, 'DRAFT', 'MANUAL', null, input);
      await insertLinesOnClient(client, orgId, newId, input.lines);
      if (action === 'post') {
        await postDraftOnClient(client, orgId, createdBy, newId, {
          sourceType: 'manual',
          sourceId: null,
          occurrence: null,
        });
      }
      return newId;
    }),
  );
  return getManualJournalById(orgId, id);
}

export async function updateManualJournal(
  orgId: string,
  id: string,
  input: ManualJournalInput,
): Promise<ManualJournal> {
  await guarded(() =>
    withTransaction(async (client) => {
      const locked = await lockOnClient(client, orgId, id);
      if (locked.status !== 'DRAFT' && locked.status !== 'TEMPLATE') {
        throw new ApiError(409, 'Only a draft or a repeating template can be edited');
      }
      assertLineCountAndAccounts(input.lines);
      await assertAccountsExistOnClient(client, orgId, input.lines);
      if (locked.status === 'TEMPLATE') await assertPostableOnClient(client, orgId, input.lines);

      await client.query(
        'UPDATE manual_journals SET narration = $3, entry_date = $4 WHERE id = $1 AND org_id = $2',
        [id, orgId, input.narration, input.entryDate],
      );
      await client.query('DELETE FROM manual_journal_lines WHERE org_id = $1 AND manual_journal_id = $2', [
        orgId,
        id,
      ]);
      await insertLinesOnClient(client, orgId, id, input.lines);
    }),
  );
  return getManualJournalById(orgId, id);
}

export async function deleteManualJournal(orgId: string, id: string): Promise<void> {
  await guarded(() =>
    withTransaction(async (client) => {
      const locked = await lockOnClient(client, orgId, id);
      if (locked.status !== 'DRAFT') throw new ApiError(409, 'Only a draft can be deleted');
      // Lines cascade.
      await client.query('DELETE FROM manual_journals WHERE id = $1 AND org_id = $2', [id, orgId]);
    }),
  );
}

async function postDraftOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  id: string,
  ctx: PostContext,
): Promise<string> {
  const locked = await lockOnClient(client, orgId, id);
  if (!isManualJournalStatus(locked.status) || !canTransitionManualJournal(locked.status, 'POSTED')) {
    throw new ApiError(409, 'Only a draft can be posted');
  }

  const loaded = (await loadLines(client, orgId, [id])).get(id) ?? [];
  const inputs: ManualJournalLineInput[] = loaded.map((l) => ({
    accountId: l.accountId,
    description: l.description,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
  }));
  await assertPostableOnClient(client, orgId, inputs);

  const posting: journalService.JournalLineInput[] = [];
  for (const line of inputs) {
    // Rule 2 of assertPostableOnClient guarantees an account; narrow without `!`.
    if (line.accountId === null) throw new ApiError(422, 'A line has no account');
    posting.push({
      accountId: line.accountId,
      description: line.description,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
    });
  }

  const filled = await journalService.fillJournalDescriptionOnClient(
    client,
    orgId,
    locked.narration,
    locked.entry_date,
    'JOURNAL',
    ctx.occurrence,
  );
  const entryId = await journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: locked.entry_date,
    description: filled.description,
    descriptionTemplate: filled.descriptionTemplate,
    sourceType: ctx.sourceType,
    sourceId: ctx.sourceId,
    lines: posting,
  });

  await client.query(
    `UPDATE manual_journals
        SET status = 'POSTED', journal_entry_id = $3, posted_at = now(),
            narration = $4, narration_template = $5
      WHERE id = $1 AND org_id = $2`,
    [id, orgId, entryId, filled.description ?? locked.narration, filled.descriptionTemplate ?? null],
  );
  return entryId;
}

export async function postManualJournal(orgId: string, userId: string, id: string): Promise<ManualJournal> {
  await guarded(() =>
    withTransaction((client) =>
      postDraftOnClient(client, orgId, userId, id, { sourceType: 'manual', sourceId: null, occurrence: null }),
    ),
  );
  return getManualJournalById(orgId, id);
}

/** Insert a DRAFT with its lines, then post it — on the caller's transaction. */
export async function postNewManualJournalOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: ManualJournalInput & {
    origin: ManualJournalOrigin;
    recurringScheduleId: string | null;
    sourceType: 'manual' | 'recurring' | 'migration_import';
    sourceId: string | null;
    occurrence: number | null;
  },
): Promise<{ manualJournalId: string; journalEntryId: string }> {
  assertLineCountAndAccounts(input.lines);
  await assertAccountsExistOnClient(client, orgId, input.lines);
  const manualJournalId = await insertHeaderOnClient(
    client,
    orgId,
    createdBy,
    'DRAFT',
    input.origin,
    input.recurringScheduleId,
    input,
  );
  await insertLinesOnClient(client, orgId, manualJournalId, input.lines);
  const journalEntryId = await postDraftOnClient(client, orgId, createdBy, manualJournalId, {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    occurrence: input.occurrence,
  });
  return { manualJournalId, journalEntryId };
}

/** Insert a TEMPLATE (validated by post-time rules 1-5) — on the caller's transaction. */
export async function createTemplateOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: ManualJournalInput,
): Promise<string> {
  assertLineCountAndAccounts(input.lines);
  await assertAccountsExistOnClient(client, orgId, input.lines);
  await assertPostableOnClient(client, orgId, input.lines);
  const id = await insertHeaderOnClient(client, orgId, createdBy, 'TEMPLATE', 'MANUAL', null, input);
  await insertLinesOnClient(client, orgId, id, input.lines);
  return id;
}

async function voidOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  id: string,
  voidDate: string | null,
): Promise<string> {
  const locked = await lockOnClient(client, orgId, id);
  // The route table lists both 409s: a second void is "already reversed".
  if (locked.status === 'VOIDED') throw new ApiError(409, 'Entry has already been reversed');
  if (!isManualJournalStatus(locked.status) || !canTransitionManualJournal(locked.status, 'VOIDED')) {
    throw new ApiError(409, 'Only a posted journal can be voided');
  }
  if (locked.journal_entry_id === null) throw new Error(`Posted manual journal ${id} has no journal entry`);

  const reversalId = await journalService.reverseEntryOnClient(
    client,
    orgId,
    userId,
    locked.journal_entry_id,
    voidDate,
  );
  await client.query(
    `UPDATE manual_journals
        SET status = 'VOIDED', void_journal_entry_id = $3, voided_at = now()
      WHERE id = $1 AND org_id = $2`,
    [id, orgId, reversalId],
  );
  return reversalId;
}

export async function voidManualJournal(
  orgId: string,
  userId: string,
  id: string,
  voidDate: string | null,
): Promise<ManualJournal> {
  await guarded(() => withTransaction((client) => voidOnClient(client, orgId, userId, id, voidDate)));
  return getManualJournalById(orgId, id);
}

/** The GL register's POST /journals/:id/reverse. Returns the reversal entry id. */
export async function reverseOrVoidEntry(
  orgId: string,
  userId: string,
  entryId: string,
  entryDate: string | null,
): Promise<string> {
  return guarded(() =>
    withTransaction(async (client) => {
      const { rows: owners } = await client.query<{ id: string }>(
        `SELECT id FROM manual_journals
          WHERE org_id = $1 AND journal_entry_id = $2
            FOR UPDATE`,
        [orgId, entryId],
      );
      const owner = owners[0];
      if (owner !== undefined) return voidOnClient(client, orgId, userId, owner.id, entryDate);

      const { rows } = await client.query<{ source_type: string }>(
        'SELECT source_type FROM journal_entries WHERE id = $1 AND org_id = $2',
        [entryId, orgId],
      );
      const entry = rows[0];
      if (entry === undefined) throw new ApiError(404, 'Journal entry not found');
      if (!journalService.REVERSIBLE_SOURCE_TYPES.includes(entry.source_type)) {
        throw new ApiError(
          409,
          `This entry was posted by a ${entry.source_type} document — correct it from that document instead`,
        );
      }
      return journalService.reverseEntryOnClient(client, orgId, userId, entryId, entryDate);
    }),
  );
}
