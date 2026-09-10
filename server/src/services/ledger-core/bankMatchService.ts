import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import {
  AUTO_MATCH_THRESHOLD,
  MAX_SUGGESTIONS_PER_TRANSACTION,
  SUGGESTION_MIN_SCORE,
  scoreMatch,
  type ScoreBreakdown,
} from '../../utils/matchScore.js';
import * as paymentService from './paymentService.js';
import {
  canTransitionBankTransaction,
  isBankTransactionStatus,
  type BankMatchSuggestion,
  type BankTransaction,
  type BankTransactionStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore bank-line matching: the 40/30/30 confidence engine's
 * suggestion generation, plus accept/reject/ignore. Every GL posting goes
 * through paymentService's createPaymentOnClient/voidPaymentOnClient — this
 * file never writes journal_entries or ledger_lines directly (guardrails
 * rules 5, 16).
 */

const PG_RAISE_EXCEPTION = 'P0001';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the match';
  }
  return 'Database rejected the match';
}

/** Candidate window: documents dated within this many days of the bank line. */
export const CANDIDATE_WINDOW_DAYS = 30;

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

function minDate(dates: string[]): string {
  return dates.reduce((min, d) => (d < min ? d : min));
}

function maxDate(dates: string[]): string {
  return dates.reduce((max, d) => (d > max ? d : max));
}

// ------------------------------------------------------------ suggestions

interface CandidateRow {
  id: string;
  reference: string;
  doc_date: string;
  counterparty_name: string;
  amount_due_cents: string;
}

/**
 * Bank statements stay base-currency-only (Phase 6's stated limit, unchanged
 * by Phase 8) — a base-currency bank line cannot settle a foreign-currency
 * document, so one is never offered as a suggestion. `baseCurrency` is the
 * organization's own, resolved once by the caller, never request input.
 */
async function loadInvoiceCandidates(
  client: PoolClient,
  orgId: string,
  baseCurrency: string,
  windowLow: string,
  windowHigh: string,
): Promise<CandidateRow[]> {
  const { rows } = await client.query<CandidateRow>(
    `SELECT * FROM (
       SELECT i.id, COALESCE(i.invoice_number, i.id::text) AS reference, i.issue_date AS doc_date,
              c.name AS counterparty_name,
              (i.total_cents - ${paymentService.allocatedCentsSubquery('i', 'invoice_id')}::bigint) AS amount_due_cents
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
        WHERE i.org_id = $1
          AND i.status = 'ISSUED'
          AND i.currency_code = $4
          AND i.issue_date BETWEEN $2::date AND $3::date
     ) sub
     WHERE amount_due_cents > 0`,
    [orgId, windowLow, windowHigh, baseCurrency],
  );
  return rows;
}

async function loadBillCandidates(
  client: PoolClient,
  orgId: string,
  baseCurrency: string,
  windowLow: string,
  windowHigh: string,
): Promise<CandidateRow[]> {
  const { rows } = await client.query<CandidateRow>(
    `SELECT * FROM (
       SELECT b.id, b.vendor_reference AS reference, b.bill_date AS doc_date,
              v.name AS counterparty_name,
              (b.total_cents - ${paymentService.allocatedCentsSubquery('b', 'bill_id')}::bigint) AS amount_due_cents
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
        WHERE b.org_id = $1
          AND b.status = 'POSTED'
          AND b.currency_code = $4
          AND b.bill_date BETWEEN $2::date AND $3::date
     ) sub
     WHERE amount_due_cents > 0`,
    [orgId, windowLow, windowHigh, baseCurrency],
  );
  return rows;
}

interface LineForScoring {
  id: string;
  txnDate: string;
  description: string;
  externalReference: string | null;
  amountCents: number;
}

/**
 * Deletes and regenerates suggestions for the given bank lines, on the
 * caller's transaction. Only UNMATCHED lines get suggestions. Returns the
 * number of suggestion rows written.
 */
export async function generateSuggestionsOnClient(
  client: PoolClient,
  orgId: string,
  bankTransactionIds: string[],
): Promise<number> {
  if (bankTransactionIds.length === 0) return 0;

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');

  await client.query(
    'DELETE FROM bank_match_suggestions WHERE org_id = $1 AND bank_transaction_id = ANY($2::uuid[])',
    [orgId, bankTransactionIds],
  );

  const { rows: lineRows } = await client.query<{
    id: string;
    txn_date: string;
    description: string;
    external_reference: string | null;
    amount_cents: string;
  }>(
    `SELECT id, txn_date, description, external_reference, amount_cents
       FROM bank_transactions
      WHERE org_id = $1 AND id = ANY($2::uuid[]) AND status = 'UNMATCHED'`,
    [orgId, bankTransactionIds],
  );

  if (lineRows.length === 0) return 0;

  const lines: LineForScoring[] = lineRows.map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    description: r.description,
    externalReference: r.external_reference,
    amountCents: parseCents(r.amount_cents),
  }));

  const positiveLines = lines.filter((l) => l.amountCents > 0);
  const negativeLines = lines.filter((l) => l.amountCents < 0);

  const invoiceCandidates =
    positiveLines.length > 0
      ? await loadInvoiceCandidates(
          client,
          orgId,
          baseCurrency,
          shiftDate(minDate(positiveLines.map((l) => l.txnDate)), -CANDIDATE_WINDOW_DAYS),
          shiftDate(maxDate(positiveLines.map((l) => l.txnDate)), CANDIDATE_WINDOW_DAYS),
        )
      : [];

  const billCandidates =
    negativeLines.length > 0
      ? await loadBillCandidates(
          client,
          orgId,
          baseCurrency,
          shiftDate(minDate(negativeLines.map((l) => l.txnDate)), -CANDIDATE_WINDOW_DAYS),
          shiftDate(maxDate(negativeLines.map((l) => l.txnDate)), CANDIDATE_WINDOW_DAYS),
        )
      : [];

  interface ToInsert {
    bankTransactionId: string;
    targetType: 'invoice' | 'bill';
    invoiceId: string | null;
    billId: string | null;
    score: number;
    breakdown: ScoreBreakdown;
  }

  const toInsert: ToInsert[] = [];

  for (const line of lines) {
    const candidates = line.amountCents > 0 ? invoiceCandidates : billCandidates;
    const targetType: 'invoice' | 'bill' = line.amountCents > 0 ? 'invoice' : 'bill';

    const scored = candidates
      .map((c) => ({
        candidate: c,
        breakdown: scoreMatch(
          {
            amountCents: line.amountCents,
            txnDate: line.txnDate,
            description: line.description,
            externalReference: line.externalReference,
          },
          {
            documentAmountDueCents: parseCents(c.amount_due_cents),
            documentDate: c.doc_date,
            counterpartyName: c.counterparty_name,
            documentReference: c.reference,
          },
        ),
      }))
      .filter((s) => s.breakdown.total >= SUGGESTION_MIN_SCORE)
      .sort((a, b) => b.breakdown.total - a.breakdown.total || (a.candidate.id < b.candidate.id ? -1 : 1))
      .slice(0, MAX_SUGGESTIONS_PER_TRANSACTION);

    for (const s of scored) {
      toInsert.push({
        bankTransactionId: line.id,
        targetType,
        invoiceId: targetType === 'invoice' ? s.candidate.id : null,
        billId: targetType === 'bill' ? s.candidate.id : null,
        score: s.breakdown.total,
        breakdown: s.breakdown,
      });
    }
  }

  if (toInsert.length === 0) return 0;

  await client.query(
    `INSERT INTO bank_match_suggestions (org_id, bank_transaction_id, target_type, invoice_id, bill_id, score, score_breakdown)
     SELECT $1, v.bank_transaction_id, v.target_type, v.invoice_id, v.bill_id, v.score, v.score_breakdown::jsonb
       FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::int[], $7::text[])
            AS v(bank_transaction_id, target_type, invoice_id, bill_id, score, score_breakdown)`,
    [
      orgId,
      toInsert.map((s) => s.bankTransactionId),
      toInsert.map((s) => s.targetType),
      toInsert.map((s) => s.invoiceId),
      toInsert.map((s) => s.billId),
      toInsert.map((s) => s.score),
      toInsert.map((s) => JSON.stringify(s.breakdown)),
    ],
  );

  return toInsert.length;
}

// ---------------------------------------------------------------- row mapping

interface BankTxnRow {
  id: string;
  import_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  txn_date: string;
  description: string;
  external_reference: string | null;
  currency_code: string;
  amount_cents: string;
  status: string;
  matched_payment_id: string | null;
  matched_at: Date | null;
  matched_by: string | null;
  matched_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const BANK_TXN_SELECT = `SELECT bt.id, bt.import_id, bt.account_id, a.code AS account_code, a.name AS account_name,
                                 bt.txn_date, bt.description, bt.external_reference, bt.currency_code, bt.amount_cents,
                                 bt.status, bt.matched_payment_id, bt.matched_at, bt.matched_by, u.name AS matched_by_name,
                                 bt.created_at, bt.updated_at
                            FROM bank_transactions bt
                            JOIN accounts a ON a.id = bt.account_id AND a.org_id = bt.org_id
                            LEFT JOIN users u ON u.id = bt.matched_by`;

interface SuggestionRow {
  id: string;
  bank_transaction_id: string;
  target_type: string;
  invoice_id: string | null;
  bill_id: string | null;
  score: number;
  score_breakdown: unknown;
  document_reference: string;
  document_date: string;
  counterparty_name: string;
  document_total_cents: string;
  document_amount_due_cents: string;
}

function toSuggestion(row: SuggestionRow): BankMatchSuggestion {
  const targetType = row.target_type;
  if (targetType !== 'invoice' && targetType !== 'bill') {
    throw new Error(`Unknown suggestion target_type "${targetType}" on suggestion ${row.id}`);
  }
  return {
    id: row.id,
    targetType,
    invoiceId: row.invoice_id,
    billId: row.bill_id,
    documentReference: row.document_reference,
    documentDate: row.document_date,
    counterpartyName: row.counterparty_name,
    documentTotalCents: parseCents(row.document_total_cents),
    documentAmountDueCents: parseCents(row.document_amount_due_cents),
    score: row.score,
    scoreBreakdown: row.score_breakdown,
    autoMatchable: row.score >= AUTO_MATCH_THRESHOLD,
  };
}

/** Loads suggestions for a set of bank lines in one query — never one query per line. */
async function loadSuggestions(
  orgId: string,
  bankTransactionIds: string[],
): Promise<Map<string, BankMatchSuggestion[]>> {
  const byTxn = new Map<string, BankMatchSuggestion[]>();
  if (bankTransactionIds.length === 0) return byTxn;

  const { rows } = await pool.query<SuggestionRow>(
    `SELECT s.id, s.bank_transaction_id, s.target_type, s.invoice_id, s.bill_id, s.score, s.score_breakdown,
            COALESCE(i.invoice_number, i.id::text, b.vendor_reference) AS document_reference,
            COALESCE(i.issue_date, b.bill_date) AS document_date,
            COALESCE(ci.name, cv.name) AS counterparty_name,
            COALESCE(i.total_cents, b.total_cents) AS document_total_cents,
            (COALESCE(i.total_cents, b.total_cents) - COALESCE((
               SELECT SUM(pa.amount_cents) FROM payment_allocations pa
                 JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
                WHERE pa.org_id = s.org_id
                  AND ((s.invoice_id IS NOT NULL AND pa.invoice_id = s.invoice_id) OR
                       (s.bill_id IS NOT NULL AND pa.bill_id = s.bill_id))
                  AND p.status = 'POSTED'
             ), 0)) AS document_amount_due_cents
       FROM bank_match_suggestions s
       LEFT JOIN invoices i ON i.id = s.invoice_id AND i.org_id = s.org_id
       LEFT JOIN bills b ON b.id = s.bill_id AND b.org_id = s.org_id
       LEFT JOIN customers ci ON ci.id = i.customer_id AND ci.org_id = i.org_id
       LEFT JOIN vendors cv ON cv.id = b.vendor_id AND cv.org_id = b.org_id
      WHERE s.org_id = $1 AND s.bank_transaction_id = ANY($2::uuid[])
      ORDER BY s.bank_transaction_id, s.score DESC`,
    [orgId, bankTransactionIds],
  );

  for (const row of rows) {
    const list = byTxn.get(row.bank_transaction_id) ?? [];
    list.push(toSuggestion(row));
    byTxn.set(row.bank_transaction_id, list);
  }
  return byTxn;
}

function toBankTransaction(row: BankTxnRow, suggestions: BankMatchSuggestion[]): BankTransaction {
  const status = row.status;
  if (!isBankTransactionStatus(status)) {
    throw new Error(`Unknown bank transaction status "${status}" on transaction ${row.id}`);
  }
  return {
    id: row.id,
    importId: row.import_id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    txnDate: row.txn_date,
    description: row.description,
    externalReference: row.external_reference,
    currencyCode: row.currency_code.trim(),
    amountCents: parseCents(row.amount_cents),
    status,
    matchedPaymentId: row.matched_payment_id,
    matchedAt: row.matched_at === null ? null : row.matched_at.toISOString(),
    matchedBy: row.matched_by,
    matchedByName: row.matched_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    suggestions,
  };
}

// ---------------------------------------------------------------------- reads

export async function getTransactionById(orgId: string, id: string): Promise<BankTransaction> {
  const { rows } = await pool.query<BankTxnRow>(`${BANK_TXN_SELECT} WHERE bt.id = $1 AND bt.org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Bank transaction not found');
  const suggestionMap = await loadSuggestions(orgId, [row.id]);
  return toBankTransaction(row, suggestionMap.get(row.id) ?? []);
}

export interface ListBankTransactionsOptions {
  page: number;
  limit: number;
  accountId: string | null;
  importId: string | null;
  status: BankTransactionStatus | null;
  from: string | null;
  to: string | null;
  /** ILIKE over description and external_reference. */
  q: string | null;
  /** Only lines carrying a suggestion at or above this score. */
  minScore: number | null;
}

function buildFilters(
  orgId: string,
  options: ListBankTransactionsOptions,
): { where: string; values: unknown[] } {
  const clauses = ['bt.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.accountId !== null) add((p) => `bt.account_id = ${p}::uuid`, options.accountId);
  if (options.importId !== null) add((p) => `bt.import_id = ${p}::uuid`, options.importId);
  if (options.status !== null) add((p) => `bt.status = ${p}`, options.status);
  if (options.from !== null) add((p) => `bt.txn_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `bt.txn_date <= ${p}::date`, options.to);
  if (options.q !== null) {
    add((p) => `(bt.description ILIKE ${p} OR bt.external_reference ILIKE ${p})`, `%${options.q}%`);
  }
  if (options.minScore !== null) {
    add(
      (p) =>
        `EXISTS (SELECT 1 FROM bank_match_suggestions s WHERE s.bank_transaction_id = bt.id AND s.org_id = bt.org_id AND s.score >= ${p})`,
      options.minScore,
    );
  }

  return { where: clauses.join(' AND '), values };
}

export async function listTransactions(
  orgId: string,
  options: ListBankTransactionsOptions,
): Promise<{ transactions: BankTransaction[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM bank_transactions bt WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `bt.id DESC` is a required tiebreaker: two lines sharing a txn_date and
  // created_at could otherwise swap between pages.
  const { rows } = await pool.query<BankTxnRow>(
    `${BANK_TXN_SELECT}
      WHERE ${where}
      ORDER BY bt.txn_date DESC, bt.created_at DESC, bt.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const suggestionMap = await loadSuggestions(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    transactions: rows.map((row) => toBankTransaction(row, suggestionMap.get(row.id) ?? [])),
    totalCount,
  };
}

/** Deletes and regenerates one UNMATCHED line's suggestions. */
export async function rescoreTransaction(orgId: string, id: string): Promise<BankTransaction> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM bank_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bank transaction not found');
    if (row.status !== 'UNMATCHED') {
      throw new ApiError(422, 'Only an unmatched bank line can be rescored');
    }
    await generateSuggestionsOnClient(client, orgId, [id]);
  });
  return getTransactionById(orgId, id);
}

// --------------------------------------------------------------------- writes

export interface MatchTargetInput {
  suggestionId: string | null;
  invoiceId: string | null;
  billId: string | null;
}

interface ResolvedTarget {
  invoiceId: string | null;
  billId: string | null;
}

async function resolveTarget(
  client: PoolClient,
  orgId: string,
  bankTransactionId: string,
  target: MatchTargetInput,
): Promise<ResolvedTarget> {
  if (target.suggestionId !== null) {
    const { rows } = await client.query<{ invoice_id: string | null; bill_id: string | null }>(
      'SELECT invoice_id, bill_id FROM bank_match_suggestions WHERE id = $1 AND org_id = $2 AND bank_transaction_id = $3',
      [target.suggestionId, orgId, bankTransactionId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Suggestion not found');
    return { invoiceId: row.invoice_id, billId: row.bill_id };
  }
  return { invoiceId: target.invoiceId, billId: target.billId };
}

export async function matchTransaction(
  orgId: string,
  userId: string,
  id: string,
  target: MatchTargetInput,
): Promise<BankTransaction> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: lineRows } = await client.query<{
      id: string;
      status: string;
      txn_date: string;
      description: string;
      external_reference: string | null;
      amount_cents: string;
      account_id: string;
      currency_code: string;
    }>(
      `SELECT id, status, txn_date, description, external_reference, amount_cents, account_id, currency_code
         FROM bank_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId],
    );
    const line = lineRows[0];
    if (line === undefined) throw new ApiError(404, 'Bank transaction not found');
    if (!isBankTransactionStatus(line.status)) {
      throw new Error(`Unknown bank transaction status "${line.status}" on transaction ${id}`);
    }
    if (!canTransitionBankTransaction(line.status, 'MATCHED')) {
      throw new ApiError(
        409,
        line.status === 'MATCHED'
          ? 'This bank line is already matched'
          : 'This bank line is ignored — un-ignore it first',
      );
    }

    const resolved = await resolveTarget(client, orgId, id, target);
    const amountCents = parseCents(line.amount_cents);

    if (amountCents > 0 && resolved.invoiceId === null) {
      throw new ApiError(422, 'A deposit can only be matched to an invoice');
    }
    if (amountCents < 0 && resolved.billId === null) {
      throw new ApiError(422, 'A withdrawal can only be matched to a bill');
    }

    let counterpartyId: string;
    let invoiceId: string | null = null;
    let billId: string | null = null;

    if (amountCents > 0) {
      const invId = resolved.invoiceId;
      if (invId === null) throw new ApiError(422, 'A deposit can only be matched to an invoice');
      const { rows } = await client.query<{
        status: string;
        customer_id: string;
        total_cents: string;
        currency_code: string;
        amount_due_cents: string;
      }>(
        `SELECT i.status, i.customer_id, i.total_cents, i.currency_code,
                (i.total_cents - ${paymentService.allocatedCentsSubquery('i', 'invoice_id')}::bigint) AS amount_due_cents
           FROM invoices i WHERE i.id = $1 AND i.org_id = $2 FOR UPDATE`,
        [invId, orgId],
      );
      const doc = rows[0];
      if (doc === undefined) throw new ApiError(422, 'Invoice not found');
      if (doc.status !== 'ISSUED') throw new ApiError(422, 'Only an issued invoice can be paid');
      // Bank statements are base-currency only (Phase 6's stated limit) — a
      // base-currency bank line cannot settle a foreign-currency document.
      // Candidates already exclude these (loadInvoiceCandidates), so this is
      // the guard for a manually-chosen suggestionId/invoiceId.
      if (doc.currency_code.trim() !== line.currency_code.trim()) {
        throw new ApiError(422, 'A base-currency bank line cannot settle a foreign-currency document');
      }
      const amountDue = parseCents(doc.amount_due_cents);
      if (amountDue <= 0) throw new ApiError(422, 'That document is already settled');
      if (amountCents > amountDue) {
        throw new ApiError(422, 'The bank line exceeds the amount still due on that document');
      }
      counterpartyId = doc.customer_id;
      invoiceId = invId;
    } else {
      const bId = resolved.billId;
      if (bId === null) throw new ApiError(422, 'A withdrawal can only be matched to a bill');
      const { rows } = await client.query<{
        status: string;
        vendor_id: string;
        total_cents: string;
        currency_code: string;
        amount_due_cents: string;
      }>(
        `SELECT b.status, b.vendor_id, b.total_cents, b.currency_code,
                (b.total_cents - ${paymentService.allocatedCentsSubquery('b', 'bill_id')}::bigint) AS amount_due_cents
           FROM bills b WHERE b.id = $1 AND b.org_id = $2 FOR UPDATE`,
        [bId, orgId],
      );
      const doc = rows[0];
      if (doc === undefined) throw new ApiError(422, 'Bill not found');
      if (doc.status !== 'POSTED') throw new ApiError(422, 'Only an approved bill can be paid');
      if (doc.currency_code.trim() !== line.currency_code.trim()) {
        throw new ApiError(422, 'A base-currency bank line cannot settle a foreign-currency document');
      }
      const amountDue = parseCents(doc.amount_due_cents);
      if (amountDue <= 0) throw new ApiError(422, 'That document is already settled');
      if (Math.abs(amountCents) > amountDue) {
        throw new ApiError(422, 'The bank line exceeds the amount still due on that document');
      }
      counterpartyId = doc.vendor_id;
      billId = bId;
    }

    const absAmount = Math.abs(amountCents);
    const direction = amountCents > 0 ? 'RECEIVE' : 'PAY';

    const paymentId = await paymentService.createPaymentOnClient(client, orgId, userId, {
      direction,
      paymentDate: line.txn_date,
      amountCents: absAmount,
      cashAccountId: line.account_id,
      customerId: direction === 'RECEIVE' ? counterpartyId : null,
      vendorId: direction === 'PAY' ? counterpartyId : null,
      method: 'Bank import',
      reference: line.external_reference,
      notes: null,
      allocations: [{ invoiceId, billId, amountCents: absAmount }],
      entryDate: null,
    });

    await client.query(
      `UPDATE bank_transactions SET status = 'MATCHED', matched_payment_id = $1, matched_at = now(), matched_by = $2
        WHERE id = $3 AND org_id = $4`,
      [paymentId, userId, id, orgId],
    );

    // Spent suggestions are derived data and are not kept.
    await client.query('DELETE FROM bank_match_suggestions WHERE org_id = $1 AND bank_transaction_id = $2', [
      orgId,
      id,
    ]);

    await client.query('COMMIT');
    return await getTransactionById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function unmatchTransaction(orgId: string, userId: string, id: string): Promise<BankTransaction> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows } = await client.query<{ id: string; status: string; matched_payment_id: string | null }>(
      'SELECT id, status, matched_payment_id FROM bank_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bank transaction not found');
    if (!isBankTransactionStatus(row.status)) {
      throw new Error(`Unknown bank transaction status "${row.status}" on transaction ${id}`);
    }
    // canTransitionBankTransaction alone would also accept IGNORED -> UNMATCHED
    // (that is /unignore's job, a separate endpoint) — the FSM check still runs
    // first as the single source of truth for legality, and the extra
    // `row.status !== 'MATCHED'` layers this endpoint's own narrower rule on
    // top of it, never replacing it (guardrails rule 10).
    if (!canTransitionBankTransaction(row.status, 'UNMATCHED') || row.status !== 'MATCHED') {
      throw new ApiError(409, 'This bank line is not matched');
    }

    if (row.matched_payment_id !== null) {
      const { rows: paymentRows } = await client.query<{ status: string }>(
        'SELECT status FROM payments WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [row.matched_payment_id, orgId],
      );
      const paymentStatus = paymentRows[0]?.status;
      if (paymentStatus === 'POSTED') {
        await paymentService.voidPaymentOnClient(client, orgId, userId, row.matched_payment_id, null);
      }
    }

    await client.query(
      `UPDATE bank_transactions SET status = 'UNMATCHED', matched_payment_id = NULL, matched_at = NULL, matched_by = NULL
        WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );

    await generateSuggestionsOnClient(client, orgId, [id]);

    await client.query('COMMIT');
    return await getTransactionById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** POST /:id/ignore -> ignored = true ; POST /:id/unignore -> ignored = false */
export async function setIgnored(orgId: string, id: string, ignored: boolean): Promise<BankTransaction> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM bank_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bank transaction not found');
    if (!isBankTransactionStatus(row.status)) {
      throw new Error(`Unknown bank transaction status "${row.status}" on transaction ${id}`);
    }
    const target: BankTransactionStatus = ignored ? 'IGNORED' : 'UNMATCHED';
    if (!canTransitionBankTransaction(row.status, target)) {
      throw new ApiError(409, 'This bank line is matched — unmatch it first');
    }
    await client.query('UPDATE bank_transactions SET status = $1 WHERE id = $2 AND org_id = $3', [
      target,
      id,
      orgId,
    ]);
    if (!ignored) {
      await generateSuggestionsOnClient(client, orgId, [id]);
    }
  });
  return getTransactionById(orgId, id);
}
