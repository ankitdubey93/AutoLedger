import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, scaleCents, sumCents } from '../../utils/money.js';
import { convertToBase } from '../../utils/fxRate.js';
import * as journalService from './journalService.js';
import * as invoiceService from './invoiceService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import { settledCentsOnClient } from './settlementSql.js';
import {
  canTransitionNote,
  isNoteReasonCode,
  isNoteStatus,
  type CreditNote,
  type CreditNoteAllocation,
  type CreditNoteLine,
  type NoteReasonCode,
  type NoteStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore credit notes — Phase 26's AR correcting document.
 *
 * A credit note is issued by us to a customer and reduces what they owe on an
 * ISSUED invoice: a return, a price allowance, a post-sale discount, damaged
 * goods. Issuing it posts DR revenue (usually 4800 Sales Returns &
 * Allowances) + DR output tax / CR Accounts Receivable, and — in the same
 * transaction — applies it to its own invoice up to the amount still due. Any
 * remainder is unapplied credit on the customer's account, which
 * `applyCreditNote` can later match against another open invoice.
 *
 * The note always references its original invoice and copies that invoice's
 * customer, currency and frozen fx_rate. Posting at the invoice's own rate is
 * what makes applying the note back to that invoice FX-neutral.
 *
 * Like an invoice, a DRAFT is an ordinary editable row (not a rule 6
 * violation — it has posted nothing), and an ISSUED note is immutable in the
 * database too (migration 063's trg_credit_notes_immutable). Its only
 * correction path is `voidCreditNote`, which posts a reversal.
 *
 * This file never writes `journal_entries` or `ledger_lines` directly — every
 * GL posting goes through `journalService`'s `*OnClient` functions on this
 * service's own checked-out transaction client (guardrails rules 5 and 16).
 * Lock order is always note first, then invoice; payments lock only invoices,
 * so the two can never deadlock against each other.
 */

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the credit note';
  }
  return 'Database rejected the credit note';
}

export interface CreditNoteLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  taxRateBp: number;
}

export interface CreateCreditNoteInput {
  invoiceId: string;
  issueDate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  notes: string | null;
  lines: CreditNoteLineInput[];
}

export type UpdateCreditNoteInput = CreateCreditNoteInput;

export interface ListCreditNotesOptions {
  page: number;
  limit: number;
  status: NoteStatus | null;
  customerId: string | null;
  invoiceId: string | null;
  from: string | null;
  to: string | null;
}

export interface ApplyCreditNoteInput {
  invoiceId: string;
  amountCents: number;
  allocationDate: string;
}

// ---------------------------------------------------------------- row mapping

interface CreditNoteRow {
  id: string;
  credit_note_number: string | null;
  status: string;
  customer_id: string;
  customer_name: string;
  invoice_id: string;
  invoice_number: string | null;
  issue_date: string;
  currency_code: string;
  fx_rate: string;
  reason_code: string;
  reason: string | null;
  customer_name_snapshot: string;
  customer_address_snapshot: string | null;
  customer_tax_number_snapshot: string | null;
  notes: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  base_subtotal_cents: string;
  base_tax_cents: string;
  base_total_cents: string;
  journal_entry_id: string | null;
  void_journal_entry_id: string | null;
  issued_at: Date | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CreditNoteLineRow {
  id: string;
  credit_note_id: string;
  line_number: number;
  description: string;
  quantity_milli: string;
  unit_price_cents: string;
  revenue_account_id: string;
  revenue_account_code: string;
  revenue_account_name: string;
  tax_rate_bp: number;
  net_cents: string;
  tax_cents: string;
}

interface AllocationRow {
  id: string;
  credit_note_id: string;
  invoice_id: string;
  invoice_number: string | null;
  amount_cents: string;
  base_amount_cents: string;
  allocation_date: string;
  created_at: Date;
}

const CREDIT_NOTE_SELECT = `SELECT n.id, n.credit_note_number, n.status, n.customer_id, c.name AS customer_name,
                                   n.invoice_id, inv.invoice_number, n.issue_date, n.currency_code,
                                   n.fx_rate::text AS fx_rate, n.reason_code, n.reason,
                                   n.customer_name_snapshot, n.customer_address_snapshot,
                                   n.customer_tax_number_snapshot, n.notes,
                                   n.subtotal_cents, n.tax_cents, n.total_cents,
                                   n.base_subtotal_cents, n.base_tax_cents, n.base_total_cents,
                                   n.journal_entry_id, n.void_journal_entry_id, n.issued_at, n.voided_at,
                                   n.created_by, u.name AS created_by_name, n.created_at, n.updated_at
                              FROM credit_notes n
                              JOIN customers c  ON c.id = n.customer_id AND c.org_id = n.org_id
                              JOIN invoices inv ON inv.id = n.invoice_id AND inv.org_id = n.org_id
                              LEFT JOIN users u ON u.id = n.created_by`;

function toLine(row: CreditNoteLineRow): CreditNoteLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    quantityMilli: Number(row.quantity_milli),
    unitPriceCents: parseCents(row.unit_price_cents),
    revenueAccountId: row.revenue_account_id,
    revenueAccountCode: row.revenue_account_code,
    revenueAccountName: row.revenue_account_name,
    taxRateBp: row.tax_rate_bp,
    netCents: parseCents(row.net_cents),
    taxCents: parseCents(row.tax_cents),
  };
}

function toAllocation(row: AllocationRow): CreditNoteAllocation {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    amountCents: parseCents(row.amount_cents),
    baseAmountCents: parseCents(row.base_amount_cents),
    allocationDate: row.allocation_date,
    createdAt: row.created_at.toISOString(),
  };
}

function toCreditNote(
  row: CreditNoteRow,
  lines: CreditNoteLine[],
  allocations: CreditNoteAllocation[],
): CreditNote {
  if (!isNoteStatus(row.status)) {
    throw new Error(`Unknown credit note status "${row.status}" on credit note ${row.id}`);
  }
  if (!isNoteReasonCode(row.reason_code)) {
    throw new Error(`Unknown reason code "${row.reason_code}" on credit note ${row.id}`);
  }

  const totalCents = parseCents(row.total_cents);
  const isOpen = row.status === 'ISSUED';
  const appliedCents = isOpen ? sumCents(allocations.map((a) => cents(a.amountCents))) : 0;

  return {
    id: row.id,
    creditNoteNumber: row.credit_note_number,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    issueDate: row.issue_date,
    currencyCode: row.currency_code.trim(),
    fxRate: row.fx_rate,
    reasonCode: row.reason_code,
    reason: row.reason,
    customerNameSnapshot: row.customer_name_snapshot,
    customerAddressSnapshot: row.customer_address_snapshot,
    customerTaxNumberSnapshot: row.customer_tax_number_snapshot,
    notes: row.notes,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    totalCents,
    baseSubtotalCents: parseCents(row.base_subtotal_cents),
    baseTaxCents: parseCents(row.base_tax_cents),
    baseTotalCents: parseCents(row.base_total_cents),
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines,
    allocations,
    appliedCents,
    unappliedCents: isOpen ? totalCents - appliedCents : 0,
  };
}

/** Lines and allocations for a set of notes — two queries per page, never one per note. */
async function loadChildren(
  orgId: string,
  noteIds: string[],
): Promise<{ lines: Map<string, CreditNoteLine[]>; allocations: Map<string, CreditNoteAllocation[]> }> {
  const lines = new Map<string, CreditNoteLine[]>();
  const allocations = new Map<string, CreditNoteAllocation[]>();
  if (noteIds.length === 0) return { lines, allocations };

  const { rows: lineRows } = await pool.query<CreditNoteLineRow>(
    `SELECT l.id, l.credit_note_id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.revenue_account_id, a.code AS revenue_account_code, a.name AS revenue_account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents
       FROM credit_note_lines l
       JOIN accounts a ON a.id = l.revenue_account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.credit_note_id = ANY($2::uuid[])
      ORDER BY l.line_number ASC`,
    [orgId, noteIds],
  );
  for (const row of lineRows) {
    const list = lines.get(row.credit_note_id) ?? [];
    list.push(toLine(row));
    lines.set(row.credit_note_id, list);
  }

  const { rows: allocationRows } = await pool.query<AllocationRow>(
    `SELECT a.id, a.credit_note_id, a.invoice_id, i.invoice_number, a.amount_cents, a.base_amount_cents,
            a.allocation_date, a.created_at
       FROM credit_note_allocations a
       JOIN invoices i ON i.id = a.invoice_id AND i.org_id = a.org_id
      WHERE a.org_id = $1
        AND a.credit_note_id = ANY($2::uuid[])
      ORDER BY a.allocation_date ASC, a.created_at ASC, a.id ASC`,
    [orgId, noteIds],
  );
  for (const row of allocationRows) {
    const list = allocations.get(row.credit_note_id) ?? [];
    list.push(toAllocation(row));
    allocations.set(row.credit_note_id, list);
  }

  return { lines, allocations };
}

// ---------------------------------------------------------------------- reads

export async function getCreditNoteById(orgId: string, id: string): Promise<CreditNote> {
  const { rows } = await pool.query<CreditNoteRow>(
    `${CREDIT_NOTE_SELECT} WHERE n.id = $1 AND n.org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Credit note not found');

  const { lines, allocations } = await loadChildren(orgId, [row.id]);
  return toCreditNote(row, lines.get(row.id) ?? [], allocations.get(row.id) ?? []);
}

/** One shared `WHERE` for the count and the page query, like invoiceService.buildFilters. */
function buildFilters(
  orgId: string,
  options: ListCreditNotesOptions,
): { where: string; values: unknown[] } {
  const clauses = ['n.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.status !== null) add((p) => `n.status = ${p}`, options.status);
  if (options.customerId !== null) add((p) => `n.customer_id = ${p}::uuid`, options.customerId);
  if (options.invoiceId !== null) add((p) => `n.invoice_id = ${p}::uuid`, options.invoiceId);
  if (options.from !== null) add((p) => `n.issue_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `n.issue_date <= ${p}::date`, options.to);

  return { where: clauses.join(' AND '), values };
}

export async function listCreditNotes(
  orgId: string,
  options: ListCreditNotesOptions,
): Promise<{ creditNotes: CreditNote[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM credit_notes n WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `n.id DESC` is the required tiebreaker so pages never swap rows.
  const { rows } = await pool.query<CreditNoteRow>(
    `${CREDIT_NOTE_SELECT}
      WHERE ${where}
      ORDER BY n.issue_date DESC, n.created_at DESC, n.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const { lines, allocations } = await loadChildren(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    creditNotes: rows.map((row) =>
      toCreditNote(row, lines.get(row.id) ?? [], allocations.get(row.id) ?? []),
    ),
    totalCount,
  };
}

// --------------------------------------------------------------------- writes

interface LineTotal {
  input: CreditNoteLineInput;
  netCents: number;
  taxCents: number;
}

/** Per-line tax, then summed — the same rounding discipline as invoices. */
function computeLineTotals(lines: CreditNoteLineInput[]): LineTotal[] {
  return lines.map((line) => {
    const netCents = scaleCents(cents(line.unitPriceCents), line.quantityMilli, 1000);
    const taxCents = scaleCents(netCents, line.taxRateBp, 10000);
    return { input: line, netCents, taxCents };
  });
}

function totalsOf(totals: LineTotal[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;
  if (totalCents <= 0) {
    throw new ApiError(422, 'A credit note total must be greater than zero');
  }
  return { subtotalCents, taxCents, totalCents };
}

interface LockedInvoice {
  id: string;
  status: string;
  customer_id: string;
  issue_date: string;
  currency_code: string;
  fx_rate: string;
  total_cents: string;
  customer_name_snapshot: string;
  customer_address_snapshot: string | null;
  customer_tax_number_snapshot: string | null;
}

async function lockInvoice(client: PoolClient, orgId: string, invoiceId: string): Promise<LockedInvoice> {
  const { rows } = await client.query<LockedInvoice>(
    `SELECT id, status, customer_id, issue_date, currency_code, fx_rate::text AS fx_rate, total_cents,
            customer_name_snapshot, customer_address_snapshot, customer_tax_number_snapshot
       FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [invoiceId, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, 'Invoice not found');
  return row;
}

async function baseCurrencyOf(client: PoolClient, orgId: string): Promise<string> {
  const { rows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = rows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  return baseCurrency;
}

/**
 * The two caps, checked with the invoice already locked FOR UPDATE:
 *   - every ISSUED credit note against this invoice, plus this one, may not
 *     exceed the invoice total (migration 063's deferred trigger is the
 *     database backstop);
 *   - a foreign-currency note may not exceed what is still due, so it is
 *     always fully applied to its own invoice and never leaves a remainder
 *     that would need cross-rate application.
 */
async function assertWithinCaps(
  client: PoolClient,
  orgId: string,
  invoice: LockedInvoice,
  totalCents: number,
  excludeNoteId: string | null,
): Promise<void> {
  const { rows } = await client.query<{ issued: string }>(
    `SELECT COALESCE(SUM(total_cents), 0)::text AS issued
       FROM credit_notes
      WHERE org_id = $1 AND invoice_id = $2 AND status = 'ISSUED'
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [orgId, invoice.id, excludeNoteId],
  );
  const invoiceTotal = parseCents(invoice.total_cents);
  if (parseCents(rows[0]?.issued ?? '0') + totalCents > invoiceTotal) {
    throw new ApiError(422, 'Credit notes against this invoice would exceed the invoice total');
  }

  const baseCurrency = await baseCurrencyOf(client, orgId);
  if (invoice.currency_code.trim() !== baseCurrency) {
    const settled = await settledCentsOnClient(client, orgId, 'invoice_id', invoice.id);
    const dueCents = invoiceTotal - settled.paidCents - settled.noteAppliedCents;
    if (totalCents > dueCents) {
      throw new ApiError(422, 'A foreign-currency credit note cannot exceed the amount still due on its invoice');
    }
  }
}

function assertCreditable(invoice: LockedInvoice, issueDate: string): void {
  if (invoice.status !== 'ISSUED') {
    throw new ApiError(422, 'Only an issued invoice can be credited');
  }
  if (issueDate < invoice.issue_date) {
    throw new ApiError(422, 'A credit note cannot be dated before its invoice');
  }
}

async function insertLines(
  client: PoolClient,
  orgId: string,
  noteId: string,
  totals: LineTotal[],
): Promise<void> {
  await client.query(
    `INSERT INTO credit_note_lines
       (org_id, credit_note_id, line_number, description, quantity_milli, unit_price_cents,
        revenue_account_id, tax_rate_bp, net_cents, tax_cents)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.revenue_account_id, v.tax_rate_bp, v.net_cents, v.tax_cents
       FROM unnest(
              $3::smallint[], $4::text[], $5::bigint[], $6::bigint[],
              $7::uuid[], $8::int[], $9::bigint[], $10::bigint[]
            ) AS v(line_number, description, quantity_milli, unit_price_cents,
                    revenue_account_id, tax_rate_bp, net_cents, tax_cents)`,
    [
      orgId,
      noteId,
      totals.map((_, i) => i + 1),
      totals.map((t) => t.input.description),
      totals.map((t) => t.input.quantityMilli),
      totals.map((t) => t.input.unitPriceCents),
      totals.map((t) => t.input.revenueAccountId),
      totals.map((t) => t.input.taxRateBp),
      totals.map((t) => t.netCents),
      totals.map((t) => t.taxCents),
    ],
  );
}

function mapWriteError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
    return new ApiError(422, 'A referenced account does not exist in this organization');
  }
  if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
    return new ApiError(422, pgErrorMessage(err));
  }
  return err;
}

export async function createCreditNote(
  orgId: string,
  createdBy: string,
  input: CreateCreditNoteInput,
): Promise<CreditNote> {
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = totalsOf(totals);

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const invoice = await lockInvoice(client, orgId, input.invoiceId);
    assertCreditable(invoice, input.issueDate);
    await invoiceService.assertRevenueAccounts(
      client,
      orgId,
      totals.map((t) => t.input.revenueAccountId),
    );
    await assertWithinCaps(client, orgId, invoice, totalCents, null);

    const fxRate = invoice.fx_rate;
    const baseSubtotalCents = convertToBase(cents(subtotalCents), fxRate);
    const baseTaxCents = convertToBase(cents(taxCents), fxRate);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO credit_notes
         (org_id, customer_id, invoice_id, reason_code, reason, issue_date, currency_code, fx_rate,
          customer_name_snapshot, customer_address_snapshot, customer_tax_number_snapshot, notes,
          subtotal_cents, tax_cents, total_cents, base_subtotal_cents, base_tax_cents, base_total_cents,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [
        orgId,
        invoice.customer_id,
        invoice.id,
        input.reasonCode,
        input.reason,
        input.issueDate,
        invoice.currency_code.trim(),
        fxRate,
        invoice.customer_name_snapshot,
        invoice.customer_address_snapshot,
        invoice.customer_tax_number_snapshot,
        input.notes,
        subtotalCents,
        taxCents,
        totalCents,
        baseSubtotalCents,
        baseTaxCents,
        baseSubtotalCents + baseTaxCents,
        createdBy,
      ],
    );
    const noteId = rows[0]?.id;
    if (noteId === undefined) throw new Error('INSERT ... RETURNING produced no row');

    await insertLines(client, orgId, noteId, totals);

    await client.query('COMMIT');
    return await getCreditNoteById(orgId, noteId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw mapWriteError(err);
  } finally {
    client.release();
  }
}

/** A draft edit replaces the whole document, like `updateInvoice`. */
export async function updateCreditNote(
  orgId: string,
  id: string,
  input: UpdateCreditNoteInput,
): Promise<CreditNote> {
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = totalsOf(totals);

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: noteRows } = await client.query<{ status: string; invoice_id: string }>(
      'SELECT status, invoice_id FROM credit_notes WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const note = noteRows[0];
    if (note === undefined) throw new ApiError(404, 'Credit note not found');
    if (note.status !== 'DRAFT') {
      throw new ApiError(409, 'Only a draft credit note can be edited');
    }
    if (note.invoice_id !== input.invoiceId) {
      throw new ApiError(422, 'A draft credit note cannot be moved to a different invoice');
    }

    const invoice = await lockInvoice(client, orgId, input.invoiceId);
    assertCreditable(invoice, input.issueDate);
    await invoiceService.assertRevenueAccounts(
      client,
      orgId,
      totals.map((t) => t.input.revenueAccountId),
    );
    await assertWithinCaps(client, orgId, invoice, totalCents, id);

    const baseSubtotalCents = convertToBase(cents(subtotalCents), invoice.fx_rate);
    const baseTaxCents = convertToBase(cents(taxCents), invoice.fx_rate);

    await client.query('DELETE FROM credit_note_lines WHERE credit_note_id = $1 AND org_id = $2', [
      id,
      orgId,
    ]);

    await client.query(
      `UPDATE credit_notes
          SET reason_code = $1, reason = $2, issue_date = $3, notes = $4,
              subtotal_cents = $5, tax_cents = $6, total_cents = $7,
              base_subtotal_cents = $8, base_tax_cents = $9, base_total_cents = $10
        WHERE id = $11 AND org_id = $12`,
      [
        input.reasonCode,
        input.reason,
        input.issueDate,
        input.notes,
        subtotalCents,
        taxCents,
        totalCents,
        baseSubtotalCents,
        baseTaxCents,
        baseSubtotalCents + baseTaxCents,
        id,
        orgId,
      ],
    );

    await insertLines(client, orgId, id, totals);

    await client.query('COMMIT');
    return await getCreditNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw mapWriteError(err);
  } finally {
    client.release();
  }
}

export async function deleteCreditNote(orgId: string, id: string): Promise<void> {
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM credit_notes WHERE id = $1 AND org_id = $2 AND status = 'DRAFT' RETURNING id`,
      [id, orgId],
    ),
  );

  if (rows[0] !== undefined) return;

  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM credit_notes WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Credit note not found');
  throw new ApiError(409, 'Only a draft credit note can be deleted');
}

// ------------------------------------------------------- issue, void, apply

interface LockedNoteRow {
  id: string;
  status: string;
  invoice_id: string;
  customer_id: string;
  issue_date: string;
  currency_code: string;
  fx_rate: string;
  customer_name_snapshot: string;
  total_cents: string;
  tax_cents: string;
  journal_entry_id: string | null;
}

type LockedNote = Omit<LockedNoteRow, 'status'> & { status: NoteStatus };

async function lockNote(client: PoolClient, orgId: string, id: string): Promise<LockedNote> {
  const { rows } = await client.query<LockedNoteRow>(
    `SELECT id, status, invoice_id, customer_id, issue_date, currency_code, fx_rate::text AS fx_rate,
            customer_name_snapshot, total_cents, tax_cents, journal_entry_id
       FROM credit_notes WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Credit note not found');
  if (!isNoteStatus(row.status)) {
    throw new Error(`Unknown credit note status "${row.status}" on credit note ${id}`);
  }
  return { ...row, status: row.status };
}

export async function issueCreditNote(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<CreditNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    const status = note.status;
    if (!canTransitionNote(status, 'ISSUED')) {
      throw new ApiError(409, `A credit note that is ${status} cannot be issued`);
    }

    const invoice = await lockInvoice(client, orgId, note.invoice_id);
    if (invoice.status !== 'ISSUED') {
      throw new ApiError(422, 'Only an issued invoice can be credited');
    }
    const totalCents = parseCents(note.total_cents);
    await assertWithinCaps(client, orgId, invoice, totalCents, id);

    const { rows: lineRows } = await client.query<{ revenue_account_id: string; net_cents: string }>(
      'SELECT revenue_account_id, net_cents FROM credit_note_lines WHERE credit_note_id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (lineRows.length === 0) {
      throw new ApiError(422, 'A credit note needs at least one line before it can be issued');
    }

    const taxTotalCents = parseCents(note.tax_cents);
    const currencyCode = note.currency_code.trim();
    const fxRate = note.fx_rate;

    const { receivableAccountId, taxAccountId } = await invoiceService.resolvePostingAccounts(
      client,
      orgId,
      taxTotalCents > 0,
    );

    // The mirror of issueInvoice: one debit per distinct revenue account (two
    // lines on the same account merge), a debit for the tax being given back,
    // and a single credit to the receivable for the full note total.
    const revenueByAccount = new Map<string, number>();
    for (const line of lineRows) {
      const net = parseCents(line.net_cents);
      revenueByAccount.set(
        line.revenue_account_id,
        (revenueByAccount.get(line.revenue_account_id) ?? 0) + net,
      );
    }

    const glLines = [...revenueByAccount.entries()].map(([accountId, netCents]) => ({
      accountId,
      debitCents: netCents,
      creditCents: 0,
      currencyCode,
      fxRate,
    }));
    if (taxAccountId !== null && taxTotalCents > 0) {
      glLines.push({ accountId: taxAccountId, debitCents: taxTotalCents, creditCents: 0, currencyCode, fxRate });
    }
    glLines.push({ accountId: receivableAccountId, debitCents: 0, creditCents: totalCents, currencyCode, fxRate });

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      // A bug, not user input — chk_credit_notes_total makes this impossible.
      throw new Error('Credit note posting is unbalanced');
    }

    const { rows: invoiceNumberRows } = await client.query<{ invoice_number: string | null }>(
      'SELECT invoice_number FROM invoices WHERE id = $1 AND org_id = $2',
      [invoice.id, orgId],
    );
    const invoiceNumber = invoiceNumberRows[0]?.invoice_number ?? invoice.id;

    const number = await invoiceSettingsService.allocateNoteNumber(client, orgId, 'CREDIT_NOTE');

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: entryDate ?? note.issue_date,
      description: `Credit note ${number} — ${note.customer_name_snapshot} (against ${invoiceNumber})`,
      sourceType: 'credit_note',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE credit_notes
          SET status = 'ISSUED', credit_note_number = $1, journal_entry_id = $2, issued_at = now()
        WHERE id = $3 AND org_id = $4`,
      [number, journalEntryId, id, orgId],
    );

    // Auto-apply to the original invoice, up to what it still owes. A fully
    // paid invoice takes nothing — the whole note stays as unapplied credit
    // on the customer's account.
    const settled = await settledCentsOnClient(client, orgId, 'invoice_id', invoice.id);
    const dueCents = parseCents(invoice.total_cents) - settled.paidCents - settled.noteAppliedCents;
    const applyCents = Math.min(totalCents, dueCents);
    if (applyCents > 0) {
      await client.query(
        `INSERT INTO credit_note_allocations
           (org_id, credit_note_id, invoice_id, amount_cents, base_amount_cents, allocation_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, id, invoice.id, applyCents, convertToBase(cents(applyCents), fxRate), note.issue_date, userId],
      );
    }

    // COMMIT runs the deferred cap and allocation-limit triggers.
    await client.query('COMMIT');
    return await getCreditNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_credit_notes_org_number') {
      throw new ApiError(409, 'Credit note number already exists — try again');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function voidCreditNote(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<CreditNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    const status = note.status;
    if (!canTransitionNote(status, 'VOID')) {
      throw new ApiError(409, 'This credit note has already been voided');
    }

    if (status === 'ISSUED') {
      if (note.journal_entry_id === null) {
        throw new Error(`Issued credit note ${id} has no journal_entry_id`);
      }
      const reversalId = await journalService.reverseEntryOnClient(
        client,
        orgId,
        userId,
        note.journal_entry_id,
        entryDate,
      );
      // Allocations are not touched — they are insert-only and stop counting
      // toward settlement the moment the note leaves ISSUED, which re-opens
      // every invoice the note was applied to.
      await client.query(
        `UPDATE credit_notes SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
          WHERE id = $2 AND org_id = $3`,
        [reversalId, id, orgId],
      );
    } else {
      // A draft posted nothing, so there is nothing to reverse.
      await client.query(
        `UPDATE credit_notes SET status = 'VOID', voided_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    }

    await client.query('COMMIT');
    return await getCreditNoteById(orgId, id);
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

/**
 * Applies unapplied credit to an open invoice of the same customer.
 *
 * Posts NO journal entry, on purpose: the note already credited Accounts
 * Receivable and the invoice already debited it, so both are sitting inside
 * the one AR control balance. Applying one to the other is subledger matching
 * — it changes which open items the customer's account shows, not the GL.
 */
export async function applyCreditNote(
  orgId: string,
  userId: string,
  id: string,
  input: ApplyCreditNoteInput,
): Promise<CreditNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    if (note.status !== 'ISSUED') {
      throw new ApiError(409, 'Only an issued credit note can be applied');
    }

    const baseCurrency = await baseCurrencyOf(client, orgId);
    const currencyCode = note.currency_code.trim();
    if (currencyCode !== baseCurrency && input.invoiceId !== note.invoice_id) {
      throw new ApiError(422, 'A foreign-currency credit note can only be applied to its original invoice');
    }

    const invoice = await lockInvoice(client, orgId, input.invoiceId);
    if (invoice.customer_id !== note.customer_id) {
      throw new ApiError(422, 'That invoice belongs to a different customer');
    }
    if (invoice.status !== 'ISSUED') {
      throw new ApiError(422, 'Only an issued invoice can have credit applied');
    }
    if (invoice.currency_code.trim() !== currencyCode) {
      throw new ApiError(422, 'A credit note can only be applied to an invoice in the same currency');
    }
    if (input.allocationDate < note.issue_date || input.allocationDate < invoice.issue_date) {
      throw new ApiError(422, 'A credit cannot be applied before the credit note or the invoice is dated');
    }

    const { rows: appliedRows } = await client.query<{ applied: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS applied
         FROM credit_note_allocations WHERE org_id = $1 AND credit_note_id = $2`,
      [orgId, id],
    );
    const unappliedCents = parseCents(note.total_cents) - parseCents(appliedRows[0]?.applied ?? '0');
    if (input.amountCents > unappliedCents) {
      throw new ApiError(422, 'Amount exceeds the credit still available on this credit note');
    }

    const settled = await settledCentsOnClient(client, orgId, 'invoice_id', invoice.id);
    const dueCents = parseCents(invoice.total_cents) - settled.paidCents - settled.noteAppliedCents;
    if (input.amountCents > dueCents) {
      throw new ApiError(422, 'Amount exceeds the amount still due on this invoice');
    }

    await client.query(
      `INSERT INTO credit_note_allocations
         (org_id, credit_note_id, invoice_id, amount_cents, base_amount_cents, allocation_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        id,
        invoice.id,
        input.amountCents,
        convertToBase(cents(input.amountCents), note.fx_rate),
        input.allocationDate,
        userId,
      ],
    );

    await client.query('COMMIT');
    return await getCreditNoteById(orgId, id);
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
