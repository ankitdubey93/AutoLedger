import { pool } from '../../db/connect.js';
import { TAXGUARD_RETRIEVAL_MIN_SCORE, TAXGUARD_RETRIEVAL_TOP_K } from '../../config/constants.js';
import { embedTexts, toVectorLiteral } from './embeddingService.js';
import type { EmbeddingsClient } from './embeddingService.js';
import type { RetrievedChunk, TaxGuardJurisdiction } from '../../types/taxguard.js';

/**
 * TaxGuard AI (Phase 16) — vector retrieval. Every statement carries an
 * org_id predicate, applied on both sides of the join and in the join
 * condition itself — deliberate redundancy, not sloppiness (guardrails
 * rule 1).
 */

interface RetrievalRow {
  id: string;
  corpus_document_id: string;
  corpus_document_title: string;
  citation: string;
  heading: string | null;
  content: string;
  score: number;
}

function clampTopK(topK: number | undefined): number {
  const value = topK ?? TAXGUARD_RETRIEVAL_TOP_K;
  return Math.min(25, Math.max(1, value));
}

export async function retrieve(
  orgId: string,
  queryText: string,
  jurisdiction: TaxGuardJurisdiction,
  topK?: number,
  client?: EmbeddingsClient,
): Promise<RetrievedChunk[]> {
  const [queryVector] = await embedTexts([queryText], 'query', client);
  if (queryVector === undefined) return [];
  const vectorLiteral = toVectorLiteral(queryVector);
  const limit = clampTopK(topK);

  const { rows } = await pool.query<RetrievalRow>(
    `SELECT c.id, c.corpus_document_id, d.title AS corpus_document_title,
            c.citation, c.heading, c.content,
            1 - (c.embedding <=> $2::vector) AS score
       FROM taxguard_chunks c
       JOIN taxguard_corpus_documents d
         ON d.id = c.corpus_document_id AND d.org_id = c.org_id
      WHERE c.org_id = $1
        AND d.org_id = $1
        AND d.status = 'READY'
        AND d.jurisdiction = $3
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $2::vector
      LIMIT $4`,
    [orgId, vectorLiteral, jurisdiction, limit],
  );

  return rows
    .filter((row) => row.score >= TAXGUARD_RETRIEVAL_MIN_SCORE)
    .map((row) => ({
      id: row.id,
      corpusDocumentId: row.corpus_document_id,
      corpusDocumentTitle: row.corpus_document_title,
      citation: row.citation,
      heading: row.heading,
      content: row.content,
      score: row.score,
    }));
}
