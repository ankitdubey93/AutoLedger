import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { buildAbaFile, normalizeAccountNumber, normalizeBsb, type AbaCredit } from '../../utils/abaFile.js';
import { decryptSecret, encryptSecret } from '../../utils/secretBox.js';
import * as historyService from '../historyService.js';
import { createPaymentOnClient } from './paymentService.js';

/**
 * Phase 49g — paying suppliers by ABA file. Creating a batch records the
 * payments in the ledger on one transaction. The file only tells the bank:
 * uploading it is the user's step, in their own bank, under their own controls.
 */

function encryptionKey(): string {
  if (env.INTEGRATION_ENCRYPTION_KEY === '') {
    throw new ApiError(503, 'Bank details cannot be stored until INTEGRATION_ENCRYPTION_KEY is configured');
  }
  return env.INTEGRATION_ENCRYPTION_KEY;
}

function requireBsb(value: string): string {
  const bsb = normalizeBsb(value);
  if (bsb === null) throw new ApiError(422, 'A BSB is six digits');
  return bsb;
}

function requireAccountNumber(value: string): string {
  const number = normalizeAccountNumber(value);
  if (number === null) throw new ApiError(422, 'An account number is up to nine digits');
  return number;
}

function lastThree(number: string): string {
  return number.slice(-3);
}

export interface BankAccountDetails {
  accountId: string;
  bsb: string;
  accountNumberLast3: string;
  accountName: string;
  financialInstitution: string;
  apcaUserId: string;
  selfBalancing: boolean;
}

export async function getBankAccountDetails(orgId: string, accountId: string): Promise<BankAccountDetails | null> {
  const { rows } = await pool.query<{
    account_id: string;
    bsb: string;
    account_number_last3: string;
    account_name: string;
    financial_institution: string;
    apca_user_id: string;
    self_balancing: boolean;
  }>(
    `SELECT account_id, bsb, account_number_last3, account_name, financial_institution, apca_user_id, self_balancing
       FROM bank_account_details WHERE org_id = $1 AND account_id = $2`,
    [orgId, accountId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    accountId: r.account_id,
    bsb: r.bsb,
    accountNumberLast3: r.account_number_last3,
    accountName: r.account_name,
    financialInstitution: r.financial_institution,
    apcaUserId: r.apca_user_id,
    selfBalancing: r.self_balancing,
  };
}

export async function saveBankAccountDetails(
  orgId: string,
  accountId: string,
  input: { bsb: string; accountNumber: string; accountName: string; financialInstitution: string; apcaUserId: string; selfBalancing: boolean },
): Promise<BankAccountDetails> {
  const bsb = requireBsb(input.bsb);
  const number = requireAccountNumber(input.accountNumber);
  const key = encryptionKey();
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM accounts WHERE org_id = $1 AND id = $2 AND bank_account_kind = 'BANK' AND is_active`,
      [orgId, accountId],
    );
    if (rows.length === 0) throw new ApiError(404, 'Bank account not found');
    await client.query(
      `INSERT INTO bank_account_details
         (org_id, account_id, bsb, account_number_enc, account_number_last3, account_name, financial_institution, apca_user_id, self_balancing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id) DO UPDATE SET
         bsb = EXCLUDED.bsb,
         account_number_enc = EXCLUDED.account_number_enc,
         account_number_last3 = EXCLUDED.account_number_last3,
         account_name = EXCLUDED.account_name,
         financial_institution = EXCLUDED.financial_institution,
         apca_user_id = EXCLUDED.apca_user_id,
         self_balancing = EXCLUDED.self_balancing`,
      [orgId, accountId, bsb, encryptSecret(number, key), lastThree(number), input.accountName, input.financialInstitution, input.apcaUserId, input.selfBalancing],
    );
  });
  const saved = await getBankAccountDetails(orgId, accountId);
  if (saved === null) throw new Error('Bank account details vanished after saving');
  return saved;
}

export interface VendorBankDetails {
  vendorId: string;
  bsb: string;
  accountNumberLast3: string;
  accountName: string;
  changedAt: string;
}

export async function listVendorBankDetails(orgId: string): Promise<VendorBankDetails[]> {
  const { rows } = await pool.query<{ vendor_id: string; bsb: string; account_number_last3: string; account_name: string; changed_at: Date }>(
    'SELECT vendor_id, bsb, account_number_last3, account_name, changed_at FROM vendor_bank_details WHERE org_id = $1',
    [orgId],
  );
  return rows.map((r) => ({
    vendorId: r.vendor_id,
    bsb: r.bsb,
    accountNumberLast3: r.account_number_last3,
    accountName: r.account_name,
    changedAt: r.changed_at.toISOString(),
  }));
}

export async function saveVendorBankDetails(
  orgId: string,
  userId: string,
  vendorId: string,
  input: { bsb: string; accountNumber: string; accountName: string },
): Promise<VendorBankDetails> {
  const bsb = requireBsb(input.bsb);
  const number = requireAccountNumber(input.accountNumber);
  const key = encryptionKey();
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM vendors WHERE org_id = $1 AND id = $2 AND is_active', [orgId, vendorId]);
    if (rows.length === 0) throw new ApiError(404, 'Vendor not found');
    await client.query(
      `INSERT INTO vendor_bank_details (org_id, vendor_id, bsb, account_number_enc, account_number_last3, account_name, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (vendor_id) DO UPDATE SET
         bsb = EXCLUDED.bsb,
         account_number_enc = EXCLUDED.account_number_enc,
         account_number_last3 = EXCLUDED.account_number_last3,
         account_name = EXCLUDED.account_name,
         changed_by = EXCLUDED.changed_by,
         changed_at = now()`,
      [orgId, vendorId, bsb, encryptSecret(number, key), lastThree(number), input.accountName, userId],
    );
    await historyService.recordEventOnClient(client, orgId, {
      entityType: 'VENDOR',
      entityId: vendorId,
      action: 'UPDATED',
      summary: `Bank details changed to BSB ${bsb}, account ending ${lastThree(number)}`,
    });
  });
  const saved = (await listVendorBankDetails(orgId)).find((d) => d.vendorId === vendorId);
  if (saved === undefined) throw new Error('Vendor bank details vanished after saving');
  return saved;
}

export interface PaymentBatchSummary {
  id: string;
  bankAccountId: string;
  paymentDate: string;
  description: string;
  totalCents: number;
  paymentCount: number;
  createdAt: string;
}

const BATCH_SELECT = `
  SELECT b.id, b.bank_account_id, to_char(b.payment_date, 'YYYY-MM-DD') AS payment_date, b.description,
         b.total_cents::text AS total_cents, b.created_at,
         (SELECT count(*) FROM payment_batch_items i WHERE i.org_id = b.org_id AND i.batch_id = b.id)::int AS payment_count
    FROM payment_batches b`;

interface BatchRow {
  id: string;
  bank_account_id: string;
  payment_date: string;
  description: string;
  total_cents: string;
  created_at: Date;
  payment_count: number;
}

function toBatch(r: BatchRow): PaymentBatchSummary {
  return {
    id: r.id,
    bankAccountId: r.bank_account_id,
    paymentDate: r.payment_date,
    description: r.description,
    totalCents: Number(r.total_cents),
    paymentCount: r.payment_count,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listPaymentBatches(orgId: string): Promise<PaymentBatchSummary[]> {
  const { rows } = await pool.query<BatchRow>(`${BATCH_SELECT} WHERE b.org_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [orgId]);
  return rows.map(toBatch);
}

const PG_RAISE_EXCEPTION = 'P0001';

/** One payment per vendor, all or nothing, each going through the ordinary payment path. */
export async function createPaymentBatch(
  orgId: string,
  userId: string,
  input: { bankAccountId: string; paymentDate: string; description: string; items: { billId: string; amountCents: number }[] },
): Promise<PaymentBatchSummary> {
  const billIds = input.items.map((i) => i.billId);
  if (new Set(billIds).size !== billIds.length) throw new ApiError(422, 'An expense appears twice in this pay run');

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: bank } = await client.query(
      'SELECT 1 FROM bank_account_details WHERE org_id = $1 AND account_id = $2',
      [orgId, input.bankAccountId],
    );
    if (bank.length === 0) throw new ApiError(422, 'Add the BSB and account details for this bank account first');

    const { rows: bills } = await client.query<{ id: string; vendor_id: string; vendor_reference: string; currency_code: string; status: string; vendor_name: string }>(
      `SELECT b.id, b.vendor_id, b.vendor_reference, b.currency_code, b.status, v.name AS vendor_name
         FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
        WHERE b.org_id = $1 AND b.id = ANY($2::uuid[])`,
      [orgId, billIds],
    );
    if (bills.length !== billIds.length) throw new ApiError(404, 'An expense in this pay run was not found');
    const notPayable = bills.find((b) => b.status !== 'POSTED');
    if (notPayable !== undefined) throw new ApiError(422, `${notPayable.vendor_reference} is not an approved expense`);
    // An ABA file moves Australian dollars between Australian accounts.
    const foreign = bills.find((b) => b.currency_code.trim() !== 'AUD');
    if (foreign !== undefined) throw new ApiError(422, `${foreign.vendor_reference} is not in AUD, so it can't go in an ABA file`);

    const { rows: details } = await client.query<{ vendor_id: string }>(
      'SELECT vendor_id FROM vendor_bank_details WHERE org_id = $1 AND vendor_id = ANY($2::uuid[])',
      [orgId, [...new Set(bills.map((b) => b.vendor_id))]],
    );
    const hasDetails = new Set(details.map((d) => d.vendor_id));
    const missing = [...new Set(bills.filter((b) => !hasDetails.has(b.vendor_id)).map((b) => b.vendor_name))];
    if (missing.length > 0) throw new ApiError(422, `Add bank details for: ${missing.join(', ')}`);

    const byVendor = new Map<string, { billId: string; amountCents: number; reference: string }[]>();
    for (const item of input.items) {
      const bill = bills.find((b) => b.id === item.billId);
      if (bill === undefined) continue;
      const group = byVendor.get(bill.vendor_id) ?? [];
      group.push({ ...item, reference: bill.vendor_reference });
      byVendor.set(bill.vendor_id, group);
    }

    const { rows: batchRows } = await client.query<{ id: string }>(
      `INSERT INTO payment_batches (org_id, bank_account_id, payment_date, description, total_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, input.bankAccountId, input.paymentDate, input.description, input.items.reduce((s, i) => s + i.amountCents, 0), userId],
    );
    const batchId = batchRows[0]?.id ?? '';

    for (const [vendorId, group] of byVendor) {
      const paymentId = await createPaymentOnClient(client, orgId, userId, {
        direction: 'PAY',
        paymentDate: input.paymentDate,
        amountCents: group.reduce((s, g) => s + g.amountCents, 0),
        cashAccountId: input.bankAccountId,
        customerId: null,
        vendorId,
        method: 'ABA',
        reference: group.map((g) => g.reference).join(', ').slice(0, 100),
        notes: null,
        allocations: group.map((g) => ({ invoiceId: null, billId: g.billId, amountCents: g.amountCents })),
        entryDate: null,
      });
      await client.query(
        'INSERT INTO payment_batch_items (org_id, batch_id, payment_id, vendor_id) VALUES ($1, $2, $3, $4)',
        [orgId, batchId, paymentId, vendorId],
      );
    }

    await client.query('COMMIT');
    const { rows } = await pool.query<BatchRow>(`${BATCH_SELECT} WHERE b.org_id = $1 AND b.id = $2`, [orgId, batchId]);
    const row = rows[0];
    if (row === undefined) throw new Error('Payment batch vanished after commit');
    return toBatch(row);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_RAISE_EXCEPTION && 'message' in err) {
      throw new ApiError(422, String(err.message));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Built when asked, so a voided payment drops out of a re-download. */
export async function buildBatchAbaFile(orgId: string, batchId: string): Promise<{ filename: string; content: string }> {
  const { rows: batches } = await pool.query<{
    payment_date: string;
    description: string;
    bsb: string | null;
    account_number_enc: string | null;
    account_name: string | null;
    financial_institution: string | null;
    apca_user_id: string | null;
    self_balancing: boolean | null;
    org_name: string;
  }>(
    `SELECT to_char(b.payment_date, 'YYYY-MM-DD') AS payment_date, b.description,
            d.bsb, d.account_number_enc, d.account_name, d.financial_institution, d.apca_user_id, d.self_balancing,
            o.name AS org_name
       FROM payment_batches b
       JOIN organizations o ON o.id = b.org_id
       LEFT JOIN bank_account_details d ON d.account_id = b.bank_account_id AND d.org_id = b.org_id
      WHERE b.org_id = $1 AND b.id = $2`,
    [orgId, batchId],
  );
  const batch = batches[0];
  if (batch === undefined) throw new ApiError(404, 'Pay run not found');
  if (batch.bsb === null || batch.account_number_enc === null) throw new ApiError(422, 'This bank account has no BSB and account details');
  const key = encryptionKey();

  const { rows: items } = await pool.query<{
    amount_cents: string;
    reference: string | null;
    bsb: string;
    account_number_enc: string;
    account_name: string;
  }>(
    `SELECT p.amount_cents::text AS amount_cents, p.reference, v.bsb, v.account_number_enc, v.account_name
       FROM payment_batch_items i
       JOIN payments p ON p.id = i.payment_id AND p.org_id = i.org_id
       JOIN vendor_bank_details v ON v.vendor_id = i.vendor_id AND v.org_id = i.org_id
      WHERE i.org_id = $1 AND i.batch_id = $2 AND p.void_journal_entry_id IS NULL
      ORDER BY p.created_at, p.id`,
    [orgId, batchId],
  );
  if (items.length === 0) throw new ApiError(409, 'Every payment in this pay run has been voided');

  const credits: AbaCredit[] = items.map((item) => ({
    bsb: item.bsb,
    accountNumber: decryptSecret(item.account_number_enc, key),
    accountName: item.account_name,
    amountCents: Number(item.amount_cents),
    lodgementReference: item.reference ?? batch.description,
  }));

  const content = buildAbaFile(
    {
      financialInstitution: batch.financial_institution ?? '',
      userName: batch.account_name ?? batch.org_name,
      apcaUserId: batch.apca_user_id ?? '',
      description: batch.description,
      processingDate: batch.payment_date,
      traceBsb: batch.bsb,
      traceAccountNumber: decryptSecret(batch.account_number_enc, key),
      remitterName: batch.org_name,
      selfBalancing: batch.self_balancing ?? false,
    },
    credits,
  );
  return { filename: `pay-run-${batch.payment_date}.aba`, content };
}
