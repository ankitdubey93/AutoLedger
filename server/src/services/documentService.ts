import type { Readable } from 'node:stream';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { sniffMimeType } from '../utils/mimeSniff.js';
import { isAppSlug } from '../config/apps.js';
import * as storageService from './storageService.js';
import type { AllowedUploadMimeType } from '../config/constants.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config/constants.js';
import { isDocumentEntityType } from '../types/documents.js';
import type {
  AttachDocumentInput,
  DocumentLink,
  DocumentListFilters,
  DocumentRecord,
  DocumentWithLinks,
} from '../types/documents.js';

/**
 * The Document Vault (Phase 9.5) — platform-level, unprefixed, mirroring
 * `webhookService`/`onboardingService`. Every function takes `orgId` first
 * and every statement carries an `org_id` predicate (guardrails rule 1).
 *
 * This file queries only `documents` and `document_links` — never an app's
 * own tables (rule 16). See docs/roadmap.md#phase-95-planned-scope.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface DocumentRow {
  id: string;
  sha256: string;
  byte_size: string;
  mime_type: string;
  original_filename: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: Date;
  link_count: number;
}

interface LinkRow {
  id: string;
  document_id: string;
  app_slug: string;
  entity_type: string;
  entity_id: string;
  created_by: string;
  created_at: Date;
}

// `SELECT *` is banned here for the same reason it is banned in
// webhookService — a careless star is how a column nobody meant to expose
// ends up in a response.
const DOCUMENT_SELECT = `SELECT d.id, d.sha256, d.byte_size, d.mime_type,
                                d.original_filename, d.uploaded_by,
                                u.name AS uploaded_by_name, d.created_at,
                                (SELECT COUNT(*)::int FROM document_links l
                                  WHERE l.org_id = d.org_id AND l.document_id = d.id) AS link_count
                           FROM documents d
                           LEFT JOIN users u ON u.id = d.uploaded_by`;

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    // BIGINT arrives from `pg` as a string; Number() is exact under 2^53,
    // which every file under MAX_UPLOAD_BYTES is.
    byteSize: Number(row.byte_size),
    mimeType: row.mime_type as AllowedUploadMimeType,
    originalFilename: row.original_filename,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at.toISOString(),
    linkCount: row.link_count,
  };
}

function toLink(row: LinkRow): DocumentLink {
  return {
    id: row.id,
    documentId: row.document_id,
    appSlug: row.app_slug,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** Shared by uploadDocument and getDocumentById so both map through one path. */
async function loadDocument(orgId: string, id: string): Promise<DocumentRecord> {
  try {
    const { rows } = await pool.query<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.org_id = $1 AND d.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Document not found');
    return toDocument(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Document not found');
    }
    throw err;
  }
}

export async function uploadDocument(
  orgId: string,
  uploadedBy: string,
  file: { buffer: Buffer; originalname: string },
): Promise<{ document: DocumentRecord; created: boolean }> {
  const mimeType = sniffMimeType(file.buffer, file.originalname);
  if (mimeType === null) {
    throw new ApiError(415, 'Unsupported file type. Allowed: PDF, PNG, JPEG, CSV');
  }
  if (file.buffer.byteLength === 0) {
    throw new ApiError(400, 'Uploaded file is empty');
  }

  // The blob is written before the row. A rollback below leaves an inert
  // orphan on disk, which is accepted — rule 5 forbids post-COMMIT cleanup,
  // and deleting the file before commit would destroy data on a retry.
  const { sha256 } = await storageService.put(orgId, file.buffer);

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, sha256) DO NOTHING
       RETURNING id`,
      [orgId, sha256, file.buffer.byteLength, mimeType, file.originalname, uploadedBy],
    );
    const inserted = rows[0];
    if (inserted !== undefined) return { id: inserted.id, created: true };

    // The bytes already existed for this org — upload is idempotent by
    // (org_id, sha256).
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM documents WHERE org_id = $1 AND sha256 = $2',
      [orgId, sha256],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) throw new Error('Document vanished mid-transaction');
    return { id: existingRow.id, created: false };
  });

  return { document: await loadDocument(orgId, id.id), created: id.created };
}

/**
 * Builds one shared predicate for both the count and the page query —
 * sharing it is what keeps `totalCount` honest under a filter, the same
 * discipline journalService.buildFilters uses. Only `$n` placeholders are
 * ever inserted into a fragment, never a caller's value (guardrails rule 4).
 */
function buildFilters(
  orgId: string,
  filters: DocumentListFilters,
): { where: string; values: unknown[] } {
  const clauses = ['d.org_id = $1'];
  const values: unknown[] = [orgId];

  if (filters.appSlug !== null || filters.entityType !== null || filters.entityId !== null) {
    const linkClauses = ['l.org_id = d.org_id', 'l.document_id = d.id'];
    if (filters.appSlug !== null) {
      values.push(filters.appSlug);
      linkClauses.push(`l.app_slug = $${String(values.length)}`);
    }
    if (filters.entityType !== null) {
      values.push(filters.entityType);
      linkClauses.push(`l.entity_type = $${String(values.length)}`);
    }
    if (filters.entityId !== null) {
      values.push(filters.entityId);
      linkClauses.push(`l.entity_id = $${String(values.length)}::uuid`);
    }
    clauses.push(`EXISTS (SELECT 1 FROM document_links l WHERE ${linkClauses.join(' AND ')})`);
  }

  return { where: clauses.join(' AND '), values };
}

export async function listDocuments(
  orgId: string,
  filters: DocumentListFilters,
): Promise<{ documents: DocumentRecord[]; totalCount: number; currentPage: number; totalPages: number }> {
  const page = filters.page > 0 ? filters.page : 1;
  const limit = filters.limit > 0 ? Math.min(filters.limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * limit;
  const { where, values } = buildFilters(orgId, filters);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM documents d WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `d.id DESC` is a required tiebreaker: two documents sharing created_at
  // could otherwise swap between pages and be shown twice or not at all.
  const { rows } = await pool.query<DocumentRow>(
    `${DOCUMENT_SELECT}
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
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

export async function getDocumentById(orgId: string, id: string): Promise<DocumentWithLinks> {
  const document = await loadDocument(orgId, id);
  const { rows } = await pool.query<LinkRow>(
    `SELECT id, document_id, app_slug, entity_type, entity_id, created_by, created_at
       FROM document_links
      WHERE org_id = $1 AND document_id = $2
      ORDER BY created_at`,
    [orgId, id],
  );
  return { ...document, links: rows.map(toLink) };
}

/** Metadata plus a read stream, for the download route. */
export async function openDocumentStream(
  orgId: string,
  id: string,
): Promise<{ document: DocumentRecord; stream: Readable }> {
  const document = await loadDocument(orgId, id);
  const stream = storageService.get(orgId, document.sha256);
  return { document, stream };
}

export async function deleteDocument(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM document_links WHERE org_id = $1 AND document_id = $2',
      [orgId, id],
    );
    const n = Number(rows[0]?.n ?? '0');
    if (n > 0) {
      throw new ApiError(409, 'Detach this document from every record before deleting it');
    }

    const { rowCount } = await client.query('DELETE FROM documents WHERE org_id = $1 AND id = $2', [
      orgId,
      id,
    ]);
    if (rowCount === 0) throw new ApiError(404, 'Document not found');

    // The blob is left on disk — blob garbage collection is deliberately out
    // of scope for this phase. See docs/roadmap.md's "Deliberately not
    // planned" list.
  });
}

// ------------------------------------------------------------------- links

export async function attachDocument(
  orgId: string,
  documentId: string,
  createdBy: string,
  input: AttachDocumentInput,
): Promise<DocumentLink> {
  if (!isAppSlug(input.appSlug)) {
    throw new ApiError(422, `Unknown app slug: ${input.appSlug}`);
  }
  if (!isDocumentEntityType(input.appSlug, input.entityType)) {
    throw new ApiError(
      422,
      `${input.appSlug} documents cannot be attached to "${input.entityType}"`,
    );
  }

  return withTransaction(async (client) => {
    try {
      // The tenancy check — it must run before the insert. The composite FK
      // (org_id, document_id) -> documents (org_id, id) backs this up at the
      // schema level, so a cross-tenant link is unrepresentable even if this
      // check were somehow bypassed.
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM documents WHERE org_id = $1 AND id = $2',
        [orgId, documentId],
      );
      if (existing.rows[0] === undefined) throw new ApiError(404, 'Document not found');

      // Deliberately no query against invoices/bills/journal_entries or any
      // other app's tables here — a dangling link outliving its entity is
      // tolerated, because checking would mean the platform reading an
      // app's tables, which rule 16 forbids.
      const { rows } = await client.query<LinkRow>(
        `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, document_id, app_slug, entity_type, entity_id, created_by, created_at`,
        [orgId, documentId, input.appSlug, input.entityType, input.entityId, createdBy],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return toLink(row);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ApiError(409, 'This document is already attached to that record');
      }
      if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
        throw new ApiError(404, 'Document not found');
      }
      throw err;
    }
  });
}

export async function detachDocument(orgId: string, documentId: string, linkId: string): Promise<void> {
  await withTransaction(async (client) => {
    try {
      const { rowCount } = await client.query(
        'DELETE FROM document_links WHERE org_id = $1 AND document_id = $2 AND id = $3',
        [orgId, documentId, linkId],
      );
      if (rowCount === 0) throw new ApiError(404, 'Attachment not found');
    } catch (err) {
      if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
        throw new ApiError(404, 'Attachment not found');
      }
      throw err;
    }
  });
}
