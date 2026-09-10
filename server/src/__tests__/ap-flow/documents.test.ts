import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import {
  addMember,
  clearStorage,
  createUserWithOrg,
  loginAgent,
  resetTables,
} from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const DOCS_BASE = '/api/v1/documents';
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
const CSV_BYTES = Buffer.from('date,amount\n2026-01-01,100.00\n');

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('ap-flow documents API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    orgB = carol.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
    await addMember(orgA, userB.id, 'ADMIN');
    await addMember(orgB, userB.id, 'ADMIN');

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  /** Uploads a PDF into the vault as userA and returns its vault document id. */
  async function uploadPdfAsA(): Promise<string> {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(DOCS_BASE).attach('file', PDF_BYTES, 'invoice.pdf');
    expect(res.status).toBe(201);
    return res.body.document.id as string;
  }

  it('registers a PDF vault document and returns 201 with status PENDING', async () => {
    const documentId = await uploadPdfAsA();
    const agent = await loginAgent(app, userA);
    const res = await agent.post(AP_FLOW_BASE).send({ documentId });

    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('PENDING');
    expect(res.body.document.pageCount).toBe(null);
  });

  it('registering the same document twice returns 409 the second time', async () => {
    const documentId = await uploadPdfAsA();
    const agent = await loginAgent(app, userA);
    const first = await agent.post(AP_FLOW_BASE).send({ documentId });
    expect(first.status).toBe(201);

    const second = await agent.post(AP_FLOW_BASE).send({ documentId });
    expect(second.status).toBe(409);
  });

  it('refuses a CSV vault document with 422', async () => {
    const agent = await loginAgent(app, userA);
    const upload = await agent.post(DOCS_BASE).attach('file', CSV_BYTES, 'statement.csv');
    expect(upload.status).toBe(201);

    const res = await agent.post(AP_FLOW_BASE).send({ documentId: upload.body.document.id });
    expect(res.status).toBe(422);
  });

  it('returns 404 for a syntactically valid but unknown document id', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(AP_FLOW_BASE).send({ documentId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-UUID documentId', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(AP_FLOW_BASE).send({ documentId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('cross-tenant: org B cannot GET org A document by id (404, not 403)', async () => {
    const documentId = await uploadPdfAsA();
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(AP_FLOW_BASE).send({ documentId });
    const apFlowDocId = created.body.document.id as string;

    const agentB = await loginAgent(app, userB);
    await switchTo(agentB, orgB);
    const res = await agentB.get(`${AP_FLOW_BASE}/${apFlowDocId}`);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('document');
  });

  it('cross-tenant: org B cannot register a documentId belonging to org A (404)', async () => {
    const documentId = await uploadPdfAsA();
    const agentB = await loginAgent(app, userB);
    await switchTo(agentB, orgB);
    const res = await agentB.post(AP_FLOW_BASE).send({ documentId });

    expect(res.status).toBe(404);
  });

  it('cross-tenant: org B list does not contain org A document', async () => {
    const documentId = await uploadPdfAsA();
    const agentA = await loginAgent(app, userA);
    await agentA.post(AP_FLOW_BASE).send({ documentId });

    const agentB = await loginAgent(app, userB);
    await switchTo(agentB, orgB);
    const res = await agentB.get(AP_FLOW_BASE);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.documents).toEqual([]);
  });

  it('cross-tenant: org B cannot fetch a page image for an org A document', async () => {
    const documentId = await uploadPdfAsA();
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(AP_FLOW_BASE).send({ documentId });
    const apFlowDocId = created.body.document.id as string;

    const agentB = await loginAgent(app, userB);
    await switchTo(agentB, orgB);
    const res = await agentB.get(`${AP_FLOW_BASE}/${apFlowDocId}/pages/1/image`);

    expect(res.status).toBe(404);
  });

  it('VIEWER can list but cannot register a document', async () => {
    const documentId = await uploadPdfAsA();
    const agentViewer = await loginAgent(app, userViewer);
    await switchTo(agentViewer, orgA);

    const listRes = await agentViewer.get(AP_FLOW_BASE);
    expect(listRes.status).toBe(200);

    const createRes = await agentViewer.post(AP_FLOW_BASE).send({ documentId });
    expect(createRes.status).toBe(403);
  });

  it('ACCOUNTANT can register a document', async () => {
    const documentId = await uploadPdfAsA();
    const agentAccountant = await loginAgent(app, userAccountant);
    await switchTo(agentAccountant, orgA);
    const res = await agentAccountant.post(AP_FLOW_BASE).send({ documentId });

    expect(res.status).toBe(201);
  });

  it('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get(AP_FLOW_BASE);
    expect(res.status).toBe(401);
  });

  it('re-extract on a PENDING document returns 409 (PENDING -> PENDING is not an edge)', async () => {
    const documentId = await uploadPdfAsA();
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(AP_FLOW_BASE).send({ documentId });
    const apFlowDocId = created.body.document.id as string;

    const res = await agentA.post(`${AP_FLOW_BASE}/${apFlowDocId}/reextract`);
    expect(res.status).toBe(409);
  });

  it('GET /ap-flow/documents/:id never returns an ocrText key', async () => {
    const documentId = await uploadPdfAsA();
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(AP_FLOW_BASE).send({ documentId });
    const apFlowDocId = created.body.document.id as string;

    const res = await agentA.get(`${AP_FLOW_BASE}/${apFlowDocId}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('ocrText');
  });
});
