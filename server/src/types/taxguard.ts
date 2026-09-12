/**
 * TaxGuard AI (Phase 16) — tax act parsing, RAG over pgvector, cited answers.
 *
 * TaxGuard reads no other app's tables. `documents`/`document_links` are
 * PLATFORM tables (migration 030's own header), not app-owned, so using them
 * is not a rule-16 violation — the same reading AP-Flow relies on for its own
 * documents FK.
 */

/* ------------------------------------------------------------- corpus */

export const TAXGUARD_JURISDICTIONS = ['IN', 'US', 'UK', 'CA', 'AU', 'OTHER'] as const;
export type TaxGuardJurisdiction = (typeof TAXGUARD_JURISDICTIONS)[number];

export const TAXGUARD_CORPUS_STATUSES = ['PENDING', 'PARSING', 'EMBEDDING', 'READY', 'FAILED'] as const;
export type TaxGuardCorpusStatus = (typeof TAXGUARD_CORPUS_STATUSES)[number];

/** The one place a corpus document's lifecycle is written down (guardrails
 *  rule 10). READY and FAILED are both terminal — there is no in-place
 *  re-ingest; a re-ingest creates a new corpus document row instead. */
export const TAXGUARD_CORPUS_TRANSITIONS = {
  PENDING: ['PARSING', 'FAILED'],
  PARSING: ['EMBEDDING', 'FAILED'],
  EMBEDDING: ['READY', 'FAILED'],
  READY: [],
  FAILED: [],
} as const satisfies Record<TaxGuardCorpusStatus, readonly TaxGuardCorpusStatus[]>;

export function canTransitionCorpus(from: TaxGuardCorpusStatus, to: TaxGuardCorpusStatus): boolean {
  return (TAXGUARD_CORPUS_TRANSITIONS[from] as readonly TaxGuardCorpusStatus[]).includes(to);
}

export interface TaxGuardCorpusDocument {
  id: string;
  documentId: string;
  title: string;
  jurisdiction: TaxGuardJurisdiction;
  actYear: number | null;
  status: TaxGuardCorpusStatus;
  chunkCount: number;
  errorMessage: string | null;
  ingestedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

/**
 * A chunk as returned across the API boundary. Deliberately carries NO
 * `embedding` field — a 1024-float vector must never cross into a client
 * response.
 */
export interface TaxGuardChunk {
  id: string;
  corpusDocumentId: string;
  ordinal: number;
  citation: string;
  heading: string | null;
  content: string;
  tokenEstimate: number;
}

/* ---------------------------------------------------------- questions */

export interface TaxGuardCitation {
  chunkId: string;
  citation: string;
  corpusDocumentTitle: string;
  /** 0-1, cosine similarity at retrieval time. */
  score: number;
}

/** A chunk plus its retrieval score, as retrievalService returns it —
 *  internal to the server, never returned to a client directly. */
export interface RetrievedChunk {
  id: string;
  corpusDocumentId: string;
  corpusDocumentTitle: string;
  citation: string;
  heading: string | null;
  content: string;
  score: number;
}

/**
 * A question as returned across the API boundary. Deliberately omits
 * `redactedQuestion` and `retrievedChunkIds` — both are internal. The API
 * returns the user's own `questionText`, never the redacted form.
 */
export interface TaxGuardQuestion {
  id: string;
  questionText: string;
  jurisdiction: TaxGuardJurisdiction;
  answerText: string;
  citations: TaxGuardCitation[];
  model: string;
  latencyMs: number;
  createdByName: string | null;
  createdAt: string;
}
