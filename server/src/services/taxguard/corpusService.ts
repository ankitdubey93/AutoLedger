import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import * as documentService from '../documentService.js';
import { enqueue } from '../../queue/queues.js';
import { ApiError } from '../../utils/apiError.js';
import { toVectorLiteral } from './embeddingService.js';
import { canTransitionCorpus } from '../../types/taxguard.js';
import type { TaxGuardChunk, TaxGuardCorpusDocument, TaxGuardCorpusStatus, TaxGuardJurisdiction } from '../../types/taxguard.js';
import type { ParsedChunk } from '../../utils/taxActParse.js';

/**
 * TaxGuard AI (Phase 16) — corpus (tax act) lifecycle. This file contains
 * ZERO SQL against another app's tables. Its only route into the platform is
 * `documentService.getDocumentById` (guardrails rule 16) — already 404s a
 * cross-tenant id. `documents` is a PLATFORM table (migration 030's own
 * header), so this is not a rule-16 violation.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_UNIQUE_VIOLATION = '23505';
const MAX_ERROR_MESSAGE_CHARS = 500;

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface CorpusRow {
  id: string;
  document_id: string;
  title: string;
  jurisdiction: TaxGuardJurisdiction;
  act_year: number | null;
  status: TaxGuardCorpusStatus;
  chunk_count: number;
  error_message: string | null;
  ingested_at: Date | null;
  created_by_name: string | null;
  created_at: Date;
}

const CORPUS_SELECT = `
  SELECT c.id, c.document_id, c.title, c.jurisdiction, c.act_year, c.status,
         c.chunk_count, c.error_message, c.ingested_at,
         creator.name AS created_by_name,
         c.created_at
    FROM taxguard_corpus_documents c
    LEFT JOIN users creator ON creator.id = c.created_by
`;

function toCorpusDocument(row: CorpusRow): TaxGuardCorpusDocument {
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    jurisdiction: row.jurisdiction,
    actYear: row.act_year,
    status: row.status,
    chunkCount: row.chunk_count,
    errorMessage: row.error_message,
    ingestedAt: row.ingested_at === null ? null : row.ingested_at.toISOString(),
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

interface ChunkRow {
  id: string;
  corpus_document_id: string;
  ordinal: number;
  citation: string;
  heading: string | null;
  content: string;
  token_estimate: number;
}

const CHUNK_SELECT = `
  SELECT id, corpus_document_id, ordinal, citation, heading, content, token_estimate
    FROM taxguard_chunks
`;

function toChunk(row: ChunkRow): TaxGuardChunk {
  return {
    id: row.id,
    corpusDocumentId: row.corpus_document_id,
    ordinal: row.ordinal,
    citation: row.citation,
    heading: row.heading,
    content: row.content,
    tokenEstimate: row.token_estimate,
  };
}

export async function listCorpusDocuments(orgId: string): Promise<TaxGuardCorpusDocument[]> {
  const { rows } = await pool.query<CorpusRow>(
    `${CORPUS_SELECT} WHERE c.org_id = $1 ORDER BY c.created_at DESC`,
    [orgId],
  );
  return rows.map(toCorpusDocument);
}

export async function getCorpusDocumentById(orgId: string, id: string): Promise<TaxGuardCorpusDocument> {
  try {
    const { rows } = await pool.query<CorpusRow>(`${CORPUS_SELECT} WHERE c.org_id = $1 AND c.id = $2`, [
      orgId,
      id,
    ]);
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Corpus document not found');
    return toCorpusDocument(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Corpus document not found');
    }
    throw err;
  }
}

export async function listChunks(orgId: string, corpusDocumentId: string): Promise<TaxGuardChunk[]> {
  // Verify the corpus document exists for this org first — otherwise a
  // cross-tenant or unknown id returns an empty array (200) rather than the
  // 404 a missing resource must produce.
  await getCorpusDocumentById(orgId, corpusDocumentId);

  const { rows } = await pool.query<ChunkRow>(
    `${CHUNK_SELECT} WHERE org_id = $1 AND corpus_document_id = $2 ORDER BY ordinal ASC`,
    [orgId, corpusDocumentId],
  );
  return rows.map(toChunk);
}

export interface CreateCorpusInput {
  documentId: string;
  title: string;
  jurisdiction: TaxGuardJurisdiction;
  actYear: number | null;
}

export async function createCorpusDocument(
  orgId: string,
  userId: string,
  input: CreateCorpusInput,
): Promise<TaxGuardCorpusDocument> {
  const document = await documentService.getDocumentById(orgId, input.documentId);
  if (document.mimeType !== 'application/pdf') {
    throw new ApiError(400, 'Corpus documents must be PDF');
  }

  try {
    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO taxguard_corpus_documents (org_id, document_id, title, jurisdiction, act_year, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [orgId, input.documentId, input.title, input.jurisdiction, input.actYear, userId],
      );
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('createCorpusDocument: insert returned no row');
      return inserted.id;
    });

    // After commit — never inside the transaction (guardrails rule 5).
    await enqueue('taxguard-embed', { orgId, corpusDocumentId: id }, { jobId: `taxguard-embed-${id}` });

    return getCorpusDocumentById(orgId, id);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'This document is already in the corpus');
    }
    throw err;
  }
}

export async function deleteCorpusDocument(orgId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(
    'DELETE FROM taxguard_corpus_documents WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  if (rowCount === 0) throw new ApiError(404, 'Corpus document not found');
}

/* ---------- called only by the queue handler */

export async function loadForIngestion(
  orgId: string,
  id: string,
): Promise<{ documentId: string; title: string; status: TaxGuardCorpusStatus } | null> {
  try {
    const doc = await getCorpusDocumentById(orgId, id);
    return { documentId: doc.documentId, title: doc.title, status: doc.status };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function markStatus(
  orgId: string,
  id: string,
  from: TaxGuardCorpusStatus,
  to: TaxGuardCorpusStatus,
): Promise<boolean> {
  if (!canTransitionCorpus(from, to)) return false;
  const { rowCount } = await pool.query(
    'UPDATE taxguard_corpus_documents SET status = $3 WHERE org_id = $1 AND id = $2 AND status = $4',
    [orgId, id, to, from],
  );
  return rowCount === 1;
}

/** Replaces every chunk for this corpus document, inside one transaction. */
export async function replaceChunks(
  orgId: string,
  corpusDocumentId: string,
  chunks: ParsedChunk[],
): Promise<number> {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM taxguard_chunks WHERE org_id = $1 AND corpus_document_id = $2', [
      orgId,
      corpusDocumentId,
    ]);

    let inserted = 0;
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO taxguard_chunks
           (org_id, corpus_document_id, ordinal, citation, heading, content, token_estimate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, corpusDocumentId, chunk.ordinal, chunk.citation, chunk.heading, chunk.content, chunk.tokenEstimate],
      );
      inserted++;
    }
    return inserted;
  });
}

/** Writes one chunk's vector. Uses toVectorLiteral + an ::vector cast. */
export async function setChunkEmbedding(orgId: string, chunkId: string, embedding: number[]): Promise<void> {
  await pool.query('UPDATE taxguard_chunks SET embedding = $3::vector, embedded_at = now() WHERE org_id = $1 AND id = $2', [
    orgId,
    chunkId,
    toVectorLiteral(embedding),
  ]);
}

/** Chunks still awaiting a vector, oldest ordinal first. */
export async function listUnembeddedChunks(orgId: string, corpusDocumentId: string): Promise<TaxGuardChunk[]> {
  const { rows } = await pool.query<ChunkRow>(
    `${CHUNK_SELECT} WHERE org_id = $1 AND corpus_document_id = $2 AND embedding IS NULL ORDER BY ordinal ASC`,
    [orgId, corpusDocumentId],
  );
  return rows.map(toChunk);
}

export async function markReady(orgId: string, id: string, chunkCount: number): Promise<void> {
  await pool.query(
    `UPDATE taxguard_corpus_documents
        SET status = 'READY', chunk_count = $3, ingested_at = now(), error_message = NULL
      WHERE org_id = $1 AND id = $2 AND status = 'EMBEDDING'`,
    [orgId, id, chunkCount],
  );
}

export async function markFailed(orgId: string, id: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE taxguard_corpus_documents
        SET status = 'FAILED', error_message = $3, ingested_at = NULL
      WHERE org_id = $1 AND id = $2`,
    [orgId, id, message.slice(0, MAX_ERROR_MESSAGE_CHARS)],
  );
}
