import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, allocateCents, parseCents, sumCents } from '../../utils/money.js';
import { CAPTURE_DEFAULT_DUE_DAYS } from '../../config/constants.js';
import * as billService from '../accounting/billService.js';
import * as vendorService from '../accounting/vendorService.js';
import * as mappingService from './mappingService.js';
import * as captureDocumentService from './captureDocumentService.js';
import { canTransitionCaptureDocument } from '../../types/capture.js';
import type { CaptureDocumentDetail, CaptureDocumentStatus } from '../../types/capture.js';
import { MODULE_TAGS } from '../../config/modules.js';

/**
 * Capture's one-click post into Accounting (Phase 11, rewritten in Phase 19
 * to post as a real bill rather than a raw journal entry) — the app
 * boundary in practice. This file writes no GL entry row, no GL line row,
 * no bill row and no vendor row directly, and queries none of Accounting's
 * chart, settings, vendor, bill, or exchange-rate tables directly — every
 * Accounting fact it needs arrives through an exported Accounting service
 * function on this file's own checked-out transaction client (guardrails
 * rules 5 and 16).
 *
 * Posting through a bill (`billService.createCapturedBillOnClient` +
 * `approveBillOnClient`) rather than a raw `journalService.createEntryOnClient`
 * call is the fix for a real bug Phase 11 left behind: a raw journal entry
 * moved the AP control account with no subledger document behind it, so
 * `agingService.apAging`'s reconciliation against the ledger went false the
 * moment Capture posted anything, and the payable could never be paid
 * through /payments. A bill is a real subledger document, so both are
 * fixed by construction.
 *
 * Everything below runs in one transaction: the FSM lock and check, the
 * refusal checks, the vendor find-or-create, the tax allocation, the bill
 * creation and approval, freezing this document's own row, and the
 * vendor-history upsert all commit together or not at all. There is
 * deliberately no work after COMMIT.
 */

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';

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
    return typeof err.message === 'string' ? err.message : 'Database rejected the posting';
  }
  return 'Database rejected the posting';
}

/** UTC date-only arithmetic — avoids local-timezone day drift around midnight. */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface DocumentForPostingRow {
  id: string;
  document_id: string;
  status: CaptureDocumentStatus;
  sha256: string;
  original_filename: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal_cents: string | null;
  tax_cents: string | null;
  total_cents: string | null;
  arithmetic_ok: boolean | null;
}

interface LineItemForPostingRow {
  line_index: number;
  description: string;
  amount_cents: string;
  account_id: string | null;
}

export async function postCaptureDocument(
  orgId: string,
  userId: string,
  id: string,
  options?: { autoPosted?: boolean },
): Promise<CaptureDocumentDetail> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: docRows } = await client.query<DocumentForPostingRow>(
      `SELECT a.id, a.document_id, a.status, d.sha256, d.original_filename,
              x.vendor_name, x.invoice_number, x.invoice_date, x.due_date, x.currency,
              x.subtotal_cents, x.tax_cents, x.total_cents, x.arithmetic_ok
         FROM ap_flow_documents a
         JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id
         LEFT JOIN ap_flow_extractions x ON x.org_id = a.org_id AND x.ap_flow_document_id = a.id
        WHERE a.org_id = $1 AND a.id = $2
        FOR UPDATE OF a`,
      [orgId, id],
    );
    const doc = docRows[0];
    if (doc === undefined) throw new ApiError(404, 'Captured document not found');

    if (!canTransitionCaptureDocument(doc.status, 'POSTED')) {
      throw new ApiError(409, `Cannot post a document in status ${doc.status}`);
    }

    if (doc.arithmetic_ok === null) {
      throw new ApiError(422, 'This document has no extraction to post');
    }
    if (!doc.arithmetic_ok) {
      throw new ApiError(422, 'Extraction totals do not reconcile — re-extract before posting');
    }
    if (doc.invoice_date === null) {
      throw new ApiError(422, 'This document needs an invoice date before it can be posted');
    }
    const totalCents = doc.total_cents === null ? null : parseCents(doc.total_cents);
    if (totalCents === null || totalCents <= 0) {
      throw new ApiError(422, 'This document needs a positive total before it can be posted');
    }
    if (doc.vendor_name === null || doc.vendor_name.trim() === '') {
      throw new ApiError(422, 'This document needs a vendor name before it can be posted');
    }
    if (doc.invoice_number === null || doc.invoice_number.trim() === '') {
      throw new ApiError(422, 'This document needs an invoice number before it can be posted');
    }
    const taxCents = doc.tax_cents === null ? 0 : parseCents(doc.tax_cents);

    const { rows: lineItemRows } = await client.query<LineItemForPostingRow>(
      `SELECT line_index, description, amount_cents, account_id
         FROM ap_flow_line_items
        WHERE org_id = $1 AND ap_flow_document_id = $2
        ORDER BY line_index`,
      [orgId, id],
    );
    if (lineItemRows.length === 0) {
      throw new ApiError(422, 'This document needs at least one line item before it can be posted');
    }
    if (lineItemRows.some((row) => row.account_id === null)) {
      throw new ApiError(422, 'Every line item needs an account before this document can be posted');
    }
    if (lineItemRows.some((row) => parseCents(row.amount_cents) < 0)) {
      throw new ApiError(422, 'A line item with a negative amount cannot be posted as a bill');
    }

    const lineAmountSum = sumCents(lineItemRows.map((row) => parseCents(row.amount_cents)));
    if (lineAmountSum + taxCents !== totalCents) {
      throw new ApiError(422, 'Extracted line items and tax do not sum to the document total');
    }

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const documentCurrency = (doc.currency ?? baseCurrency).trim();

    const vendorId = await vendorService.findOrCreateVendorByNameOnClient(client, orgId, userId, doc.vendor_name);

    const lineTaxes: number[] =
      taxCents > 0
        ? allocateCents(
            cents(taxCents),
            lineItemRows.map((row) => cents(parseCents(row.amount_cents))),
          )
        : lineItemRows.map(() => 0);

    const dueDate =
      doc.due_date !== null && doc.due_date >= doc.invoice_date
        ? doc.due_date
        : addDays(doc.invoice_date, CAPTURE_DEFAULT_DUE_DAYS);

    let billId: string;
    try {
      billId = await billService.createCapturedBillOnClient(client, orgId, userId, {
        vendorId,
        vendorReference: doc.invoice_number.trim().slice(0, 100),
        billDate: doc.invoice_date,
        dueDate,
        currencyCode: documentCurrency,
        notes: `Captured from ${doc.original_filename}`.slice(0, 1000),
        lines: lineItemRows.map((row, index) => ({
          description: row.description.trim() === '' ? `Line ${String(row.line_index + 1)}` : row.description.slice(0, 500),
          netCents: parseCents(row.amount_cents),
          taxCents: lineTaxes[index] ?? 0,
          // account_id === null is refused above; the non-null assertion here
          // is safe by that check, not by TypeScript's own narrowing.
          expenseAccountId: row.account_id as string,
        })),
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_bills_vendor_reference') {
        throw new ApiError(409, 'A bill with this invoice number already exists for this vendor');
      }
      throw err;
    }

    const { journalEntryId } = await billService.approveBillOnClient(client, orgId, userId, billId, null);

    await client.query(
      `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
       VALUES ($1, $2, $5, 'bill', $3, $4)
       ON CONFLICT DO NOTHING`,
      [orgId, doc.document_id, billId, userId, MODULE_TAGS.accounting],
    );

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'POSTED', journal_entry_id = $3, bill_id = $4, posted_sha256 = $5,
              posted_at = now(), posted_by = $6, auto_posted = $7
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, journalEntryId, billId, doc.sha256, userId, options?.autoPosted === true],
    );

    const vendorKey = mappingService.vendorKeyOf(doc.vendor_name);
    if (vendorKey !== '') {
      // The account carrying the largest absolute summed amount, ties
      // broken by the lowest line_index — the one account this vendor is
      // "mostly" posted to next time.
      let bestAccountId: string | null = null;
      let bestAmount = -Infinity;
      for (const row of lineItemRows) {
        if (row.account_id === null) continue;
        const amount = Math.abs(parseCents(row.amount_cents));
        if (amount > bestAmount) {
          bestAmount = amount;
          bestAccountId = row.account_id;
        }
      }
      if (bestAccountId !== null) {
        await mappingService.recordVendorMappingOnClient(client, orgId, vendorKey, bestAccountId);
      }
    }

    await client.query('COMMIT');
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

  return captureDocumentService.getCaptureDocumentById(orgId, id);
}
