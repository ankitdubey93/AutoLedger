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
import * as billService from './billService.js';

/**
 * Expense (bill) import (Phase 36d) — validate, preview and commit for the
 * grouped `BILLS` kind. A commit creates each bill through createBillOnClient
 * and, in POST mode, approves it through approveBillOnClient: the document
 * services' own FSMs (rule 6), on the caller's client (rule 5), all or nothing.
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
    'PURCHASES',
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
  return previewDocumentsOnClient(client, orgId, importId, 'PURCHASES', popts);
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
  const { docs, groupCount, conversionMode, booksStartDate } = await resolveImportOnClient(client, orgId, importId, 'PURCHASES');
  if (docs.length !== groupCount) throw new Error('unresolved documents at commit');

  const mode = context.mode ?? 'DRAFT';
  const postingDate = conversionMode ? booksStartDate : context.postingDate;

  let lineCount = 0;
  for (const doc of docs) {
    const rowSpan = `rows ${String(doc.firstRow)}–${String(doc.lastRow)}`;
    const equityAccountId = conversionMode ? doc.lines[0]?.accountId : undefined;
    try {
      const id = await billService.createBillOnClient(
        client,
        orgId,
        createdBy,
        {
          vendorId: doc.contactId,
          vendorReference: doc.number ?? '',
          billDate: doc.date,
          ...(doc.dueDate === null ? {} : { dueDate: doc.dueDate }),
          currencyCode: doc.currencyCode,
          notes: doc.notes,
          paymentTerms: null,
          paymentTermsCode: doc.paymentTermsCode,
          lines: doc.lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unitPriceCents: l.unitPriceCents,
            expenseAccountId: l.accountId,
            taxRateBp: l.taxRateBp,
            itemId: l.itemId,
            stockLocationId: l.stockLocationId,
          })),
        },
        equityAccountId === undefined ? {} : { equityAccountId },
      );
      if (mode === 'POST') {
        // Imported text is historical data, not placeholder-authored (Phase 40).
        await billService.approveBillOnClient(client, orgId, createdBy, id, postingDate, { fillPlaceholders: false });
      }
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(err.status, `${capitalise(doc.label)} (${rowSpan}): ${err.message}`);
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'ux_bills_vendor_reference') {
        throw new ApiError(409, `Expense ${doc.number ?? ''} (${rowSpan}): that expense already exists`);
      }
      throw err;
    }
    lineCount += doc.lines.length;
  }

  await markCommittedOnClient(client, orgId, importId);
  return { kind: 'BILLS', documentCount: docs.length, lineCount, mode };
}
