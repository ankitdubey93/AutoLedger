import { pool } from '../../db/connect.js';
import { retrieve } from './retrievalService.js';
import { answer } from './answerService.js';
import type { AnswerClient } from './answerService.js';
import type { EmbeddingsClient } from './embeddingService.js';
import { redactText } from '../../utils/pii.js';
import { ApiError } from '../../utils/apiError.js';
import type { TaxGuardCitation, TaxGuardJurisdiction, TaxGuardQuestion } from '../../types/taxguard.js';

/**
 * TaxGuard AI (Phase 16) — the ask pipeline. `ask` redacts the question
 * BEFORE retrieval or answering ever run — the order below is the
 * compliance claim this phase makes, and it is proven by
 * __tests__/taxguard/questions.test.ts capturing what each stubbed client
 * actually receives.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface QuestionRow {
  id: string;
  question_text: string;
  jurisdiction: TaxGuardJurisdiction;
  answer_text: string;
  citations: TaxGuardCitation[];
  model: string;
  latency_ms: number;
  created_by_name: string | null;
  created_at: Date;
}

const QUESTION_SELECT = `
  SELECT q.id, q.question_text, q.jurisdiction, q.answer_text, q.citations,
         q.model, q.latency_ms,
         creator.name AS created_by_name,
         q.created_at
    FROM taxguard_questions q
    LEFT JOIN users creator ON creator.id = q.created_by
`;

function toQuestion(row: QuestionRow): TaxGuardQuestion {
  return {
    id: row.id,
    questionText: row.question_text,
    jurisdiction: row.jurisdiction,
    answerText: row.answer_text,
    citations: row.citations,
    model: row.model,
    latencyMs: row.latency_ms,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listQuestions(orgId: string, limit?: number): Promise<TaxGuardQuestion[]> {
  const effectiveLimit = Math.min(MAX_LIST_LIMIT, Math.max(1, limit ?? DEFAULT_LIST_LIMIT));
  const { rows } = await pool.query<QuestionRow>(
    `${QUESTION_SELECT} WHERE q.org_id = $1 ORDER BY q.created_at DESC LIMIT $2`,
    [orgId, effectiveLimit],
  );
  return rows.map(toQuestion);
}

export async function getQuestionById(orgId: string, id: string): Promise<TaxGuardQuestion> {
  try {
    const { rows } = await pool.query<QuestionRow>(`${QUESTION_SELECT} WHERE q.org_id = $1 AND q.id = $2`, [
      orgId,
      id,
    ]);
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Question not found');
    return toQuestion(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Question not found');
    }
    throw err;
  }
}

export async function deleteQuestion(orgId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM taxguard_questions WHERE org_id = $1 AND id = $2', [
    orgId,
    id,
  ]);
  if (rowCount === 0) throw new ApiError(404, 'Question not found');
}

export interface AskInput {
  questionText: string;
  jurisdiction: TaxGuardJurisdiction;
}

export async function ask(
  orgId: string,
  userId: string,
  input: AskInput,
  deps?: { embeddings?: EmbeddingsClient; answers?: AnswerClient },
): Promise<TaxGuardQuestion> {
  const started = Date.now();

  // Redact first. Nothing derived from the raw questionText may be sent
  // anywhere after this point — this ordering is the phase's compliance
  // claim.
  const redactedQuestion = redactText(input.questionText);

  const chunks = await retrieve(orgId, redactedQuestion, input.jurisdiction, undefined, deps?.embeddings);
  const result = await answer(redactedQuestion, chunks, deps?.answers);

  const latencyMs = Date.now() - started;
  const retrievedChunkIds = chunks.map((chunk) => chunk.id);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO taxguard_questions
       (org_id, question_text, redacted_question, jurisdiction, answer_text, citations,
        model, retrieved_chunk_ids, latency_ms, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING id`,
    [
      orgId,
      input.questionText,
      redactedQuestion,
      input.jurisdiction,
      result.answerText,
      JSON.stringify(result.citations),
      result.model,
      retrievedChunkIds,
      latencyMs,
      userId,
    ],
  );
  const inserted = rows[0];
  if (inserted === undefined) throw new Error('ask: insert returned no row');

  return getQuestionById(orgId, inserted.id);
}
