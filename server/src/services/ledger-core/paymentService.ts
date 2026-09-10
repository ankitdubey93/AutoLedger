import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents, type Cents } from '../../utils/money.js';
import { convertToBase, ONE_RATE } from '../../utils/fxRate.js';
import { emitEvent } from '../outboxService.js';
import * as journalService from './journalService.js';
import * as fxRateService from './fxRateService.js';
import {
  canTransitionPayment,
  isPaymentStatus,
  type Payment,
  type PaymentAllocation,
  type PaymentDirection,
  type PaymentStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore payments — settlement of invoices (RECEIVE) and bills (PAY).
 *
 * A payment is born POSTED: there is no draft, and correction is
 * `voidPayment`, which posts a reversal, mirroring `journal_entries` itself
 * (guardrails rule 6). This file never writes `journal_entries` or
 * `ledger_lines` directly — every GL posting goes through `journalService`'s
 * `*OnClient` functions on this service's own checked-out transaction client
 * (guardrails rules 5 and 16).
 *
 * Settlement state is never stored — `allocatedCentsSubquery` below is the
 * one place "how much of a document is paid" is defined, consumed by
 * `invoiceService` and `billService`'s own SELECTs.
 */

/**
 * Sums POSTED allocations against one document. A correlated scalar
 * subquery, not a JOIN + GROUP BY: the outer query (invoiceService's
 * INVOICE_SELECT, billService's BILL_SELECT) already groups by the document
 * row, and a join would fan it out.
 *
 * `p.status = 'POSTED'` is what makes voiding a payment un-settle its
 * documents for free — the allocation rows stay, immutably, and stop
 * counting. Removing this predicate silently makes voided payments settle
 * invoices.
 *
 * `alias` and `column` are compile-time constants supplied by our own code
 * (accountService/billService's SELECT builders), never request input — that
 * is what keeps guardrails rule 4 satisfied despite the string interpolation.
 */
/**
 * `amountColumn` defaults to the native amount, matching every pre-Phase-8
 * call site exactly. `agingService` passes 'base_amount_cents' explicitly to
 * reconcile against a base-currency GL control balance. Both values are a
 * closed union — never request input — so the interpolation stays within
 * guardrails rule 4's identifier-whitelisting allowance.
 */
export function allocatedCentsSubquery(
  alias: string,
  column: 'invoice_id' | 'bill_id',
  amountColumn: 'amount_cents' | 'base_amount_cents' = 'amount_cents',
): string {
  return `COALESCE((SELECT SUM(pa.${amountColumn})
                      FROM payment_allocations pa
                      JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
                     WHERE pa.org_id = ${alias}.org_id
                       AND pa.${column} = ${alias}.id
                       AND p.status = 'POSTED'), 0)::text`;
}

const PG_RAISE_EXCEPTION = 'P0001';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the payment';
  }
  return 'Database rejected the payment';
}

export interface AllocationInput {
  invoiceId: string | null;
  billId: string | null;
  amountCents: number;
}

export interface CreatePaymentInput {
  direction: PaymentDirection;
  paymentDate: string;
  amountCents: number;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string | undefined;
  cashAccountId: string;
  customerId: string | null;
  vendorId: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  allocations: AllocationInput[];
  entryDate: string | null;
}

export interface ListPaymentsOptions {
  page: number;
  limit: number;
  direction: PaymentDirection | null;
  status: PaymentStatus | null;
  customerId: string | null;
  vendorId: string | null;
  from: string | null;
  to: string | null;
}

// ---------------------------------------------------------------- row mapping

interface PaymentRow {
  id: string;
  direction: string;
  status: string;
  payment_date: string;
  currency_code: string;
  amount_cents: string;
  fx_rate: string;
  base_amount_cents: string;
  cash_account_id: string;
  cash_account_code: string;
  cash_account_name: string;
  customer_id: string | null;
  vendor_id: string | null;
  counterparty_name: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  journal_entry_id: string;
  void_journal_entry_id: string | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AllocationRow {
  id: string;
  payment_id: string;
  invoice_id: string | null;
  bill_id: string | null;
  document_reference: string;
  document_total_cents: string;
  amount_cents: string;
  base_amount_cents: string;
}

const PAYMENT_SELECT = `SELECT p.id, p.direction, p.status, p.payment_date, p.currency_code, p.amount_cents,
                                p.fx_rate::text AS fx_rate, p.base_amount_cents,
                                p.cash_account_id, a.code AS cash_account_code, a.name AS cash_account_name,
                                p.customer_id, p.vendor_id,
                                COALESCE(c.name, v.name) AS counterparty_name,
                                p.method, p.reference, p.notes,
                                p.journal_entry_id, p.void_journal_entry_id, p.voided_at,
                                p.created_by, u.name AS created_by_name, p.created_at, p.updated_at
                           FROM payments p
                           JOIN accounts a ON a.id = p.cash_account_id AND a.org_id = p.org_id
                           LEFT JOIN customers c ON c.id = p.customer_id AND c.org_id = p.org_id
                           LEFT JOIN vendors v ON v.id = p.vendor_id AND v.org_id = p.org_id
                           LEFT JOIN users u ON u.id = p.created_by`;

function toAllocation(row: AllocationRow): PaymentAllocation {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    billId: row.bill_id,
    documentReference: row.document_reference,
    documentTotalCents: parseCents(row.document_total_cents),
    amountCents: parseCents(row.amount_cents),
    baseAmountCents: parseCents(row.base_amount_cents),
  };
}

function toPayment(row: PaymentRow, allocations: PaymentAllocation[]): Payment {
  const direction = row.direction;
  if (direction !== 'RECEIVE' && direction !== 'PAY') {
    throw new Error(`Unknown payment direction "${direction}" on payment ${row.id}`);
  }
  if (!isPaymentStatus(row.status)) {
    throw new Error(`Unknown payment status "${row.status}" on payment ${row.id}`);
  }

  return {
    id: row.id,
    direction,
    status: row.status,
    paymentDate: row.payment_date,
    currencyCode: row.currency_code.trim(),
    amountCents: parseCents(row.amount_cents),
    fxRate: row.fx_rate,
    baseAmountCents: parseCents(row.base_amount_cents),
    cashAccountId: row.cash_account_id,
    cashAccountCode: row.cash_account_code,
    cashAccountName: row.cash_account_name,
    customerId: row.customer_id,
    vendorId: row.vendor_id,
    counterpartyName: row.counterparty_name,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    allocations,
  };
}

/** Loads the allocations for a set of payments in one query — never one query per payment. */
async function loadAllocations(
  orgId: string,
  paymentIds: string[],
): Promise<Map<string, PaymentAllocation[]>> {
  const byPayment = new Map<string, PaymentAllocation[]>();
  if (paymentIds.length === 0) return byPayment;

  const { rows } = await pool.query<AllocationRow>(
    `SELECT pa.id, pa.payment_id, pa.invoice_id, pa.bill_id, pa.amount_cents, pa.base_amount_cents,
            COALESCE(i.invoice_number, i.id::text, b.vendor_reference) AS document_reference,
            COALESCE(i.total_cents, b.total_cents) AS document_total_cents
       FROM payment_allocations pa
       LEFT JOIN invoices i ON i.id = pa.invoice_id AND i.org_id = pa.org_id
       LEFT JOIN bills b ON b.id = pa.bill_id AND b.org_id = pa.org_id
      WHERE pa.org_id = $1
        AND pa.payment_id = ANY($2::uuid[])
      ORDER BY pa.created_at ASC`,
    [orgId, paymentIds],
  );

  for (const row of rows) {
    const list = byPayment.get(row.payment_id) ?? [];
    list.push(toAllocation(row));
    byPayment.set(row.payment_id, list);
  }
  return byPayment;
}

// ---------------------------------------------------------------------- reads

export async function getPaymentById(orgId: string, id: string): Promise<Payment> {
  const { rows } = await pool.query<PaymentRow>(
    `${PAYMENT_SELECT} WHERE p.id = $1 AND p.org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Payment not found');

  const allocations = await loadAllocations(orgId, [row.id]);
  return toPayment(row, allocations.get(row.id) ?? []);
}

function buildFilters(
  orgId: string,
  options: ListPaymentsOptions,
): { where: string; values: unknown[] } {
  const clauses = ['p.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.direction !== null) add((p) => `p.direction = ${p}`, options.direction);
  if (options.status !== null) add((p) => `p.status = ${p}`, options.status);
  if (options.customerId !== null) add((p) => `p.customer_id = ${p}::uuid`, options.customerId);
  if (options.vendorId !== null) add((p) => `p.vendor_id = ${p}::uuid`, options.vendorId);
  if (options.from !== null) add((p) => `p.payment_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `p.payment_date <= ${p}::date`, options.to);

  return { where: clauses.join(' AND '), values };
}

export async function listPayments(
  orgId: string,
  options: ListPaymentsOptions,
): Promise<{ payments: Payment[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM payments p WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `p.id DESC` is a required tiebreaker: two payments sharing a payment_date
  // and created_at could otherwise swap between pages.
  const { rows } = await pool.query<PaymentRow>(
    `${PAYMENT_SELECT}
      WHERE ${where}
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const allocations = await loadAllocations(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    payments: rows.map((row) => toPayment(row, allocations.get(row.id) ?? [])),
    totalCount,
  };
}

// --------------------------------------------------------------------- writes

interface TargetDocument {
  id: string;
  totalCents: number;
  allocatedCents: number;
  counterpartyId: string;
  /** Phase 8. The document's own currency and its rate frozen at issue/approve. */
  currencyCode: string;
  fxRate: string;
}

/**
 * Locks and validates every targeted invoice or bill, in a deterministic
 * `ORDER BY id` — the lock ordering is what prevents a deadlock between two
 * concurrent payments touching the same two documents.
 */
async function lockAndValidateTargets(
  client: PoolClient,
  orgId: string,
  direction: PaymentDirection,
  expectedCounterpartyId: string,
  expectedCurrency: string,
  allocations: AllocationInput[],
): Promise<Map<string, TargetDocument>> {
  const targets = new Map<string, TargetDocument>();

  const invoiceIds = allocations
    .map((a) => a.invoiceId)
    .filter((id): id is string => id !== null)
    .sort();
  const billIds = allocations
    .map((a) => a.billId)
    .filter((id): id is string => id !== null)
    .sort();

  if (direction === 'RECEIVE' && billIds.length > 0) {
    throw new ApiError(422, 'A RECEIVE payment cannot allocate to a bill');
  }
  if (direction === 'PAY' && invoiceIds.length > 0) {
    throw new ApiError(422, 'A PAY payment cannot allocate to an invoice');
  }

  for (const invoiceId of invoiceIds) {
    const { rows } = await client.query<{
      id: string;
      status: string;
      total_cents: string;
      customer_id: string;
      currency_code: string;
      fx_rate: string;
    }>(
      `SELECT id, status, total_cents, customer_id, currency_code, fx_rate::text AS fx_rate
         FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [invoiceId, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(422, 'Invoice not found');
    if (row.customer_id !== expectedCounterpartyId) {
      throw new ApiError(422, 'That document belongs to a different counterparty');
    }
    if (row.status !== 'ISSUED') {
      throw new ApiError(422, 'Only an issued invoice can be paid');
    }
    const documentCurrency = row.currency_code.trim();
    if (documentCurrency !== expectedCurrency) {
      throw new ApiError(422, `A ${expectedCurrency} payment cannot settle a document in ${documentCurrency}`);
    }
    const { rows: allocatedRows } = await client.query<{ allocated: string }>(
      `SELECT COALESCE(SUM(pa.amount_cents), 0)::text AS allocated
         FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
        WHERE pa.org_id = $1 AND pa.invoice_id = $2 AND p.status = 'POSTED'`,
      [orgId, invoiceId],
    );
    targets.set(invoiceId, {
      id: invoiceId,
      totalCents: parseCents(row.total_cents),
      allocatedCents: parseCents(allocatedRows[0]?.allocated ?? '0'),
      counterpartyId: row.customer_id,
      currencyCode: documentCurrency,
      fxRate: row.fx_rate,
    });
  }

  for (const billId of billIds) {
    const { rows } = await client.query<{
      id: string;
      status: string;
      total_cents: string;
      vendor_id: string;
      currency_code: string;
      fx_rate: string;
    }>(
      `SELECT id, status, total_cents, vendor_id, currency_code, fx_rate::text AS fx_rate
         FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [billId, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(422, 'Bill not found');
    if (row.vendor_id !== expectedCounterpartyId) {
      throw new ApiError(422, 'That document belongs to a different counterparty');
    }
    if (row.status !== 'POSTED') {
      throw new ApiError(422, 'Only an approved bill can be paid');
    }
    const documentCurrency = row.currency_code.trim();
    if (documentCurrency !== expectedCurrency) {
      throw new ApiError(422, `A ${expectedCurrency} payment cannot settle a document in ${documentCurrency}`);
    }
    const { rows: allocatedRows } = await client.query<{ allocated: string }>(
      `SELECT COALESCE(SUM(pa.amount_cents), 0)::text AS allocated
         FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
        WHERE pa.org_id = $1 AND pa.bill_id = $2 AND p.status = 'POSTED'`,
      [orgId, billId],
    );
    targets.set(billId, {
      id: billId,
      totalCents: parseCents(row.total_cents),
      allocatedCents: parseCents(allocatedRows[0]?.allocated ?? '0'),
      counterpartyId: row.vendor_id,
      currencyCode: documentCurrency,
      fxRate: row.fx_rate,
    });
  }

  for (const allocation of allocations) {
    const targetId = allocation.invoiceId ?? allocation.billId;
    if (targetId === null) continue; // unreachable — schema guarantees exactly one
    const target = targets.get(targetId);
    if (target === undefined) continue;
    if (target.allocatedCents + allocation.amountCents > target.totalCents) {
      throw new ApiError(422, 'Allocation exceeds the amount still due on this document');
    }
  }

  return targets;
}

export interface ControlAccount {
  id: string;
}

/**
 * Resolves the control account a payment posts against: the receivable
 * account for a RECEIVE (settling AR), the payable account for a PAY
 * (settling AP) — the same fallbacks `invoiceService`/`billService` use.
 * Exported so `fxRevaluationService` can post against the same control
 * accounts without duplicating this lookup (Phase 8).
 */
export async function resolveControlAccount(
  client: PoolClient,
  orgId: string,
  direction: PaymentDirection,
): Promise<ControlAccount> {
  async function fallbackAccountId(code: string): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [orgId, code],
    );
    return rows[0]?.id ?? null;
  }

  if (direction === 'RECEIVE') {
    const { rows } = await client.query<{ receivable_account_id: string | null }>(
      'SELECT receivable_account_id FROM ledger_invoice_settings WHERE org_id = $1',
      [orgId],
    );
    const id = rows[0]?.receivable_account_id ?? (await fallbackAccountId('1120'));
    if (id === null) {
      throw new ApiError(422, 'No receivable account is configured. Set one in invoice settings.');
    }
    return { id };
  }

  const { rows } = await client.query<{ payable_account_id: string | null }>(
    'SELECT payable_account_id FROM ledger_settings WHERE org_id = $1',
    [orgId],
  );
  const id = rows[0]?.payable_account_id ?? (await fallbackAccountId('2100'));
  if (id === null) {
    throw new ApiError(422, 'No payable account is configured. Set one in settings.');
  }
  return { id };
}

/**
 * Resolves the realized-FX account for a gain or a loss: the configured
 * `ledger_settings` column, falling back to chart code 4910 (gain, Revenue)
 * or 6810 (loss, Expense) — seeded for every organization since Phase 3
 * precisely so this phase would need no chart backfill. Resolved lazily, only
 * when a settlement actually realizes a gain or loss, so an organization that
 * removed 4910/6810 can still take base-currency payments without error.
 */
async function resolveFxAccount(client: PoolClient, orgId: string, kind: 'gain' | 'loss'): Promise<string> {
  const column = kind === 'gain' ? 'realized_fx_gain_account_id' : 'realized_fx_loss_account_id';
  const fallbackCode = kind === 'gain' ? '4910' : '6810';

  const { rows } = await client.query<{ account_id: string | null }>(
    `SELECT ${column} AS account_id FROM ledger_settings WHERE org_id = $1`,
    [orgId],
  );
  const configuredId = rows[0]?.account_id ?? null;
  if (configuredId !== null) return configuredId;

  const { rows: fallbackRows } = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, fallbackCode],
  );
  const fallbackId = fallbackRows[0]?.id;
  if (fallbackId === undefined) {
    throw new ApiError(
      422,
      `No realized FX ${kind} account is configured. Set one in settings.`,
    );
  }
  return fallbackId;
}

/**
 * Creates a payment on the caller's transaction. Returns the new payment's
 * id. Does not COMMIT — the caller's COMMIT is where both deferred
 * constraint triggers fire (allocations-complete and no-overallocation).
 * Mirrors journalService.createEntryOnClient's split: the *OnClient
 * function does the work, the public function owns the transaction.
 */
export async function createPaymentOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: CreatePaymentInput,
): Promise<string> {
  const allocatedTotal = sumCents(input.allocations.map((a) => cents(a.amountCents)));
  if (allocatedTotal !== input.amountCents) {
    throw new ApiError(422, 'Allocations must sum to the payment amount');
  }

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const currencyCode = input.currencyCode ?? baseCurrency;

  // Resolved once, up front — every foreign-currency line and the payment
  // row itself use this same settlement-date rate.
  const paymentRate =
    currencyCode === baseCurrency
      ? ONE_RATE
      : (await fxRateService.requireRateOnClient(client, orgId, currencyCode, baseCurrency, input.paymentDate)).rate;

  const { rows: cashRows } = await client.query<{
    id: string;
    code: string;
    is_postable: boolean;
    type: string;
  }>('SELECT id, code, is_postable, type FROM accounts WHERE id = $1 AND org_id = $2', [
    input.cashAccountId,
    orgId,
  ]);
  const cashAccount = cashRows[0];
  if (cashAccount === undefined) throw new ApiError(422, 'Cash account not found');
  if (!cashAccount.is_postable) {
    throw new ApiError(422, `Account ${cashAccount.code} is a header account and cannot be posted to`);
  }
  if (cashAccount.type !== 'Asset') {
    throw new ApiError(422, `Account ${cashAccount.code} is not an Asset account`);
  }

  let counterpartyId: string;
  let counterpartyName: string;
  if (input.direction === 'RECEIVE') {
    if (input.customerId === null) throw new ApiError(422, 'Customer not found');
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM customers WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.customerId, orgId],
    );
    const customer = rows[0];
    if (customer === undefined) throw new ApiError(422, 'Customer not found');
    counterpartyId = input.customerId;
    counterpartyName = customer.name;
  } else {
    if (input.vendorId === null) throw new ApiError(422, 'Vendor not found');
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM vendors WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.vendorId, orgId],
    );
    const vendor = rows[0];
    if (vendor === undefined) throw new ApiError(422, 'Vendor not found');
    counterpartyId = input.vendorId;
    counterpartyName = vendor.name;
  }

  const targets = await lockAndValidateTargets(
    client,
    orgId,
    input.direction,
    counterpartyId,
    currencyCode,
    input.allocations,
  );

  const controlAccount = await resolveControlAccount(client, orgId, input.direction);

  let glLines: {
    accountId: string;
    debitCents: number;
    creditCents: number;
    currencyCode?: string;
    fxRate?: string;
  }[];
  // Signed — positive is a realized gain, negative a realized loss, 0 for a
  // base-currency payment or a settlement at the document's own rate.
  // Captured before the plug line (if any) is appended to glLines below, so
  // it reflects the imbalance the plug was built to close, not the
  // now-balanced total after it exists.
  let realizedFxCents = 0;

  if (currencyCode === baseCurrency) {
    // Unchanged from Phase 3.9: exactly two lines, cash + control, each for
    // the full amountCents at base currency / ONE_RATE. Do not restructure
    // this branch — every pre-Phase-8 payment test pins this exact shape.
    glLines =
      input.direction === 'RECEIVE'
        ? [
            { accountId: input.cashAccountId, debitCents: input.amountCents, creditCents: 0 },
            { accountId: controlAccount.id, debitCents: 0, creditCents: input.amountCents },
          ]
        : [
            { accountId: controlAccount.id, debitCents: input.amountCents, creditCents: 0 },
            { accountId: input.cashAccountId, debitCents: 0, creditCents: input.amountCents },
          ];
  } else {
    // Cash line: native paymentCurrency at the settlement-date paymentRate.
    const cashLine =
      input.direction === 'RECEIVE'
        ? { accountId: input.cashAccountId, debitCents: input.amountCents, creditCents: 0, currencyCode, fxRate: paymentRate }
        : { accountId: input.cashAccountId, debitCents: 0, creditCents: input.amountCents, currencyCode, fxRate: paymentRate };

    // One control line PER ALLOCATION — native = that allocation's amount,
    // rate = that DOCUMENT's own frozen fx_rate, not the payment's rate. This
    // is what keeps every line individually satisfying
    // chk_ledger_lines_base_matches_rate while the per-allocation base
    // amounts still carry the document's original carrying value — the gap
    // between that and the cash line's settlement-rate value is the realized
    // gain or loss, captured by the plug below.
    const controlLines = input.allocations.map((allocation) => {
      const targetId = allocation.invoiceId ?? allocation.billId;
      const target = targetId === null ? undefined : targets.get(targetId);
      if (target === undefined) throw new Error('Allocation target missing after validation');
      return input.direction === 'RECEIVE'
        ? { accountId: controlAccount.id, debitCents: 0, creditCents: allocation.amountCents, currencyCode, fxRate: target.fxRate }
        : { accountId: controlAccount.id, debitCents: allocation.amountCents, creditCents: 0, currencyCode, fxRate: target.fxRate };
    });

    glLines = [cashLine, ...controlLines];

    const baseDebitTotal = sumCents(
      glLines.map((l) => convertToBase(cents(l.debitCents), l.fxRate ?? ONE_RATE)),
    );
    const baseCreditTotal = sumCents(
      glLines.map((l) => convertToBase(cents(l.creditCents), l.fxRate ?? ONE_RATE)),
    );
    // More base value came in (or went out) than the documents were carried
    // at: imbalance > 0 is a gain (credit 4910); imbalance < 0 is a loss
    // (debit 6810). A receivable settled at a higher rate than it was booked
    // is a gain; a payable settled at a higher rate is a loss — the sign
    // falls out of this one subtraction with no direction-specific branch,
    // because the RECEIVE/PAY asymmetry is already baked into how the cash
    // and control lines above were built.
    const imbalance = baseDebitTotal - baseCreditTotal;
    realizedFxCents = imbalance;
    if (imbalance > 0) {
      const gainAccountId = await resolveFxAccount(client, orgId, 'gain');
      glLines.push({ accountId: gainAccountId, debitCents: 0, creditCents: imbalance, currencyCode: baseCurrency, fxRate: ONE_RATE });
    } else if (imbalance < 0) {
      const lossAccountId = await resolveFxAccount(client, orgId, 'loss');
      glLines.push({ accountId: lossAccountId, debitCents: -imbalance, creditCents: 0, currencyCode: baseCurrency, fxRate: ONE_RATE });
    }
  }

  // The payment id is needed before the journal entry (as sourceId) and
  // the journal entry id is needed before the payment row (journal_entry_id
  // is NOT NULL) — generating the id up front breaks that cycle. It is used
  // for both the entry's sourceId and this row's own primary key.
  const { rows: idRows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const paymentId = idRows[0]?.id;
  if (paymentId === undefined) throw new Error('gen_random_uuid() produced no row');

  const journalEntryId = await journalService.createEntryOnClient(client, orgId, createdBy, {
    entryDate: input.entryDate ?? input.paymentDate,
    description: `${input.direction === 'RECEIVE' ? 'Receipt' : 'Payment'} — ${counterpartyName}`,
    sourceType: 'payment',
    sourceId: paymentId,
    lines: glLines,
  });

  const baseAmountCents = convertToBase(cents(input.amountCents), paymentRate);

  await client.query(
    `INSERT INTO payments
       (id, org_id, direction, payment_date, currency_code, amount_cents, fx_rate, base_amount_cents,
        cash_account_id, customer_id, vendor_id, method, reference, notes, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      paymentId,
      orgId,
      input.direction,
      input.paymentDate,
      currencyCode,
      input.amountCents,
      paymentRate,
      baseAmountCents,
      input.cashAccountId,
      input.direction === 'RECEIVE' ? counterpartyId : null,
      input.direction === 'PAY' ? counterpartyId : null,
      input.method,
      input.reference,
      input.notes,
      journalEntryId,
      createdBy,
    ],
  );

  const allocationBaseCents: Cents[] = input.allocations.map((allocation) => {
    const targetId = allocation.invoiceId ?? allocation.billId;
    const target = targetId === null ? undefined : targets.get(targetId);
    if (target === undefined) throw new Error('Allocation target missing after validation');
    return convertToBase(cents(allocation.amountCents), target.fxRate);
  });

  await client.query(
    `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, bill_id, amount_cents, base_amount_cents)
     SELECT $1, $2, v.invoice_id, v.bill_id, v.amount_cents, v.base_amount_cents
       FROM unnest($3::uuid[], $4::uuid[], $5::bigint[], $6::bigint[])
            AS v(invoice_id, bill_id, amount_cents, base_amount_cents)`,
    [
      orgId,
      paymentId,
      input.allocations.map((a) => a.invoiceId),
      input.allocations.map((a) => a.billId),
      input.allocations.map((a) => a.amountCents),
      allocationBaseCents,
    ],
  );

  // Placed here, in the OnClient half, not in createPayment: a payment
  // created by a bank match (Phase 6 calls this half directly) must emit
  // the same event as one created through POST /payments.
  await emitEvent(client, orgId, 'ledger-core', 'payment.recorded', {
    paymentId,
    direction: input.direction,
    paymentDate: input.paymentDate,
    currencyCode,
    amountCents: input.amountCents,
    fxRate: paymentRate,
    baseAmountCents,
    realizedFxCents,
    customerId: input.direction === 'RECEIVE' ? counterpartyId : null,
    vendorId: input.direction === 'PAY' ? counterpartyId : null,
    cashAccountId: input.cashAccountId,
    reference: input.reference,
    allocationCount: input.allocations.length,
    journalEntryId,
  });

  return paymentId;
}

export async function createPayment(
  orgId: string,
  createdBy: string,
  input: CreatePaymentInput,
): Promise<Payment> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const paymentId = await createPaymentOnClient(client, orgId, createdBy, input);
    // COMMIT is where both deferred constraint triggers run — the payment's
    // allocations-complete check and the no-overallocation check.
    await client.query('COMMIT');
    return await getPaymentById(orgId, paymentId);
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
 * Voids a payment on the caller's transaction, posting the reversal. Throws
 * ApiError(409, 'This payment has already been voided') if it is not
 * POSTED. Does not COMMIT.
 */
export async function voidPaymentOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<void> {
  const { rows } = await client.query<{ id: string; status: string; journal_entry_id: string }>(
    'SELECT id, status, journal_entry_id FROM payments WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Payment not found');
  if (!isPaymentStatus(row.status)) {
    throw new Error(`Unknown payment status "${row.status}" on payment ${id}`);
  }
  if (!canTransitionPayment(row.status, 'VOID')) {
    throw new ApiError(409, 'This payment has already been voided');
  }

  const reversalId = await journalService.reverseEntryOnClient(
    client,
    orgId,
    userId,
    row.journal_entry_id,
    entryDate,
  );

  // Allocations are not touched — they are immutable (trg_allocations_immutable)
  // and stop counting toward settlement because every settlement query
  // filters p.status = 'POSTED'. This is what un-settles the payment's
  // documents for free.
  await client.query(
    `UPDATE payments SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
      WHERE id = $2 AND org_id = $3`,
    [reversalId, id, orgId],
  );
}

export async function voidPayment(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Payment> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await voidPaymentOnClient(client, orgId, userId, id, entryDate);
    await client.query('COMMIT');
    return await getPaymentById(orgId, id);
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
