import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import type { JournalEntry, LedgerLine } from '../../types/ledger-core.js';

/**
 * Journal entries — the general ledger.
 *
 * Everything here is org-scoped (guardrails rule 1) and every amount is integer
 * cents (rule 3). `createEntry` is the only write path, and posted rows are
 * immutable afterwards: corrections go through `reverseEntry`, never an UPDATE
 * (rule 6, enforced by trigger in 004 as well as here).
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Raised by our own trigger functions in 004. */
const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the entry';
  }
  return 'Database rejected the entry';
}

export interface JournalLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
}

export interface CreateEntryInput {
  entryDate: string;
  description: string | null;
  /** Other apps pass their own slug; a client-posted entry is always 'manual'. */
  sourceType?: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
}

// ---------------------------------------------------------------- row mapping

interface EntryRow {
  id: string;
  /** A string, not a Date — see the DATE type parser in db/connect.ts. */
  entry_date: string;
  description: string | null;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  reversed_by_entry_id: string | null;
  created_at: Date;
}

interface LineRow {
  id: string;
  journal_entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit_cents: string;
  credit_cents: string;
  currency_code: string;
  fx_rate: string;
  base_debit_cents: string;
  base_credit_cents: string;
}

/**
 * The base entry read, as a `FROM`-clause fragment rather than a plain column
 * list — the register needs the posting user's name and whether the entry has
 * been reversed, both of which live on other rows.
 *
 * Both joins are `LEFT`: a missing user must not drop the entry, and most
 * entries have no reversal. `r` (a possible reversal of `e`) carries
 * `r.org_id = e.org_id` in its own join condition, not only in the outer
 * `WHERE` — the same discipline `reportService`'s LEFT JOIN uses, and required
 * for the same reason: dropping it from the join condition of a LEFT JOIN
 * would silently turn it into an INNER JOIN and drop every un-reversed entry.
 * The unique index on `reverses_entry_id` (migration 004) guarantees at most
 * one match, so this cannot fan the result out. `users` is a platform table,
 * not another app's table, and `created_by` stays an audit field only — never
 * an access check (guardrails rules 1 and 16).
 */
const ENTRY_SELECT = `SELECT e.id, e.entry_date, e.description, e.source_type, e.source_id,
                             e.reverses_entry_id, e.created_by, e.created_at,
                             u.name  AS created_by_name,
                             u.email AS created_by_email,
                             r.id    AS reversed_by_entry_id
                        FROM journal_entries e
                        LEFT JOIN users u
                               ON u.id = e.created_by
                        LEFT JOIN journal_entries r
                               ON r.reverses_entry_id = e.id
                              AND r.org_id = e.org_id`;

function toLine(row: LineRow): LedgerLine {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    // BIGINT arrives as a string; parseCents is the only sanctioned conversion.
    debitCents: parseCents(row.debit_cents),
    creditCents: parseCents(row.credit_cents),
    currencyCode: row.currency_code.trim(),
    // Left as a string on purpose — see types/ledger-core.ts.
    fxRate: row.fx_rate,
    baseDebitCents: parseCents(row.base_debit_cents),
    baseCreditCents: parseCents(row.base_credit_cents),
  };
}

function toEntry(row: EntryRow, lines: LedgerLine[]): JournalEntry {
  // Integer addition over values parseCents already validated — never a float,
  // never Math.round (guardrails rule 3).
  const totalDebitCents = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const totalCreditCents = lines.reduce((sum, line) => sum + line.creditCents, 0);

  return {
    id: row.id,
    // Already 'YYYY-MM-DD' — a DATE is a calendar date, never an instant, and
    // routing it through a JS Date would shift it by a day (db/connect.ts).
    entryDate: row.entry_date,
    description: row.description,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at.toISOString(),
    totalDebitCents,
    totalCreditCents,
    lines,
  };
}

/** Loads the lines for a set of entries in one query — never one query per entry. */
async function loadLines(
  q: Queryable,
  orgId: string,
  entryIds: string[],
): Promise<Map<string, LedgerLine[]>> {
  const byEntry = new Map<string, LedgerLine[]>();
  if (entryIds.length === 0) return byEntry;

  const { rows } = await q.query<LineRow>(
    `SELECT l.id, l.journal_entry_id, l.account_id,
            a.code AS account_code, a.name AS account_name,
            l.debit_cents, l.credit_cents, l.currency_code, l.fx_rate,
            l.base_debit_cents, l.base_credit_cents
       FROM ledger_lines l
       JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.journal_entry_id = ANY($2::uuid[])
      ORDER BY l.created_at ASC, l.id ASC`,
    [orgId, entryIds],
  );

  for (const row of rows) {
    const list = byEntry.get(row.journal_entry_id) ?? [];
    list.push(toLine(row));
    byEntry.set(row.journal_entry_id, list);
  }
  return byEntry;
}

// ---------------------------------------------------------------------- reads

export async function getEntryById(orgId: string, id: string): Promise<JournalEntry> {
  const { rows } = await pool.query<EntryRow>(
    `${ENTRY_SELECT} WHERE e.id = $1 AND e.org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Journal entry not found');

  const lines = await loadLines(pool, orgId, [row.id]);
  return toEntry(row, lines.get(row.id) ?? []);
}

export interface ListEntriesOptions {
  page: number;
  limit: number;
  /** Inclusive `entry_date` lower bound, 'YYYY-MM-DD'. */
  from: string | null;
  /** Inclusive `entry_date` upper bound, 'YYYY-MM-DD'. */
  to: string | null;
  /** Only entries touching this account on at least one line. */
  accountId: string | null;
  sourceType: string | null;
  /** Case-insensitive substring match on `description`. */
  q: string | null;
}

/**
 * Builds one shared `WHERE` predicate for both the count and the page query.
 *
 * Sharing this between the two is what keeps `totalCount` honest under a
 * filter — building the count from a different predicate string than the page
 * is how the two silently disagree. Only `$n` placeholders are ever inserted
 * into a fragment, never a caller's value (guardrails rule 4).
 */
function buildFilters(
  orgId: string,
  options: ListEntriesOptions,
): { where: string; values: unknown[] } {
  const clauses = ['e.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.from !== null) add((p) => `e.entry_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `e.entry_date <= ${p}::date`, options.to);
  if (options.sourceType !== null) add((p) => `e.source_type = ${p}`, options.sourceType);
  if (options.q !== null) add((p) => `e.description ILIKE '%' || ${p} || '%'`, options.q);
  if (options.accountId !== null)
    add(
      (p) => `EXISTS (SELECT 1 FROM ledger_lines l
                       WHERE l.journal_entry_id = e.id
                         AND l.org_id = e.org_id
                         AND l.account_id = ${p}::uuid)`,
      options.accountId,
    );

  return { where: clauses.join(' AND '), values };
}

export async function listEntries(
  orgId: string,
  options: ListEntriesOptions,
): Promise<{ entries: JournalEntry[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM journal_entries e WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `e.id DESC` is a required tiebreaker, not decoration: two entries sharing
  // an entry_date and created_at could otherwise swap between pages and be
  // shown twice or not at all.
  const { rows } = await pool.query<EntryRow>(
    `${ENTRY_SELECT}
      WHERE ${where}
      ORDER BY e.entry_date DESC, e.created_at DESC, e.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  // Two queries for any number of entries, not one per entry.
  const lines = await loadLines(
    pool,
    orgId,
    rows.map((r) => r.id),
  );

  return {
    entries: rows.map((row) => toEntry(row, lines.get(row.id) ?? [])),
    totalCount,
  };
}

// --------------------------------------------------------------------- writes

/**
 * Confirms every account exists in this organization and can be posted to.
 *
 * The trigger in 004 enforces both of these too, and would catch a bug here.
 * This check exists so the caller gets a clear message naming the account code
 * rather than a raw database exception carrying internal UUIDs.
 */
async function assertAccountsArePostable(
  client: Queryable,
  orgId: string,
  accountIds: string[],
): Promise<void> {
  const unique = [...new Set(accountIds)];

  const { rows } = await client.query<{ id: string; code: string; is_postable: boolean }>(
    'SELECT id, code, is_postable FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, unique],
  );

  if (rows.length !== unique.length) {
    throw new ApiError(422, 'Account not found');
  }

  const header = rows.find((row) => !row.is_postable);
  if (header !== undefined) {
    throw new ApiError(
      422,
      `Account ${header.code} is a header account and cannot be posted to`,
    );
  }
}

/**
 * Posts one balanced entry on a caller-supplied, already-open transaction
 * client. Runs no BEGIN, no COMMIT and no ROLLBACK — the caller owns the
 * transaction, which is what lets a document (an invoice, say) and its
 * journal entry commit together or not at all (guardrails rule 5).
 */
export async function createEntryOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: CreateEntryInput,
): Promise<string> {
  // Integer equality, never an epsilon. This is the invariant the whole system
  // exists to protect, and it is checked again by a deferred constraint trigger
  // at COMMIT so that a bug here cannot write an unbalanced entry.
  const totalDebits = sumCents(input.lines.map((line) => cents(line.debitCents)));
  const totalCredits = sumCents(input.lines.map((line) => cents(line.creditCents)));

  if (totalDebits !== totalCredits) {
    throw new ApiError(
      422,
      `Entry is unbalanced: debits ${String(totalDebits)}, credits ${String(totalCredits)}`,
    );
  }

  await assertAccountsArePostable(
    client,
    orgId,
    input.lines.map((line) => line.accountId),
  );

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');

  const { rows: entryRows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (org_id, created_by, entry_date, description, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      orgId,
      createdBy,
      input.entryDate,
      input.description,
      input.sourceType ?? 'manual',
      input.sourceId ?? null,
    ],
  );
  const entryId = entryRows[0]?.id;
  if (entryId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  // One multi-row insert via unnest rather than a statement per line.
  //
  // Phase 3 posts base-currency entries only: currency_code is the org's base
  // currency, fx_rate is 1, and the base_* columns equal the native ones. The
  // columns exist now because they cannot be retrofitted later — Phase 8
  // builds the engine that makes them differ.
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents)
     SELECT $1, $2, v.account_id, v.debit_cents, v.credit_cents,
            $6, 1, v.debit_cents, v.credit_cents
       FROM unnest($3::uuid[], $4::bigint[], $5::bigint[])
            AS v(account_id, debit_cents, credit_cents)`,
    [
      orgId,
      entryId,
      input.lines.map((line) => line.accountId),
      input.lines.map((line) => line.debitCents),
      input.lines.map((line) => line.creditCents),
      baseCurrency,
    ],
  );

  return entryId;
}

/**
 * Posts one balanced entry and its lines, atomically.
 *
 * Everything runs on the checked-out `client` (guardrails rule 5) — a stray
 * `pool.query` would take a different connection, commit immediately, and
 * survive the rollback, leaving orphaned lines and an unbalanced book.
 *
 * There is deliberately no work after `COMMIT`. Anything owed afterwards is a
 * queued job (Phase 7), not a fire-and-forget call.
 */
export async function createEntry(
  orgId: string,
  createdBy: string,
  input: CreateEntryInput,
): Promise<JournalEntry> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entryId = await createEntryOnClient(client, orgId, createdBy, input);

    // COMMIT is where the deferred balance trigger runs, so a failure here is
    // still inside the try and still rolls back cleanly.
    await client.query('COMMIT');

    return await getEntryById(orgId, entryId);
  } catch (err) {
    await client.query('ROLLBACK');

    // Surface our own trigger rejections as a domain error rather than letting
    // a raw Postgres exception reach the client.
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Posts a reversal on a caller-supplied, already-open transaction client. Runs
 * no BEGIN, no COMMIT and no ROLLBACK — see `createEntryOnClient`.
 *
 * A reversal is a new entry with each line's debit and credit swapped — never a
 * negative amount, which `chk_line_nonzero` and the non-negative CHECKs would
 * reject anyway, and which would misstate the account's turnover even if it did
 * not. The original row is never touched.
 */
export async function reverseEntryOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  id: string,
  entryDate: string | null,
): Promise<string> {
  const { rows: originalRows } = await client.query<{
    id: string;
    entry_date: string;
    description: string | null;
    source_type: string;
    reverses_entry_id: string | null;
  }>(
    `SELECT id, entry_date, description, source_type, reverses_entry_id
       FROM journal_entries
      WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  const original = originalRows[0];
  if (original === undefined) throw new ApiError(404, 'Journal entry not found');

  if (original.reverses_entry_id !== null) {
    throw new ApiError(422, 'A reversing entry cannot itself be reversed');
  }

  const { rows: existingReversal } = await client.query<{ id: string }>(
    'SELECT id FROM journal_entries WHERE org_id = $1 AND reverses_entry_id = $2',
    [orgId, id],
  );
  if (existingReversal.length > 0) {
    throw new ApiError(409, 'Entry has already been reversed');
  }

  const { rows: newRows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (org_id, created_by, entry_date, description, source_type, reverses_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      orgId,
      createdBy,
      entryDate ?? original.entry_date,
      `Reversal of ${original.description ?? id}`,
      original.source_type,
      id,
    ],
  );
  const reversalId = newRows[0]?.id;
  if (reversalId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  // The swap: debit becomes credit, credit becomes debit, in both the native
  // and the base columns. Amounts stay positive.
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents)
     SELECT org_id, $2, account_id, credit_cents, debit_cents,
            currency_code, fx_rate, base_credit_cents, base_debit_cents
       FROM ledger_lines
      WHERE journal_entry_id = $1 AND org_id = $3`,
    [id, reversalId, orgId],
  );

  return reversalId;
}

/**
 * The only correction path (guardrails rule 6).
 */
export async function reverseEntry(
  orgId: string,
  createdBy: string,
  id: string,
  entryDate: string | null,
): Promise<JournalEntry> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reversalId = await reverseEntryOnClient(client, orgId, createdBy, id, entryDate);

    await client.query('COMMIT');
    return await getEntryById(orgId, reversalId);
  } catch (err) {
    await client.query('ROLLBACK');

    // The partial unique index on reverses_entry_id is what makes the check
    // above race-safe; this turns its 23505 into the same readable 409.
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'Entry has already been reversed');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}
