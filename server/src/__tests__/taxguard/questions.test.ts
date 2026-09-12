import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { handleTaxGuardEmbed } from '../../queue/handlers/taxguardEmbedHandler.js';
import { createCorpusDocument, deleteCorpusDocument } from '../../services/taxguard/corpusService.js';
import { ask, deleteQuestion } from '../../services/taxguard/questionService.js';
import type { EmbeddingsClient } from '../../services/taxguard/embeddingService.js';
import type { AnswerClient } from '../../services/taxguard/answerService.js';
import {
  addMember,
  buildTestPdf,
  clearStorage,
  createUserWithOrg,
  loginAgent,
  resetTables,
} from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * TaxGuard AI's ask pipeline (Phase 16). Integration tier, real PostgreSQL.
 *
 * `questionService.ask` has no queue and no async job — it runs synchronously
 * inside POST /questions, so unlike BoardDeck's deck generation or AP-Flow's
 * extraction there is no queue-handler seam for the HTTP route to take an
 * injected client through. Cases that need a stubbed EmbeddingsClient/
 * AnswerClient therefore call `ask()` directly — the same posture
 * boarddeck/decks.test.ts takes calling `handleBoardDeckGenerate` directly
 * and ap-flow/pipeline.test.ts takes calling its pipeline function directly,
 * rather than through their respective HTTP/queue surface. Plain CRUD,
 * validation, role and tenancy behaviour is proven through supertest, since
 * none of that reaches a model.
 *
 * No test in this file makes a network call or requires VOYAGE_API_KEY or
 * ANTHROPIC_API_KEY.
 */

const app = createApp();
const DOCS = '/api/v1/documents';
const QUESTIONS = '/api/v1/taxguard/questions';

const CARD_NUMBER = '4111 1111 1111 1111'; // Luhn-valid

const TAX_ACT_PDF = buildTestPdf([
  'Section 1. Short title',
  'This Act may be called the Test Act.',
  'Section 80C. Deductions',
  'A taxpayer may claim a deduction for specified investments.',
]);

function stubVector(): number[] {
  return Array.from({ length: 1024 }, () => 0.02);
}

function stubEmbeddingsClient(captured?: string[][]): EmbeddingsClient {
  return {
    embed: (texts) => {
      captured?.push(texts);
      return Promise.resolve(texts.map(() => stubVector()));
    },
  };
}

interface CapturedAnswerCall {
  body: unknown;
}

function stubAnswerClient(captured: CapturedAnswerCall[], citedSources: number[] = [1]): AnswerClient {
  return {
    messages: {
      create: (body) => {
        captured.push({ body });
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              name: 'record_answer',
              input: { answer: 'A deduction is available under Section 80C. [1]', cited_sources: citedSources },
            },
          ],
        });
      },
    },
  };
}

function countingAnswerClient(counter: { calls: number }): AnswerClient {
  return {
    messages: {
      create: () => {
        counter.calls += 1;
        return Promise.resolve({
          content: [{ type: 'tool_use', name: 'record_answer', input: { answer: 'x', cited_sources: [] } }],
        });
      },
    },
  };
}

function bodyText(body: unknown): string {
  return JSON.stringify(body);
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

/** Uploads a tax act, adds it to the corpus, and drives it to READY. */
async function seedReadyCorpus(orgId: string, userId: string): Promise<string> {
  const agent = await loginAgent(app, orgId === orgA ? userA : userB);
  const upload = await agent.post(DOCS).attach('file', TAX_ACT_PDF, 'act.pdf');
  const corpus = await createCorpusDocument(orgId, userId, {
    documentId: upload.body.document.id as string,
    title: 'Test Act, 2026',
    jurisdiction: 'IN',
    actYear: 2026,
  });
  await handleTaxGuardEmbed({ orgId, corpusDocumentId: corpus.id }, stubEmbeddingsClient());
  return corpus.id;
}

beforeEach(async () => {
  await resetTables();
  await clearStorage();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('TaxGuard ask pipeline', () => {
  it('returns an answer with citations', async () => {
    await seedReadyCorpus(orgA, userA.id);
    const answerCalls: CapturedAnswerCall[] = [];

    const question = await ask(
      orgA,
      userA.id,
      { questionText: 'Can I claim a deduction for my investments?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient(answerCalls) },
    );

    expect(question.answerText).toContain('Section 80C');
    expect(question.citations.length).toBeGreaterThanOrEqual(1);
  });

  it('the raw question never reaches the embeddings client', async () => {
    await seedReadyCorpus(orgA, userA.id);
    const captured: string[][] = [];

    await ask(
      orgA,
      userA.id,
      { questionText: `My card is ${CARD_NUMBER}, is it deductible?`, jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(captured), answers: stubAnswerClient([]) },
    );

    for (const batch of captured) {
      for (const text of batch) {
        expect(text).not.toContain(CARD_NUMBER);
      }
    }
  });

  it('the raw question never reaches the answer client', async () => {
    await seedReadyCorpus(orgA, userA.id);
    const answerCalls: CapturedAnswerCall[] = [];

    await ask(
      orgA,
      userA.id,
      { questionText: `My card is ${CARD_NUMBER}, is it deductible?`, jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient(answerCalls) },
    );

    expect(answerCalls).toHaveLength(1);
    expect(bodyText(answerCalls[0]?.body)).not.toContain(CARD_NUMBER);
  });

  it('the raw question IS stored for the asker\'s own history', async () => {
    await seedReadyCorpus(orgA, userA.id);

    const question = await ask(
      orgA,
      userA.id,
      { questionText: `My card is ${CARD_NUMBER}, is it deductible?`, jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    const { rows } = await pool.query<{ question_text: string; redacted_question: string }>(
      'SELECT question_text, redacted_question FROM taxguard_questions WHERE id = $1',
      [question.id],
    );
    expect(rows[0]?.question_text).toContain(CARD_NUMBER);
    expect(rows[0]?.redacted_question).not.toContain(CARD_NUMBER);
  });

  it('answer() is never called with zero chunks', async () => {
    // No corpus at all for this org — retrieval returns zero chunks.
    const counter = { calls: 0 };

    await expect(
      ask(
        orgA,
        userA.id,
        { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
        { embeddings: stubEmbeddingsClient(), answers: countingAnswerClient(counter) },
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(counter.calls).toBe(0);
  });

  it('retrieval never returns another org\'s chunks', async () => {
    await seedReadyCorpus(orgA, userA.id);
    await seedReadyCorpus(orgB, userB.id);

    const question = await ask(
      orgA,
      userA.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    for (const citation of question.citations) {
      const { rows } = await pool.query<{ org_id: string }>('SELECT org_id FROM taxguard_chunks WHERE id = $1', [
        citation.chunkId,
      ]);
      expect(rows[0]?.org_id).toBe(orgA);
    }
  });

  it('a question survives its cited chunk being deleted', async () => {
    const corpusId = await seedReadyCorpus(orgA, userA.id);
    const question = await ask(
      orgA,
      userA.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    await deleteCorpusDocument(orgA, corpusId);

    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${QUESTIONS}/${question.id}`);
    expect(res.status).toBe(200);
    expect(res.body.question.answerText).toBe(question.answerText);
    expect(res.body.question.citations).toEqual(question.citations);
  });
});

describe('TaxGuard questions API', () => {
  it('POST with a 2-char question returns 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(QUESTIONS).send({ questionText: 'hi', jurisdiction: 'IN' });
    expect(res.status).toBe(400);
  });

  it("GET /questions/:id with org B's id under org A's token returns 404", async () => {
    await seedReadyCorpus(orgB, userB.id);
    const questionB = await ask(
      orgB,
      userB.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${QUESTIONS}/${questionB.id}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('deduction');
  });

  it("GET /questions lists only the caller's org", async () => {
    await seedReadyCorpus(orgA, userA.id);
    await seedReadyCorpus(orgB, userB.id);
    const answers = stubAnswerClient([]);
    const embeddings = stubEmbeddingsClient();

    await ask(orgA, userA.id, { questionText: 'Question A1', jurisdiction: 'IN' }, { embeddings, answers });
    await ask(orgB, userB.id, { questionText: 'Question B1', jurisdiction: 'IN' }, { embeddings, answers });
    await ask(orgB, userB.id, { questionText: 'Question B2', jurisdiction: 'IN' }, { embeddings, answers });

    const agentA = await loginAgent(app, userA);
    const listA = await agentA.get(QUESTIONS);
    expect(listA.body.questions).toHaveLength(1);

    const agentB = await loginAgent(app, userB);
    const listB = await agentB.get(QUESTIONS);
    expect(listB.body.questions).toHaveLength(2);
  });

  it('DELETE as ACCOUNTANT returns 403', async () => {
    await seedReadyCorpus(orgA, userA.id);
    const question = await ask(
      orgA,
      userA.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    const accountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);

    const res = await accountantAgent.delete(`${QUESTIONS}/${question.id}`);
    expect(res.status).toBe(403);
  });

  it('DELETE as OWNER returns 204, and a follow-up GET returns 404', async () => {
    await seedReadyCorpus(orgA, userA.id);
    const question = await ask(
      orgA,
      userA.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    const agent = await loginAgent(app, userA);
    const res = await agent.delete(`${QUESTIONS}/${question.id}`);
    expect(res.status).toBe(204);

    const followUp = await agent.get(`${QUESTIONS}/${question.id}`);
    expect(followUp.status).toBe(404);
  });

  it('deleteQuestion 404s a cross-tenant id (service-level)', async () => {
    await seedReadyCorpus(orgB, userB.id);
    const questionB = await ask(
      orgB,
      userB.id,
      { questionText: 'Can I claim a deduction?', jurisdiction: 'IN' },
      { embeddings: stubEmbeddingsClient(), answers: stubAnswerClient([]) },
    );

    await expect(deleteQuestion(orgA, questionB.id)).rejects.toMatchObject({ status: 404 });
  });
});
