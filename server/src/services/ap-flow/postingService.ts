import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import * as journalService from '../ledger-core/journalService.js';
import * as fxRateService from '../ledger-core/fxRateService.js';
import { resolveApPostingAccountsOnClient } from '../ledger-core/settingsService.js';
import * as mappingService from './mappingService.js';
import * as apFlowDocumentService from './apFlowDocumentService.js';
import { canTransitionApFlowDocument } from '../../types/ap-flow.js';
import type { ApFlowDocumentDetail, ApFlowDocumentStatus } from '../../types/ap-flow.js';

/**
 * AP-Flow's one-click post into LedgerCore (Phase 11) — the app boundary in
 * practice. This file writes no GL entry row and no GL line row directly,
 * and queries none of LedgerCore's chart, settings, or exchange-rate
 * tables directly — every LedgerCore fact it needs arrives through an
 * exported LedgerCore service function on this file's own checked-out
 * transaction client (guardrails rules 5 and 16).
 *
 * Everything below runs in one transaction: the FSM lock and check, the
 * refusal checks, the FX resolution, the posting, freezing this document's
 * own row, and the vendor-history upsert all commit together or not at
 * all. There is deliberately no work after COMMIT.
 */

const PG_RAISE_EXCEPTION = 'P0001';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the posting';
  }
  return 'Database rejected the posting';
}

interface DocumentForPostingRow {
  id: string;
  status: ApFlowDocumentStatus;
  sha256: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  currency: string | null;
  subtotal_cents: string | null;
  tax_cents: string | null;
  total_cents: string | null;
  arithmetic_ok: boolean | null;
}

interface LineItemForPostingRow {
  line_index: number;
  amount_cents: string;
  account_id: string | null;
}

export async function postApFlowDocument(
  orgId: string,
  userId: string,
  id: string,
): Promise<ApFlowDocumentDetail> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: docRows } = await client.query<DocumentForPostingRow>(
      `SELECT a.id, a.status, d.sha256,
              x.vendor_name, x.invoice_number, x.invoice_date, x.currency,
              x.subtotal_cents, x.tax_cents, x.total_cents, x.arithmetic_ok
         FROM ap_flow_documents a
         JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id
         LEFT JOIN ap_flow_extractions x ON x.org_id = a.org_id AND x.ap_flow_document_id = a.id
        WHERE a.org_id = $1 AND a.id = $2
        FOR UPDATE OF a`,
      [orgId, id],
    );
    const doc = docRows[0];
    if (doc === undefined) throw new ApiError(404, 'AP-Flow document not found');

    if (!canTransitionApFlowDocument(doc.status, 'POSTED')) {
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
    const taxCents = doc.tax_cents === null ? 0 : parseCents(doc.tax_cents);

    const { rows: lineItemRows } = await client.query<LineItemForPostingRow>(
      `SELECT line_index, amount_cents, account_id
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

    // FX at the invoice date — never the posting date, since AP-Flow has
    // only one date. requireRateOnClient resolves the identity rate itself
    // when the document currency already matches the base currency.
    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const documentCurrency = (doc.currency ?? baseCurrency).trim();
    const { rate: fxRate } = await fxRateService.requireRateOnClient(
      client,
      orgId,
      documentCurrency,
      baseCurrency,
      doc.invoice_date,
    );

    const { payableAccountId, taxAccountId } = await resolveApPostingAccountsOnClient(
      client,
      orgId,
      taxCents > 0,
    );

    // One debit line per distinct expense account — the expense total is
    // the line items' own sum, never subtotal_cents, so a reviewer's
    // account overrides can never change the money that posts.
    const byAccount = new Map<string, number>();
    for (const row of lineItemRows) {
      const accountId = row.account_id;
      if (accountId === null) continue; // unreachable — checked above
      const amount = parseCents(row.amount_cents);
      byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + amount);
    }

    const glLines = [
      ...[...byAccount.entries()].map(([accountId, amountCents]) => ({
        accountId,
        debitCents: amountCents,
        creditCents: 0,
        currencyCode: documentCurrency,
        fxRate,
      })),
      { accountId: payableAccountId, debitCents: 0, creditCents: totalCents, currencyCode: documentCurrency, fxRate },
    ];
    if (taxAccountId !== null && taxCents > 0) {
      glLines.push({ accountId: taxAccountId, debitCents: taxCents, creditCents: 0, currencyCode: documentCurrency, fxRate });
    }

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      throw new ApiError(422, 'Extracted line items and tax do not sum to the document total');
    }

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: doc.invoice_date,
      description: `AP-Flow ${doc.invoice_number ?? 'document'} — ${doc.vendor_name ?? 'Unknown vendor'}`,
      sourceType: 'ap_flow',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'POSTED', journal_entry_id = $3, posted_sha256 = $4, posted_at = now(), posted_by = $5
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, journalEntryId, doc.sha256, userId],
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

  return apFlowDocumentService.getApFlowDocumentById(orgId, id);
}
