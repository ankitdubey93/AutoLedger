import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, scaleCents } from '../../utils/money.js';
import {
  DEPOSIT_APPLICATION_TRANSITIONS,
  type DepositApplication,
  type DepositApplicationStatus,
  type QuoteDirection,
} from '../../types/accounting.js';
import * as billService from './billService.js';
import * as invoiceService from './invoiceService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as journalService from './journalService.js';
import {
  depositApplicationSelect,
  listDepositApplicationsForDocument,
  toDepositApplication,
  type DepositApplicationRow,
} from './depositApplicationQueries.js';
import { resolveApPostingAccountsOnClient, orgTodayOnClient } from './settingsService.js';
import { settledCentsOnClient } from './settlementSql.js';
import type { ApplyDepositBody, CreateDepositBody } from '../../schemas/accounting/depositSchema.js';

/**
 * Phase 42 (Slice G) — deposits and prepayments against an order.
 *
 * A deposit DOCUMENT is an ordinary invoice (`kind = 'DEPOSIT'`: DR AR / CR
 * 2130 Customer Deposits, an IFRS 15 contract liability) or bill (DR 1150
 * Supplier Prepayments / CR AP), raised on a CONFIRMED order. A deposit
 * APPLICATION later moves what has actually been paid onto the order's final
 * invoice/bill: DR 2130 / CR AR (sales), DR AP / CR 1150 (purchase). An
 * application is the third settlement source (`settlementSql.ts`).
 *
 * Base currency only. Corrections are a void (reversal) of the application,
 * never an edit (rule 6).
 */

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function pgErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Identifiers only ever come from this constant map (rule 4). */
const DOC = {
  SALES: {
    table: 'invoices',
    partyColumn: 'customer_id',
    dateColumn: 'issue_date',
    numberColumn: 'invoice_number',
    openStatus: 'ISSUED',
    allocationColumn: 'invoice_id',
    lineTable: 'invoice_lines',
    lineFk: 'invoice_id',
    noun: 'invoice',
    partyNoun: 'customer',
    depositNoun: 'deposit',
    openNoun: 'issued invoice',
  },
  PURCHASE: {
    table: 'bills',
    partyColumn: 'vendor_id',
    dateColumn: 'bill_date',
    numberColumn: 'vendor_reference',
    openStatus: 'POSTED',
    allocationColumn: 'bill_id',
    lineTable: 'bill_lines',
    lineFk: 'bill_id',
    noun: 'bill',
    partyNoun: 'vendor',
    depositNoun: 'prepayment',
    openNoun: 'approved bill',
  },
} as const;

function formatCents(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
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

// -------------------------------------------------------------------- accounts

export interface DepositAccounts {
  /** 2130 (SALES, a Liability) or 1150 (PURCHASE, an Asset). */
  depositAccountId: string;
}

/**
 * The deposit account for a direction: the invoice setting if set, else the
 * default chart's `2130` (SALES) / `1150` (PURCHASE). Fails with a readable 422
 * rather than posting to the wrong kind of account.
 */
export async function resolveDepositAccountsOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
): Promise<DepositAccounts> {
  const settings = await invoiceSettingsService.getInvoiceSettings(orgId);
  const configured = direction === 'SALES' ? settings.customerDepositAccountId : settings.supplierPrepaymentAccountId;
  const fallbackCode = direction === 'SALES' ? '2130' : '1150';
  const expectedType = direction === 'SALES' ? 'Liability' : 'Asset';

  const { rows } = await client.query<{ id: string; code: string; type: string; is_postable: boolean }>(
    configured === null
      ? 'SELECT id, code, type, is_postable FROM accounts WHERE org_id = $1 AND code = $2'
      : 'SELECT id, code, type, is_postable FROM accounts WHERE org_id = $1 AND id = $2',
    [orgId, configured ?? fallbackCode],
  );
  const account = rows[0];
  if (account === undefined) {
    throw new ApiError(
      422,
      direction === 'SALES'
        ? 'No customer deposit account is configured. Set one in invoice settings.'
        : 'No supplier prepayment account is configured. Set one in invoice settings.',
    );
  }
  if (account.type !== expectedType) {
    throw new ApiError(422, `Account ${account.code} must be ${expectedType === 'Asset' ? 'an Asset' : 'a Liability'} account`);
  }
  if (!account.is_postable) {
    throw new ApiError(422, `Account ${account.code} is a header account and cannot be posted to`);
  }
  return { depositAccountId: account.id };
}

// ------------------------------------------------------- creating the document

interface LockedOrder {
  id: string;
  status: string;
  partyId: string;
  orderNumber: string | null;
  currencyCode: string;
  totalCents: number;
}

async function lockOrderOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  orderId: string,
): Promise<LockedOrder> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    customer_id: string | null;
    vendor_id: string | null;
    order_number: string | null;
    currency_code: string;
    total_cents: string;
  }>(
    `SELECT id, status, customer_id, vendor_id, order_number, currency_code, total_cents
       FROM orders WHERE id = $1 AND org_id = $2 AND direction = $3
      FOR UPDATE`,
    [orderId, orgId, direction],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Order not found');
  return {
    id: row.id,
    status: row.status,
    partyId: row.customer_id ?? row.vendor_id ?? '',
    orderNumber: row.order_number,
    currencyCode: row.currency_code.trim(),
    totalCents: parseCents(row.total_cents),
  };
}

/**
 * Raises a DRAFT deposit invoice/bill on a CONFIRMED order, on the caller's
 * own transaction (rule 5): the route wraps it (`createDepositDocument`), and
 * quote → order conversion calls it directly so both commit together.
 */
export async function createDepositDocumentOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  orderId: string,
  input: Pick<CreateDepositBody, 'percentBp' | 'amountCents' | 'documentDate' | 'dueDate' | 'vendorReference'>,
): Promise<{ kind: 'INVOICE' | 'BILL'; id: string }> {
  const d = DOC[direction];
  const order = await lockOrderOnClient(client, orgId, direction, orderId);
  if (order.status !== 'CONFIRMED') throw new ApiError(409, 'Only a confirmed order can take a deposit');
  if (order.currencyCode !== (await baseCurrencyOf(client, orgId))) {
    throw new ApiError(422, 'Deposits are available on base-currency orders only');
  }
  if (order.orderNumber === null) throw new Error(`Confirmed order ${orderId} has no number`);

  let amountCents: number;
  if (input.amountCents !== null) {
    amountCents = input.amountCents;
  } else if (input.percentBp !== null) {
    amountCents = scaleCents(cents(order.totalCents), input.percentBp, 10_000);
  } else {
    throw new ApiError(422, 'Give a percentage or an amount');
  }
  if (amountCents < 1) throw new ApiError(422, 'The deposit amount rounds to zero');

  const { rows: existingRows } = await client.query<{ total: string; n: string }>(
    `SELECT COALESCE(SUM(total_cents) FILTER (WHERE status <> 'VOID'), 0)::text AS total,
            count(*)::text AS n
       FROM ${d.table}
      WHERE org_id = $1 AND deposit_for_order_id = $2`,
    [orgId, orderId],
  );
  const existingCents = parseCents(existingRows[0]?.total ?? '0');
  if (amountCents + existingCents > order.totalCents) {
    throw new ApiError(422, 'Deposits on this order would exceed its total');
  }

  const { depositAccountId } = await resolveDepositAccountsOnClient(client, orgId, direction);
  const documentDate = input.documentDate ?? (await orgTodayOnClient(client, orgId));
  // A deposit is requested up front: due on the document date unless told otherwise.
  const dueDate = input.dueDate ?? documentDate;

  if (direction === 'SALES') {
    const id = await invoiceService.createInvoiceOnClient(
      client,
      orgId,
      userId,
      {
        customerId: order.partyId,
        issueDate: documentDate,
        dueDate,
        currencyCode: order.currencyCode,
        notes: null,
        paymentTerms: null,
        paymentTermsCode: null,
        lines: [
          {
            description: `Deposit on ${order.orderNumber}`,
            quantityMilli: 1000,
            unitPriceCents: amountCents,
            revenueAccountId: depositAccountId,
            taxRateBp: 0,
            itemId: null,
            stockLocationId: null,
            orderLineId: null,
          },
        ],
      },
      { depositForOrderId: orderId },
    );
    return { kind: 'INVOICE', id };
  }

  const vendorReference =
    input.vendorReference ?? `${order.orderNumber}-DEP-${String(Number(existingRows[0]?.n ?? '0') + 1)}`;
  const id = await billService.createBillOnClient(
    client,
    orgId,
    userId,
    {
      vendorId: order.partyId,
      vendorReference,
      billDate: documentDate,
      dueDate,
      currencyCode: order.currencyCode,
      notes: null,
      paymentTerms: null,
      paymentTermsCode: null,
      lines: [
        {
          description: `Prepayment on ${order.orderNumber}`,
          quantityMilli: 1000,
          unitPriceCents: amountCents,
          expenseAccountId: depositAccountId,
          taxRateBp: 0,
          itemId: null,
          stockLocationId: null,
          orderLineId: null,
        },
      ],
    },
    { depositForOrderId: orderId },
  );
  return { kind: 'BILL', id };
}

export async function createDepositDocument(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  orderId: string,
  input: CreateDepositBody,
): Promise<{ kind: 'INVOICE' | 'BILL'; id: string }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const result = await createDepositDocumentOnClient(client, orgId, userId, direction, orderId, input);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'That vendor reference is already used for this vendor');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------- applying

interface LockedDocument {
  id: string;
  status: string;
  kind: string;
  depositForOrderId: string | null;
  partyId: string;
  currencyCode: string;
  documentDate: string;
  number: string | null;
  totalCents: number;
}

/**
 * Locks the deposit and the target FOR UPDATE in ONE statement ordered by id,
 * so two concurrent applications naming the same pair (in either role) can
 * never deadlock. Returns them by id; a missing row is the caller's 404.
 */
async function lockDocumentsOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  ids: string[],
): Promise<Map<string, LockedDocument>> {
  const d = DOC[direction];
  const { rows } = await client.query<{
    id: string;
    status: string;
    kind: string;
    deposit_for_order_id: string | null;
    party_id: string;
    currency_code: string;
    document_date: string;
    number: string | null;
    total_cents: string;
  }>(
    `SELECT id, status, kind, deposit_for_order_id, ${d.partyColumn} AS party_id, currency_code,
            ${d.dateColumn}::text AS document_date, ${d.numberColumn} AS number, total_cents
       FROM ${d.table}
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, ids],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        status: r.status,
        kind: r.kind,
        depositForOrderId: r.deposit_for_order_id,
        partyId: r.party_id,
        currencyCode: r.currency_code.trim(),
        documentDate: r.document_date,
        number: r.number,
        totalCents: parseCents(r.total_cents),
      },
    ]),
  );
}

export async function applyDeposit(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  targetId: string,
  input: ApplyDepositBody,
): Promise<DepositApplication> {
  const d = DOC[direction];
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    if (input.depositDocumentId === targetId) {
      throw new ApiError(422, `A ${d.noun} cannot take its own ${d.depositNoun}`);
    }
    const docs = await lockDocumentsOnClient(client, orgId, direction, [targetId, input.depositDocumentId]);
    const target = docs.get(targetId);
    if (target === undefined) throw new ApiError(404, direction === 'SALES' ? 'Invoice not found' : 'Bill not found');
    const deposit = docs.get(input.depositDocumentId);
    if (deposit === undefined) {
      throw new ApiError(404, direction === 'SALES' ? 'Deposit invoice not found' : 'Prepayment bill not found');
    }

    if (target.kind !== 'STANDARD' || target.status !== d.openStatus) {
      throw new ApiError(409, `Only an ${d.openNoun} can take a ${d.depositNoun}`);
    }
    if (deposit.kind !== 'DEPOSIT') {
      throw new ApiError(422, `That ${d.noun} is not a ${d.depositNoun}`);
    }
    if (deposit.status !== d.openStatus) {
      throw new ApiError(409, `Only an ${d.openNoun} can be applied`);
    }
    if (deposit.partyId !== target.partyId) {
      throw new ApiError(422, `That ${d.depositNoun} belongs to a different ${d.partyNoun}`);
    }
    if (deposit.currencyCode !== target.currencyCode) {
      throw new ApiError(422, `A ${d.depositNoun} can only be applied to a ${d.noun} in the same currency`);
    }
    if (target.currencyCode !== (await baseCurrencyOf(client, orgId))) {
      throw new ApiError(422, 'Deposits are available on base-currency documents only');
    }
    if (deposit.depositForOrderId === null) throw new Error(`Deposit ${deposit.id} has no order`);

    const { rows: linkedRows } = await client.query<{ linked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${d.lineTable} l
           JOIN order_lines ol ON ol.org_id = l.org_id AND ol.id = l.order_line_id
          WHERE l.org_id = $1 AND l.${d.lineFk} = $2 AND ol.order_id = $3
       ) AS linked`,
      [orgId, target.id, deposit.depositForOrderId],
    );
    if (linkedRows[0]?.linked !== true) {
      throw new ApiError(422, `This ${d.depositNoun} belongs to a different order`);
    }

    if (input.applicationDate < deposit.documentDate || input.applicationDate < target.documentDate) {
      throw new ApiError(422, `A ${d.depositNoun} cannot be applied before either document is dated`);
    }

    // What has actually been RECEIVED: POSTED payment allocations only — a
    // credit note or another application does not fund a deposit.
    const depositSettled = await settledCentsOnClient(client, orgId, d.allocationColumn, deposit.id);
    const { rows: appliedRows } = await client.query<{ applied: string }>(
      direction === 'SALES'
        ? `SELECT COALESCE(SUM(amount_cents), 0)::text AS applied FROM deposit_applications
            WHERE org_id = $1 AND deposit_invoice_id = $2 AND status = 'POSTED'`
        : `SELECT COALESCE(SUM(amount_cents), 0)::text AS applied FROM deposit_applications
            WHERE org_id = $1 AND deposit_bill_id = $2 AND status = 'POSTED'`,
      [orgId, deposit.id],
    );
    const availableCents = depositSettled.paidCents - parseCents(appliedRows[0]?.applied ?? '0');
    if (input.amountCents > availableCents) {
      throw new ApiError(
        422,
        `Only ${formatCents(Math.max(availableCents, 0))} of this ${d.depositNoun} has been received and not yet applied`,
      );
    }

    const targetSettled = await settledCentsOnClient(client, orgId, d.allocationColumn, target.id);
    const dueCents =
      target.totalCents - targetSettled.paidCents - targetSettled.noteAppliedCents - targetSettled.depositAppliedCents;
    if (input.amountCents > dueCents) {
      throw new ApiError(422, 'Amount exceeds the amount still due');
    }

    const { depositAccountId } = await resolveDepositAccountsOnClient(client, orgId, direction);
    const applicationId = randomUUID();
    const description = `${direction === 'SALES' ? 'Deposit' : 'Prepayment'} ${deposit.number ?? deposit.id} applied to ${target.number ?? target.id}`;

    let lines: journalService.JournalLineInput[];
    if (direction === 'SALES') {
      const { receivableAccountId } = await invoiceService.resolvePostingAccounts(client, orgId, false);
      lines = [
        { accountId: depositAccountId, debitCents: input.amountCents, creditCents: 0 },
        { accountId: receivableAccountId, debitCents: 0, creditCents: input.amountCents },
      ];
    } else {
      const { payableAccountId } = await resolveApPostingAccountsOnClient(client, orgId, false);
      lines = [
        { accountId: payableAccountId, debitCents: input.amountCents, creditCents: 0 },
        { accountId: depositAccountId, debitCents: 0, creditCents: input.amountCents },
      ];
    }

    // createEntryOnClient runs the fiscal-period guard, as it does for credit notes.
    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: input.applicationDate,
      description,
      sourceType: 'deposit_application',
      sourceId: applicationId,
      lines,
    });

    await client.query(
      `INSERT INTO deposit_applications
         (id, org_id, direction, deposit_invoice_id, target_invoice_id, deposit_bill_id, target_bill_id,
          amount_cents, base_amount_cents, application_date, journal_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
      [
        applicationId,
        orgId,
        direction,
        direction === 'SALES' ? deposit.id : null,
        direction === 'SALES' ? target.id : null,
        direction === 'PURCHASE' ? deposit.id : null,
        direction === 'PURCHASE' ? target.id : null,
        input.amountCents,
        input.applicationDate,
        journalEntryId,
        userId,
      ],
    );

    const application = await getApplicationOnClient(client, orgId, direction, applicationId);
    await client.query('COMMIT');
    return application;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
    throw err;
  } finally {
    client.release();
  }
}

async function getApplicationOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  id: string,
): Promise<DepositApplication> {
  const { rows } = await client.query<DepositApplicationRow>(
    `${depositApplicationSelect(direction)} WHERE da.org_id = $1 AND da.direction = $2 AND da.id = $3`,
    [orgId, direction, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Deposit application not found');
  return toDepositApplication(row);
}

function canTransitionApplication(from: DepositApplicationStatus, to: DepositApplicationStatus): boolean {
  return (DEPOSIT_APPLICATION_TRANSITIONS[from] as readonly DepositApplicationStatus[]).includes(to);
}

/**
 * Voids a POSTED application: a reversing journal entry and the POSTED -> VOID
 * transition. The reversal copies the original entry's `source_type`
 * (journalService.reverseEntryOnClient takes none), and the party ledger
 * attributes it through `void_journal_entry_id`, not through its source type.
 * The target's amount due rises again for free — the application stops
 * counting toward settlement the moment it leaves POSTED.
 */
export async function voidDepositApplication(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
  entryDate: string | null,
): Promise<DepositApplication> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows } = await client.query<{ status: string; journal_entry_id: string }>(
      'SELECT status, journal_entry_id FROM deposit_applications WHERE id = $1 AND org_id = $2 AND direction = $3 FOR UPDATE',
      [id, orgId, direction],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Deposit application not found');
    if (row.status !== 'POSTED' && row.status !== 'VOID') {
      throw new Error(`Unknown deposit application status "${row.status}" on ${id}`);
    }
    if (!canTransitionApplication(row.status, 'VOID')) {
      throw new ApiError(409, 'This deposit application has already been voided');
    }

    const reversalId = await journalService.reverseEntryOnClient(client, orgId, userId, row.journal_entry_id, entryDate);
    await client.query(
      `UPDATE deposit_applications SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
        WHERE id = $2 AND org_id = $3`,
      [reversalId, id, orgId],
    );

    const application = await getApplicationOnClient(client, orgId, direction, id);
    await client.query('COMMIT');
    return application;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
    throw err;
  } finally {
    client.release();
  }
}

/** Applications where the document is the deposit or the target (both directions; ids are unique across tables). */
export async function listDepositApplications(
  orgId: string,
  filter: { documentId: string },
): Promise<DepositApplication[]> {
  const [sales, purchase] = await Promise.all([
    listDepositApplicationsForDocument(pool, orgId, 'SALES', filter.documentId),
    listDepositApplicationsForDocument(pool, orgId, 'PURCHASE', filter.documentId),
  ]);
  return [...sales, ...purchase];
}
