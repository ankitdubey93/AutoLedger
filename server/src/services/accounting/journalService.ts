import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import { convertToBase, isCurrencyCode, ONE_RATE } from '../../utils/fxRate.js';
import { containsPlaceholders } from '../../utils/placeholders.js';
import { fillOptionalField, JOURNAL_DESCRIPTION_MAX } from '../../utils/placeholderFields.js';
import { assertPeriodOpenOnClient } from './fiscalPeriodService.js';
import { resolveInventoryControlAccountIdsOnClient } from './itemService.js';
import type { JournalEntry, LedgerLine } from '../../types/accounting.js';

/**
 * Journal entries — the general ledger.
 *
 * Everything here is org-scoped (guardrails rule 1) and every amount is integer
 * cents (rule 3). `createEntryOnClient` is the only write path (the manual path is
 * `manualJournalService`), and posted rows are immutable afterwards: corrections
 * go through `reverseEntryOnClient`, never an UPDATE
 * (rule 6, enforced by trigger in 004 as well as here).
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface JournalLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
  /** Phase 44 — a per-line description (manual journals). */
  description?: string | null;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  /** Phase 8. NUMERIC(18,8) as a string. Omitted means ONE_RATE. Required when currencyCode differs from base. */
  fxRate?: string;
}

export interface CreateEntryInput {
  entryDate: string;
  description: string | null;
  /**
   * Phase 40 — the description as written, when filling its placeholders
   * changed it (`fillJournalDescriptionOnClient`). Never sent by a client.
   */
  descriptionTemplate?: string | null;
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
  description_template: string | null;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  reversed_by_entry_id: string | null;
  created_at: Date;
  manual_journal_id: string | null;
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
  description: string | null;
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
const ENTRY_SELECT = `SELECT e.id, e.entry_date, e.description, e.description_template, e.source_type, e.source_id,
                             e.reverses_entry_id, e.created_by, e.created_at,
                             u.name  AS created_by_name,
                             u.email AS created_by_email,
                             r.id    AS reversed_by_entry_id,
                             mj.id   AS manual_journal_id
                        FROM journal_entries e
                        LEFT JOIN users u
                               ON u.id = e.created_by
                        LEFT JOIN journal_entries r
                               ON r.reverses_entry_id = e.id
                              AND r.org_id = e.org_id
                        LEFT JOIN manual_journals mj
                               ON mj.journal_entry_id = e.id
                              AND mj.org_id = e.org_id`;

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
    // Left as a string on purpose — see types/accounting.ts.
    fxRate: row.fx_rate,
    baseDebitCents: parseCents(row.base_debit_cents),
    baseCreditCents: parseCents(row.base_credit_cents),
    description: row.description,
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
    descriptionTemplate: row.description_template,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
    manualJournalId: row.manual_journal_id,
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
            l.base_debit_cents, l.base_credit_cents, l.description
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
 * Resolves one control account the way `reportService.resolveControlAccounts`
 * does — the configured settings column, else the postable default-chart code —
 * but on the caller's transaction client (guardrails rule 5).
 */
async function resolveControlAccountIdOnClient(
  client: Queryable,
  orgId: string,
  settingsQuery: string,
  fallbackCode: string,
): Promise<string | null> {
  const { rows } = await client.query<{ account_id: string | null }>(settingsQuery, [orgId]);
  const configured = rows[0]?.account_id ?? null;
  if (configured !== null) return configured;

  const { rows: fallbackRows } = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2 AND is_postable',
    [orgId, fallbackCode],
  );
  return fallbackRows[0]?.id ?? null;
}

/**
 * Refuses any line on the receivable or payable control account. Manual and
 * bank-line journals only — documents post through createEntryOnClient,
 * which deliberately does not call this.
 *
 * A control account's balance is the sum of its subledger (every customer's
 * or vendor's open documents). A journal line names no party, so once one
 * lands on a control account the subledger can never tie to the GL again —
 * the same reason SAP refuses direct postings to a reconciliation account.
 * Reversals stay allowed: they can only move the books back toward agreement.
 */
export async function assertNotControlAccountsOnClient(
  client: Queryable,
  orgId: string,
  accountIds: string[],
): Promise<void> {
  const { map, receivableId, payableId } = await loadControlAccountsOnClient(client, orgId);

  // Precedence (unchanged): receivable, then payable, then inventory in the
  // caller's line order — whatever order the lines came in.
  for (const id of [receivableId, payableId]) {
    if (id !== null && accountIds.includes(id)) {
      const message = map.get(id);
      if (message !== undefined) throw new ApiError(422, message);
    }
  }
  for (const accountId of accountIds) {
    const message = map.get(accountId);
    if (message !== undefined) throw new ApiError(422, message);
  }
}

/**
 * Every control account this org has (receivable, payable, inventory control),
 * mapped to the exact message assertNotControlAccountsOnClient throws for it.
 * Insertion order is receivable, payable, inventory; the first writer of an id wins.
 */
export async function listControlAccountsOnClient(client: Queryable, orgId: string): Promise<Map<string, string>> {
  return (await loadControlAccountsOnClient(client, orgId)).map;
}

async function loadControlAccountsOnClient(
  client: Queryable,
  orgId: string,
): Promise<{ map: Map<string, string>; receivableId: string | null; payableId: string | null }> {
  const receivableId = await resolveControlAccountIdOnClient(
    client,
    orgId,
    'SELECT receivable_account_id AS account_id FROM ledger_invoice_settings WHERE org_id = $1',
    '1120',
  );
  const payableId = await resolveControlAccountIdOnClient(
    client,
    orgId,
    'SELECT payable_account_id AS account_id FROM ledger_settings WHERE org_id = $1',
    '2100',
  );
  // Phase 35a — inventory control accounts (Core model §2).
  const inventoryIds = await resolveInventoryControlAccountIdsOnClient(client, orgId);

  const ids = [
    ...new Set([...(receivableId === null ? [] : [receivableId]), ...(payableId === null ? [] : [payableId]), ...inventoryIds]),
  ];
  const codes = new Map<string, string>();
  if (ids.length > 0) {
    const { rows } = await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [orgId, ids],
    );
    for (const row of rows) codes.set(row.id, row.code);
  }
  const codeOf = (id: string): string => codes.get(id) ?? id;

  const map = new Map<string, string>();
  if (receivableId !== null) {
    map.set(
      receivableId,
      `Account ${codeOf(receivableId)} is the receivable control account — post to it through an invoice or a payment, not a journal entry`,
    );
  }
  if (payableId !== null && !map.has(payableId)) {
    map.set(
      payableId,
      `Account ${codeOf(payableId)} is the payable control account — post to it through a bill or a payment, not a journal entry`,
    );
  }
  for (const id of inventoryIds) {
    if (map.has(id)) continue;
    map.set(
      id,
      `Account ${codeOf(id)} is an inventory control account — its balance comes from stock movements. Record stock through bills, invoices or Inventory, or reconcile it under Inventory → Valuation`,
    );
  }
  return { map, receivableId, payableId };
}

/** Phase 44 — entries the GL register may reverse directly (no owning document). */
export const REVERSIBLE_SOURCE_TYPES: readonly string[] = ['manual', 'recurring', 'migration_import', 'opening_balance'];

/**
 * Phase 44 — every account a manual journal may not touch, mapped to the 422
 * message for it: the control accounts (listControlAccountsOnClient, same
 * messages) plus every account flagged bank_account_kind.
 */
export async function listManualJournalBlockedAccountsOnClient(
  client: Queryable,
  orgId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>((await loadControlAccountsOnClient(client, orgId)).map);
  const { rows } = await client.query<{ id: string; code: string; bank_account_kind: string }>(
    `SELECT id, code, bank_account_kind
       FROM accounts
      WHERE org_id = $1 AND bank_account_kind IS NOT NULL
      ORDER BY code`,
    [orgId],
  );
  for (const row of rows) {
    if (map.has(row.id)) continue;
    const label = row.bank_account_kind === 'CREDIT_CARD' ? 'a credit card account' : 'a bank account';
    map.set(
      row.id,
      `Account ${row.code} is ${label} — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal`,
    );
  }
  return map;
}

/** Throws ApiError(422, <message>) for the first blocked account, in line order. */
export async function assertManualJournalAccountsOnClient(
  client: Queryable,
  orgId: string,
  accountIds: string[],
): Promise<void> {
  await assertNotControlAccountsOnClient(client, orgId, accountIds);
  const blocked = await listManualJournalBlockedAccountsOnClient(client, orgId);
  for (const accountId of accountIds) {
    const message = blocked.get(accountId);
    if (message !== undefined) throw new ApiError(422, message);
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
  // A closed period refuses new postings. Checked here so every caller —
  // invoiceService, billService, paymentService and the journals route —
  // gets one readable 422 instead of a raw trigger exception, and checked
  // again by 016's trigger so the service being correct is not the reason
  // a closed month stays closed.
  await assertPeriodOpenOnClient(client, orgId, input.entryDate);

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

  // Phase 8: each line may carry its own currency and rate. Omitted means the
  // organization's base currency at ONE_RATE — the Phase 3 behaviour, kept
  // byte-identical for every base-currency entry. A line whose currency
  // differs from base must carry an explicit rate; if it does not, that is a
  // service bug (no HTTP caller can reach this — every document service
  // resolves a rate before building its lines), so it is a 500, not a 422.
  const resolvedLines = input.lines.map((line) => {
    const lineCurrency = line.currencyCode ?? baseCurrency;
    if (lineCurrency === baseCurrency) {
      return { ...line, currencyCode: baseCurrency, fxRate: ONE_RATE };
    }
    if (!isCurrencyCode(lineCurrency) || line.fxRate === undefined) {
      throw new ApiError(500, 'A foreign-currency line requires an explicit fx rate');
    }
    return { ...line, currencyCode: lineCurrency, fxRate: line.fxRate };
  });

  const baseDebits = resolvedLines.map((line) =>
    convertToBase(cents(line.debitCents), line.fxRate),
  );
  const baseCredits = resolvedLines.map((line) =>
    convertToBase(cents(line.creditCents), line.fxRate),
  );

  // Base currency is what balances, always — integer equality, never an
  // epsilon (guardrails rule 3). This is the invariant the whole system
  // exists to protect, and it is checked again by a deferred constraint
  // trigger at COMMIT (023) so a bug here cannot write an unbalanced entry.
  const totalBaseDebits = sumCents(baseDebits);
  const totalBaseCredits = sumCents(baseCredits);
  if (totalBaseDebits !== totalBaseCredits) {
    throw new ApiError(
      422,
      `Entry is unbalanced in base currency: debits ${String(totalBaseDebits)}, credits ${String(totalBaseCredits)}`,
    );
  }

  // The native-currency sum is only meaningful — and only checked here —
  // when every line shares one currency, mirroring migration 023's trigger
  // exactly so the service and the database never disagree about what is
  // legal. A single-currency entry (every entry before Phase 8, and every
  // base-currency entry after it) is checked exactly as strictly as before.
  const distinctCurrencies = new Set(resolvedLines.map((line) => line.currencyCode));
  if (distinctCurrencies.size === 1) {
    const totalDebits = sumCents(resolvedLines.map((line) => cents(line.debitCents)));
    const totalCredits = sumCents(resolvedLines.map((line) => cents(line.creditCents)));
    if (totalDebits !== totalCredits) {
      throw new ApiError(
        422,
        `Entry is unbalanced: debits ${String(totalDebits)}, credits ${String(totalCredits)}`,
      );
    }
  }

  const { rows: entryRows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (org_id, created_by, entry_date, description, source_type, source_id, description_template)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      orgId,
      createdBy,
      input.entryDate,
      input.description,
      input.sourceType ?? 'manual',
      input.sourceId ?? null,
      input.descriptionTemplate ?? null,
    ],
  );
  const entryId = entryRows[0]?.id;
  if (entryId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  // One multi-row insert via unnest rather than a statement per line.
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents, description)
     SELECT $1, $2, v.account_id, v.debit_cents, v.credit_cents,
            v.currency_code, v.fx_rate, v.base_debit_cents, v.base_credit_cents, v.description
       FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $6::text[], $7::numeric[], $8::bigint[], $9::bigint[], $10::text[])
            AS v(account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents, description)`,
    [
      orgId,
      entryId,
      resolvedLines.map((line) => line.accountId),
      resolvedLines.map((line) => line.debitCents),
      resolvedLines.map((line) => line.creditCents),
      resolvedLines.map((line) => line.currencyCode),
      resolvedLines.map((line) => line.fxRate),
      baseDebits,
      baseCredits,
      resolvedLines.map((line) => line.description ?? null),
    ],
  );

  return entryId;
}

/**
 * Phase 40 — fills a user-authored journal description's placeholders
 * (`AWS [Month]` → `AWS October`) against the entry date. A journal is posted
 * the moment it is created, so this is always a final fill; the text as
 * written is returned as `descriptionTemplate` for a recurring schedule to
 * fill afresh next time.
 *
 * Only for text a person wrote — a manual entry, a recurring journal, a
 * bank-line posting. Never called from `createEntryOnClient`, because every
 * document service passes system text through it (`Invoice INV-1 — <customer
 * name>`), and a customer named "[Month]" must not expand.
 */
export async function fillJournalDescriptionOnClient(
  client: PoolClient,
  orgId: string,
  description: string | null,
  entryDate: string,
  surface: 'JOURNAL' | 'BANK_LINE' = 'JOURNAL',
  occurrence: number | null = null,
): Promise<{ description: string | null; descriptionTemplate: string | null }> {
  if (description === null || !containsPlaceholders(description, surface)) {
    return { description, descriptionTemplate: null };
  }
  const { rows } = await client.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const filled = fillOptionalField(
    description,
    surface,
    { date: entryDate, organisationName: rows[0]?.name ?? null, occurrence },
    'final',
    { label: 'Description', max: JOURNAL_DESCRIPTION_MAX },
  );
  return { description: filled.text, descriptionTemplate: filled.template };
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

  // This function writes journal_entries/ledger_lines directly rather than
  // delegating to createEntryOnClient, so its own period guard is needed too
  // — otherwise a reversal dated in a closed period would fall through to
  // 016's trigger with a less specific message instead of this one.
  await assertPeriodOpenOnClient(client, orgId, entryDate ?? original.entry_date);

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
  // and the base columns. Amounts stay positive. This needs no Phase 8
  // change: currency_code and fx_rate are copied verbatim from the original
  // line, so reversing a foreign-currency (or realized-FX plug) entry is
  // correct for free — including a payment void's realized gain/loss line.
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents, description)
     SELECT org_id, $2, account_id, credit_cents, debit_cents,
            currency_code, fx_rate, base_credit_cents, base_debit_cents, description
       FROM ledger_lines
      WHERE journal_entry_id = $1 AND org_id = $3`,
    [id, reversalId, orgId],
  );

  return reversalId;
}
