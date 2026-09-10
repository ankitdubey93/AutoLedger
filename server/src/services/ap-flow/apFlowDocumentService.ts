import type { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as storageService from '../storageService.js';
import { enqueue } from '../../queue/queues.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants.js';
import { canTransitionApFlowDocument } from '../../types/ap-flow.js';
import type {
  ApFlowDocumentDetail,
  ApFlowDocumentListFilters,
  ApFlowDocumentRecord,
  ApFlowDocumentStatus,
  ApFlowExtraction,
  ApFlowLineItem,
  ApFlowPage,
  RedactedRegion,
} from '../../types/ap-flow.js';
import type { ExtractionResult } from './extractionService.js';

/**
 * AP-Flow's document register (Phase 10). Every function takes `orgId`
 * first and every statement carries an `org_id` predicate (guardrails
 * rule 1). This file queries only `ap_flow_*`, `documents` and
 * `document_links` — never a `ledger-core` table (rule 16).
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

const SCANNABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

interface DocumentRow {
  id: string;
  document_id: string;
  original_filename: string;
  mime_type: string;
  sha256: string;
  status: ApFlowDocumentStatus;
  page_count: number | null;
  failure_reason: string | null;
  processed_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
}

interface PageRow {
  id: string;
  page_number: number;
  width_px: number;
  height_px: number;
  redacted_sha256: string;
  redacted_regions: RedactedRegion[];
}

interface ExtractionRow {
  id: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  currency: string | null;
  subtotal_cents: string | null;
  tax_cents: string | null;
  total_cents: string | null;
  line_items: ApFlowLineItem[];
  field_confidence: Record<string, number>;
  arithmetic_ok: boolean;
  validation_errors: string[];
  model: string;
  created_at: Date;
}

// `SELECT *` is banned here for the same reason it is banned in
// documentService — a careless star is how a column nobody meant to expose
// ends up in a response. Joined to the vault's documents row for the
// original filename/mime/hash, and to users for the uploader's display name.
const DOCUMENT_SELECT = `SELECT a.id, a.document_id, d.original_filename, d.mime_type, d.sha256,
                                a.status, a.page_count, a.failure_reason, a.processed_at,
                                a.created_by, u.name AS created_by_name, a.created_at
                           FROM ap_flow_documents a
                           JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id
                           LEFT JOIN users u ON u.id = a.created_by`;

function toDocument(row: DocumentRow): ApFlowDocumentRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sha256: row.sha256,
    status: row.status,
    pageCount: row.page_count,
    failureReason: row.failure_reason,
    processedAt: row.processed_at === null ? null : row.processed_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

function toPage(row: PageRow): ApFlowPage {
  return {
    id: row.id,
    pageNumber: row.page_number,
    widthPx: row.width_px,
    heightPx: row.height_px,
    redactedSha256: row.redacted_sha256,
    redactedRegions: row.redacted_regions,
  };
}

function toExtraction(row: ExtractionRow): ApFlowExtraction {
  return {
    id: row.id,
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    currency: row.currency,
    // BIGINT arrives from `pg` as a string; Number() is exact under 2^53.
    subtotalCents: row.subtotal_cents === null ? null : Number(row.subtotal_cents),
    taxCents: row.tax_cents === null ? null : Number(row.tax_cents),
    totalCents: row.total_cents === null ? null : Number(row.total_cents),
    lineItems: row.line_items,
    fieldConfidence: row.field_confidence,
    arithmeticOk: row.arithmetic_ok,
    validationErrors: row.validation_errors,
    model: row.model,
    createdAt: row.created_at.toISOString(),
  };
}

/** Shared by createApFlowDocument and getApFlowDocumentById so both map through one path. */
async function loadDocument(orgId: string, id: string): Promise<ApFlowDocumentRecord> {
  try {
    const { rows } = await pool.query<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'AP-Flow document not found');
    return toDocument(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'AP-Flow document not found');
    }
    throw err;
  }
}

export async function createApFlowDocument(
  orgId: string,
  createdBy: string,
  input: { documentId: string },
): Promise<ApFlowDocumentRecord> {
  const id = await withTransaction(async (client) => {
    const vaultDoc = await client.query<{ id: string; mime_type: string }>(
      'SELECT id, mime_type FROM documents WHERE org_id = $1 AND id = $2',
      [orgId, input.documentId],
    );
    const vaultRow = vaultDoc.rows[0];
    if (vaultRow === undefined) throw new ApiError(404, 'Document not found');
    if (!SCANNABLE_MIME_TYPES.has(vaultRow.mime_type)) {
      throw new ApiError(422, 'AP-Flow can only process PDF, PNG and JPEG documents');
    }

    let inserted: { id: string };
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [orgId, input.documentId, createdBy],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      inserted = row;
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ApiError(409, 'This document is already registered with AP-Flow');
      }
      throw err;
    }

    // The cross-app proof: AP-Flow attaches through the platform's
    // document_links table, never by reaching into another app's tables
    // (rule 16).
    await client.query(
      `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
       VALUES ($1, $2, 'ap-flow', 'ap_flow_document', $3, $4)
       ON CONFLICT DO NOTHING`,
      [orgId, input.documentId, inserted.id, createdBy],
    );

    return inserted;
  });

  // Enqueued only after withTransaction has returned, i.e. after COMMIT —
  // Redis, not Postgres, so it is deliberately not covered by the
  // transaction itself. Enqueuing before commit would risk firing a job for
  // a row a rollback then erases; enqueuing here instead risks the opposite,
  // narrower gap (a crash between COMMIT and this call leaves the document
  // stuck at PENDING). That gap is accepted: nothing financial is at stake,
  // the document is visibly PENDING, and POST /:id/reextract is the
  // user-visible repair — this is not the outbox case rule 5 exists for.
  await enqueue('ap-flow-extract', { orgId, apFlowDocumentId: id.id }, {
    // BullMQ rejects ':' in a custom jobId — '-' is the safe delimiter (see
    // outboxDrainHandler.ts and webhookDeliveryController.ts).
    jobId: `ap-flow-extract-${id.id}`,
  });

  return loadDocument(orgId, id.id);
}

/**
 * One shared predicate for both the count and the page query — sharing it
 * is what keeps `totalCount` honest under a filter, mirroring
 * documentService.buildFilters.
 */
function buildFilters(
  orgId: string,
  filters: ApFlowDocumentListFilters,
): { where: string; values: unknown[] } {
  const clauses = ['a.org_id = $1'];
  const values: unknown[] = [orgId];

  if (filters.status !== null) {
    values.push(filters.status);
    clauses.push(`a.status = $${String(values.length)}`);
  }

  return { where: clauses.join(' AND '), values };
}

export async function listApFlowDocuments(
  orgId: string,
  filters: ApFlowDocumentListFilters,
): Promise<{
  documents: ApFlowDocumentRecord[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
}> {
  const page = filters.page > 0 ? filters.page : 1;
  const limit = filters.limit > 0 ? Math.min(filters.limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * limit;
  const { where, values } = buildFilters(orgId, filters);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM ap_flow_documents a WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `a.id DESC` is a required tiebreaker: two documents sharing created_at
  // could otherwise swap between pages and be shown twice or not at all.
  const { rows } = await pool.query<DocumentRow>(
    `${DOCUMENT_SELECT}
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, limit, offset],
  );

  return {
    documents: rows.map(toDocument),
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  };
}

export async function getApFlowDocumentById(orgId: string, id: string): Promise<ApFlowDocumentDetail> {
  const document = await loadDocument(orgId, id);

  // ocr_text is deliberately never selected here — it is the unredacted
  // local OCR text, and returning it would undo the redaction.
  const { rows: pageRows } = await pool.query<PageRow>(
    `SELECT id, page_number, width_px, height_px, redacted_sha256, redacted_regions
       FROM ap_flow_pages
      WHERE org_id = $1 AND ap_flow_document_id = $2
      ORDER BY page_number`,
    [orgId, id],
  );

  const { rows: extractionRows } = await pool.query<ExtractionRow>(
    `SELECT id, vendor_name, invoice_number, invoice_date, currency,
            subtotal_cents, tax_cents, total_cents, line_items, field_confidence,
            arithmetic_ok, validation_errors, model, created_at
       FROM ap_flow_extractions
      WHERE org_id = $1 AND ap_flow_document_id = $2`,
    [orgId, id],
  );

  return {
    ...document,
    pages: pageRows.map(toPage),
    extraction: extractionRows[0] === undefined ? null : toExtraction(extractionRows[0]),
  };
}

export async function openPageImage(
  orgId: string,
  id: string,
  pageNumber: number,
): Promise<{ stream: Readable; byteSize: number }> {
  let row: { redacted_sha256: string } | undefined;
  try {
    const { rows } = await pool.query<{ redacted_sha256: string }>(
      `SELECT p.redacted_sha256
         FROM ap_flow_pages p
         JOIN ap_flow_documents a ON a.org_id = p.org_id AND a.id = p.ap_flow_document_id
        WHERE p.org_id = $1 AND a.id = $2 AND p.page_number = $3`,
      [orgId, id, pageNumber],
    );
    row = rows[0];
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Page not found');
    }
    throw err;
  }
  if (row === undefined) throw new ApiError(404, 'Page not found');

  const stat = await storageService.stat(orgId, row.redacted_sha256);
  if (stat === null) throw new ApiError(404, 'Redacted page image not found');

  return { stream: storageService.get(orgId, row.redacted_sha256), byteSize: stat.byteSize };
}

export async function requestReextraction(orgId: string, id: string): Promise<ApFlowDocumentRecord> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: ApFlowDocumentStatus }>(
      'SELECT status FROM ap_flow_documents WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'AP-Flow document not found');
    if (!canTransitionApFlowDocument(row.status, 'PENDING')) {
      throw new ApiError(409, `Cannot re-extract a document in status ${row.status}`);
    }

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'PENDING', failure_reason = NULL,
              processing_started_at = NULL, processed_at = NULL
        WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
  });

  // Enqueued after COMMIT, like createApFlowDocument's — see the comment
  // there. jobId carries a timestamp so a re-extract is never deduped away
  // against the original registration's job.
  await enqueue('ap-flow-extract', { orgId, apFlowDocumentId: id }, {
    jobId: `ap-flow-extract-${id}-${String(Date.now())}`,
  });

  return loadDocument(orgId, id);
}

// -------------------------------------------------------- worker-side (E2)

/** Worker-side read. Returns the vault bytes' locator plus the current status. */
export async function loadForProcessing(
  orgId: string,
  id: string,
): Promise<{ status: ApFlowDocumentStatus; sha256: string; mimeType: string } | null> {
  try {
    const { rows } = await pool.query<{ status: ApFlowDocumentStatus; sha256: string; mime_type: string }>(
      `SELECT a.status, d.sha256, d.mime_type
         FROM ap_flow_documents a
         JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id
        WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { status: row.status, sha256: row.sha256, mimeType: row.mime_type };
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) return null;
    throw err;
  }
}

/**
 * Transitions PENDING -> PROCESSING. Returns false (a no-op, not an error)
 * when the document is not in PENDING — at-least-once job delivery means a
 * duplicate 'ap-flow-extract' job WILL arrive, and the second one must do
 * nothing rather than reprocess or fail.
 */
export async function markProcessing(orgId: string, id: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ status: ApFlowDocumentStatus }>(
      'SELECT status FROM ap_flow_documents WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) return false;
    if (!canTransitionApFlowDocument(row.status, 'PROCESSING')) return false;

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'PROCESSING', processing_started_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return true;
  });
}

interface PipelinePage {
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  redactedSha256: string;
  ocrText: string;
  redactedRegions: RedactedRegion[];
}

/**
 * Replaces this document's pages and extraction wholesale and marks it
 * EXTRACTED — one transaction, every statement on the checked-out client.
 * DELETE-then-INSERT rather than UPDATE, because ap_flow_pages/
 * ap_flow_extractions are update-immutable by trigger (migration 031):
 * what the model said on a prior run stays non-repudiable in audit_logs,
 * and a re-extraction is a new run, not an edit of the old one.
 */
export async function savePipelineResult(
  orgId: string,
  id: string,
  pages: PipelinePage[],
  extraction: ExtractionResult,
): Promise<void> {
  await withTransaction(async (client) => {
    await deletePipelineRows(client, orgId, id);

    for (const page of pages) {
      await client.query(
        `INSERT INTO ap_flow_pages
           (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text, redacted_regions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          orgId,
          id,
          page.pageNumber,
          page.widthPx,
          page.heightPx,
          page.redactedSha256,
          page.ocrText,
          JSON.stringify(page.redactedRegions),
        ],
      );
    }

    await client.query(
      `INSERT INTO ap_flow_extractions
         (org_id, ap_flow_document_id, vendor_name, invoice_number, invoice_date, currency,
          subtotal_cents, tax_cents, total_cents, line_items, field_confidence,
          arithmetic_ok, validation_errors, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14)`,
      [
        orgId,
        id,
        extraction.vendorName,
        extraction.invoiceNumber,
        extraction.invoiceDate,
        extraction.currency,
        extraction.subtotalCents,
        extraction.taxCents,
        extraction.totalCents,
        JSON.stringify(extraction.lineItems),
        JSON.stringify(extraction.fieldConfidence),
        extraction.arithmeticOk,
        JSON.stringify(extraction.validationErrors),
        extraction.model,
      ],
    );

    const { rows } = await client.query<{ status: ApFlowDocumentStatus }>(
      'SELECT status FROM ap_flow_documents WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'AP-Flow document not found');
    if (!canTransitionApFlowDocument(row.status, 'EXTRACTED')) {
      throw new ApiError(409, `Cannot mark extracted a document in status ${row.status}`);
    }

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'EXTRACTED', page_count = $3, processed_at = now(), failure_reason = NULL
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, pages.length],
    );
  });
}

async function deletePipelineRows(client: PoolClient, orgId: string, id: string): Promise<void> {
  await client.query('DELETE FROM ap_flow_pages WHERE org_id = $1 AND ap_flow_document_id = $2', [
    orgId,
    id,
  ]);
  await client.query('DELETE FROM ap_flow_extractions WHERE org_id = $1 AND ap_flow_document_id = $2', [
    orgId,
    id,
  ]);
}

/**
 * Marks a document FAILED with a reason, truncated to match the CHECK
 * constraint. Routed through `withTransaction`, like every other write in
 * this file, rather than a bare `pool.query` — the sanctioned entry point
 * for every write since Phase 5, even a single-statement one.
 */
export async function markFailed(orgId: string, id: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: ApFlowDocumentStatus }>(
      'SELECT status FROM ap_flow_documents WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) return;
    if (!canTransitionApFlowDocument(row.status, 'FAILED')) return;

    await client.query(
      `UPDATE ap_flow_documents
          SET status = 'FAILED', failure_reason = $3, processed_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, reason.slice(0, 1000)],
    );
  });
}
