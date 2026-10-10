import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import type {
  ImportCommitContext,
  ImportPreviewOptions,
  MigrationCommitPreview,
  MigrationCommitResult,
  MigrationImportRow,
} from '../../types/accounting.js';
import { importOptionsForRowOnClient, markCommittedOnClient } from './importRowStore.js';
import { previewDocumentsOnClient, resolveDocumentsOnClient, resolveImportOnClient } from './documentImportCore.js';
import * as invoiceService from './invoiceService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';

/**
 * Invoice import (Phase 36d) — validate, preview and commit for the grouped
 * `INVOICES` kind. A commit creates each invoice through createInvoiceOnClient
 * and, in POST mode, issues it through issueInvoiceOnClient: the document
 * services' own FSMs, never a direct write (rule 6). Everything runs on the
 * caller's client (rule 5), so a failure rolls back every invoice.
 */

export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const first = rows[0];
  const options = first
    ? await importOptionsForRowOnClient(client, orgId, first.id)
    : { dateFormat: 'ISO' as const, conversionMode: false };
  const { rowErrors } = await resolveDocumentsOnClient(
    client,
    orgId,
    'SALES',
    rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, values: r.values, raw: r.raw, groupKey: r.groupKey })),
    options,
  );
  return rows.map((r) => ({ rowId: r.id, errors: rowErrors.get(r.id) ?? [] }));
}

export function preview(
  client: PoolClient,
  orgId: string,
  importId: string,
  popts: ImportPreviewOptions,
): Promise<MigrationCommitPreview> {
  return previewDocumentsOnClient(client, orgId, importId, 'SALES', popts);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  createdBy: string,
  context: ImportCommitContext,
): Promise<Extract<MigrationCommitResult, { documentCount: number }>> {
  const { docs, groupCount, conversionMode, booksStartDate } = await resolveImportOnClient(client, orgId, importId, 'SALES');
  if (docs.length !== groupCount) throw new Error('unresolved documents at commit');

  const mode = context.mode ?? 'DRAFT';
  const postingDate = conversionMode ? booksStartDate : context.postingDate;

  // Before anything is created or allocated: the sequence must already be past the imported numbers.
  await invoiceSettingsService.advancePastImportedNumbersOnClient(
    client,
    orgId,
    docs.flatMap((d) => (d.number === null ? [] : [d.number])),
  );

  let lineCount = 0;
  for (const doc of docs) {
    const rowSpan = `rows ${String(doc.firstRow)}–${String(doc.lastRow)}`;
    const equityAccountId = conversionMode ? doc.lines[0]?.accountId : undefined;
    try {
      const id = await invoiceService.createInvoiceOnClient(
        client,
        orgId,
        createdBy,
        {
          customerId: doc.contactId,
          issueDate: doc.date,
          ...(doc.dueDate === null ? {} : { dueDate: doc.dueDate }),
          currencyCode: doc.currencyCode,
          notes: doc.notes,
          paymentTerms: null,
          paymentTermsCode: doc.paymentTermsCode,
          lines: doc.lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unitPriceCents: l.unitPriceCents,
            revenueAccountId: l.accountId,
            taxRateBp: l.taxRateBp,
            itemId: l.itemId,
            stockLocationId: l.stockLocationId,
          })),
        },
        {
          ...(doc.number === null ? {} : { invoiceNumber: doc.number }),
          ...(equityAccountId === undefined ? {} : { equityAccountId }),
        },
      );
      if (mode === 'POST') {
        // Imported text is historical data, not placeholder-authored (Phase 40).
        await invoiceService.issueInvoiceOnClient(client, orgId, createdBy, id, postingDate, { fillPlaceholders: false });
      }
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(err.status, `${capitalise(doc.label)} (${rowSpan}): ${err.message}`);
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'ux_invoices_org_number') {
        throw new ApiError(409, `Invoice ${doc.number ?? ''} (${rowSpan}): that invoice number already exists`);
      }
      throw err;
    }
    lineCount += doc.lines.length;
  }

  await markCommittedOnClient(client, orgId, importId);
  return { kind: 'INVOICES', documentCount: docs.length, lineCount, mode };
}
