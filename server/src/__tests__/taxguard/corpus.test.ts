import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { handleTaxGuardEmbed } from '../../queue/handlers/taxguardEmbedHandler.js';
import { getCorpusDocumentById } from '../../services/taxguard/corpusService.js';
import type { EmbeddingsClient } from '../../services/taxguard/embeddingService.js';
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
 * TaxGuard AI corpus API + ingestion handler (Phase 16). Integration tier,
 * real PostgreSQL. The ingestion handler is called directly, never through
 * BullMQ — the same posture ap-flow/pipeline.test.ts and
 * boarddeck/decks.test.ts established. Includes this module's own
 * cross-tenant isolation suite (rule 15).
 *
 * No test in this file makes a network call or requires VOYAGE_API_KEY —
 * every embedding goes through a stub EmbeddingsClient.
 */

const app = createApp();
const DOCS = '/api/v1/documents';
const CORPUS = '/api/v1/taxguard/corpus';

const TAX_ACT_PDF = buildTestPdf([
  'Section 1. Short title',
  'This Act may be called the Test Act.',
  'Section 2. Definitions',
  'In this Act, unless the context otherwise requires...',
]);

function stubVector(): number[] {
  return Array.from({ length: 1024 }, () => 0.01);
}

function stubEmbeddingsClient(): EmbeddingsClient {
  return {
    embed: (texts) => Promise.resolve(texts.map(() => stubVector())),
  };
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

async function uploadTaxAct(agent: Awaited<ReturnType<typeof loginAgent>>): Promise<string> {
  const res = await agent.post(DOCS).attach('file', TAX_ACT_PDF, 'test-act.pdf');
  if (res.status !== 201) throw new Error(`fixture: upload failed ${String(res.status)} ${res.text}`);
  return res.body.document.id as string;
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

describe('TaxGuard corpus API', () => {
  it('POST /corpus creates a PENDING row', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);

    const res = await agent.post(CORPUS).send({
      documentId,
      title: 'Test Act, 2026',
      jurisdiction: 'IN',
      actYear: 2026,
    });

    expect(res.status).toBe(201);
    expect(res.body.corpusDocument.status).toBe('PENDING');
    expect(res.body.corpusDocument.chunkCount).toBe(0);
  });

  it('POST with a non-PDF document id returns 400', async () => {
    const agent = await loginAgent(app, userA);
    const csvUpload = await agent.post(DOCS).attach('file', Buffer.from('a,b,c\n1,2,3'), 'data.csv');
    const documentId = csvUpload.body.document.id as string;

    const res = await agent.post(CORPUS).send({
      documentId,
      title: 'Not a PDF',
      jurisdiction: 'IN',
      actYear: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error ?? res.text).toContain('Corpus documents must be PDF');
  });

  it('POST the same documentId twice returns 409 on the second call', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const input = { documentId, title: 'Test Act', jurisdiction: 'IN', actYear: null };

    const first = await agent.post(CORPUS).send(input);
    expect(first.status).toBe(201);

    const second = await agent.post(CORPUS).send(input);
    expect(second.status).toBe(409);
  });

  it('POST as VIEWER returns 403', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);

    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await switchTo(viewerAgent, orgA);

    const res = await viewerAgent.post(CORPUS).send({
      documentId,
      title: 'Test Act',
      jurisdiction: 'IN',
      actYear: null,
    });
    expect(res.status).toBe(403);
  });

  it('POST unauthenticated returns 401', async () => {
    const res = await request(app)
      .post(CORPUS)
      .send({ documentId: '00000000-0000-0000-0000-000000000000', title: 'x', jurisdiction: 'IN', actYear: null });
    expect(res.status).toBe(401);
  });

  it("GET /corpus/:id with org B's id under org A's token returns 404", async () => {
    const agentB = await loginAgent(app, userB);
    const documentIdB = await uploadTaxAct(agentB);
    const createdB = await agentB
      .post(CORPUS)
      .send({ documentId: documentIdB, title: 'Act B', jurisdiction: 'IN', actYear: null });
    const corpusIdB = createdB.body.corpusDocument.id as string;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${CORPUS}/${corpusIdB}`);
    expect(res.status).toBe(404);
  });

  it("GET /corpus/:id/chunks with org B's id under org A's token returns 404 with no chunk content", async () => {
    const agentB = await loginAgent(app, userB);
    const documentIdB = await uploadTaxAct(agentB);
    const createdB = await agentB
      .post(CORPUS)
      .send({ documentId: documentIdB, title: 'Act B', jurisdiction: 'IN', actYear: null });
    const corpusIdB = createdB.body.corpusDocument.id as string;
    await handleTaxGuardEmbed({ orgId: orgB, corpusDocumentId: corpusIdB }, stubEmbeddingsClient());

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${CORPUS}/${corpusIdB}/chunks`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Short title');
  });

  it("GET /corpus lists only the caller's org", async () => {
    const agentA = await loginAgent(app, userA);
    const docA1 = await uploadTaxAct(agentA);
    await agentA.post(DOCS).attach('file', TAX_ACT_PDF, 'test-act-2.pdf');
    const uploadA2 = await agentA.post(DOCS).attach('file', buildTestPdf(['Section 9. Other']), 'test-act-3.pdf');
    await agentA.post(CORPUS).send({ documentId: docA1, title: 'A1', jurisdiction: 'IN', actYear: null });
    await agentA
      .post(CORPUS)
      .send({ documentId: uploadA2.body.document.id, title: 'A2', jurisdiction: 'IN', actYear: null });

    const agentB = await loginAgent(app, userB);
    for (let i = 0; i < 3; i++) {
      const upload = await agentB.post(DOCS).attach('file', buildTestPdf([`Section ${String(i)}. X`]), `b${String(i)}.pdf`);
      await agentB
        .post(CORPUS)
        .send({ documentId: upload.body.document.id, title: `B${String(i)}`, jurisdiction: 'IN', actYear: null });
    }

    const listA = await agentA.get(CORPUS);
    expect(listA.body.corpusDocuments).toHaveLength(2);
    const idsA = (listA.body.corpusDocuments as { id: string }[]).map((c) => c.id);
    const listB = await agentB.get(CORPUS);
    const idsB = (listB.body.corpusDocuments as { id: string }[]).map((c) => c.id);
    for (const id of idsB) expect(idsA).not.toContain(id);
  });

  it('DELETE /corpus/:id as ACCOUNTANT returns 403', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;

    const accountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);

    const res = await accountantAgent.delete(`${CORPUS}/${corpusId}`);
    expect(res.status).toBe(403);
  });

  it('DELETE /corpus/:id as OWNER returns 204, and a follow-up GET returns 404', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;

    const res = await agent.delete(`${CORPUS}/${corpusId}`);
    expect(res.status).toBe(204);

    const followUp = await agent.get(`${CORPUS}/${corpusId}`);
    expect(followUp.status).toBe(404);
  });

  it('DELETE cascades its chunks', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;
    await handleTaxGuardEmbed({ orgId: orgA, corpusDocumentId: corpusId }, stubEmbeddingsClient());

    await agent.delete(`${CORPUS}/${corpusId}`);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM taxguard_chunks WHERE corpus_document_id = $1',
      [corpusId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('handleTaxGuardEmbed with a stub client drives PENDING to READY', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;

    await handleTaxGuardEmbed({ orgId: orgA, corpusDocumentId: corpusId }, stubEmbeddingsClient());

    const doc = await getCorpusDocumentById(orgA, corpusId);
    expect(doc.status).toBe('READY');
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.ingestedAt).not.toBeNull();
  });

  it('handleTaxGuardEmbed run with the wrong orgId touches nothing', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;

    // orgB running the handler against orgA's corpus document id.
    await handleTaxGuardEmbed({ orgId: orgB, corpusDocumentId: corpusId }, stubEmbeddingsClient());

    const doc = await getCorpusDocumentById(orgA, corpusId);
    expect(doc.status).toBe('PENDING');
    expect(doc.chunkCount).toBe(0);
  });

  it('a failing embeddings client marks the row FAILED and rethrows', async () => {
    const agent = await loginAgent(app, userA);
    const documentId = await uploadTaxAct(agent);
    const created = await agent.post(CORPUS).send({ documentId, title: 'Act', jurisdiction: 'IN', actYear: null });
    const corpusId = created.body.corpusDocument.id as string;

    const failingClient: EmbeddingsClient = {
      embed: () => Promise.reject(new Error('provider down')),
    };

    await expect(handleTaxGuardEmbed({ orgId: orgA, corpusDocumentId: corpusId }, failingClient)).rejects.toThrow(
      'provider down',
    );

    const doc = await getCorpusDocumentById(orgA, corpusId);
    expect(doc.status).toBe('FAILED');
    expect(doc.errorMessage).not.toBeNull();
  });
});
