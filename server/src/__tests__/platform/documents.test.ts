import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { MAX_UPLOAD_BYTES } from '../../config/constants.js';

const app = createApp();
const BASE = '/api/v1/documents';

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
const ELF_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('documents API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let userC: SeededUser;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    orgA = userA.orgId;
    orgB = userC.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
    await addMember(orgA, userB.id, 'ADMIN');
    await addMember(orgB, userB.id, 'ADMIN');

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  it('uploads a PDF and returns 201 with the sha256', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.document.mimeType).toBe('application/pdf');
    expect(res.body.document.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-uploading identical bytes returns 200 and the same document id', async () => {
    const agent = await loginAgent(app, userA);
    const first = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
    const second = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice-again.pdf');

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.document.id).toBe(first.body.document.id);
  });

  it('two orgs uploading identical bytes get two distinct documents', async () => {
    const agentA = await loginAgent(app, userA);
    const agentC = await loginAgent(app, userC);

    const a = await agentA.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
    const c = await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    expect(a.body.created).toBe(true);
    expect(c.body.created).toBe(true);
    expect(a.body.document.id).not.toBe(c.body.document.id);
  });

  it('refuses an ELF renamed invoice.pdf with 415', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).attach('file', ELF_BYTES, 'invoice.pdf');

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('Unsupported file type. Allowed: PDF, PNG, JPEG, CSV');
  });

  it('refuses a file over the size cap with 413', async () => {
    const agent = await loginAgent(app, userA);
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(MAX_UPLOAD_BYTES, 0x41),
    ]);
    const res = await agent.post(BASE).attach('file', oversized, 'huge.pdf');

    expect(res.status).toBe(413);
  });

  it('refuses a request with no file with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE);

    expect(res.status).toBe(400);
  });

  it('refuses an upload from a VIEWER with 403', async () => {
    const agent = await switchTo(await loginAgent(app, userViewer), orgA);
    const res = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    expect(res.status).toBe(403);
  });

  it("lists only the caller's own organization's documents", async () => {
    const agentA = await loginAgent(app, userA);
    const agentC = await loginAgent(app, userC);

    await agentA.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
    await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const list = await agentA.get(BASE);
    expect(list.status).toBe(200);
    expect(list.body.documents).toHaveLength(1);
  });

  it('paginates with totalCount and totalPages', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).attach('file', Buffer.from('%PDF-1.7\none\n'), 'one.pdf');
    await agent.post(BASE).attach('file', Buffer.from('%PDF-1.7\ntwo\n'), 'two.pdf');
    await agent.post(BASE).attach('file', Buffer.from('%PDF-1.7\nthree\n'), 'three.pdf');

    const res = await agent.get(`${BASE}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.totalCount).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it('downloads the exact bytes that were uploaded', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const res = await agent
      .get(`${BASE}/${created.body.document.id}/file`)
      .responseType('blob' as unknown as string);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as ArrayBuffer).equals(PDF_BYTES)).toBe(true);
  });

  it('download sets Content-Disposition attachment and nosniff', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const res = await agent.get(`${BASE}/${created.body.document.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it("GET /documents/:id with another org's id returns 404", async () => {
    const agentC = await loginAgent(app, userC);
    const created = await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${BASE}/${created.body.document.id as string}`);
    expect(res.status).toBe(404);
  });

  it("GET /documents/:id/file with another org's id returns 404", async () => {
    const agentC = await loginAgent(app, userC);
    const created = await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${BASE}/${created.body.document.id as string}/file`);
    expect(res.status).toBe(404);
  });

  it("DELETE /documents/:id with another org's id returns 404", async () => {
    const agentC = await loginAgent(app, userC);
    const created = await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const agentA = await loginAgent(app, userA);
    const res = await agentA.delete(`${BASE}/${created.body.document.id as string}`);
    expect(res.status).toBe(404);
  });

  it('DELETE by an ACCOUNTANT returns 403', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await ownerAgent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const accountantAgent = await switchTo(await loginAgent(app, userAccountant), orgA);
    const res = await accountantAgent.delete(`${BASE}/${created.body.document.id as string}`);
    expect(res.status).toBe(403);
  });

  it('DELETE an unlinked document returns 204 and it disappears from the list', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

    const del = await agent.delete(`${BASE}/${created.body.document.id as string}`);
    expect(del.status).toBe(204);

    const getRes = await agent.get(`${BASE}/${created.body.document.id as string}`);
    expect(getRes.status).toBe(404);
  });

  describe('attachments', () => {
    it('attaches a document to a ledger-core invoice', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const res = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      expect(res.status).toBe(201);
      expect(res.body.link.appSlug).toBe('ledger-core');
      expect(res.body.link.entityType).toBe('invoice');
    });

    it('attaching twice to the same entity returns 409', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
      const entityId = randomUUID();
      const body = { appSlug: 'ledger-core', entityType: 'invoice', entityId };

      await agent.post(`${BASE}/${created.body.document.id as string}/links`).send(body);
      const res = await agent.post(`${BASE}/${created.body.document.id as string}/links`).send(body);

      expect(res.status).toBe(409);
    });

    it('refuses an unknown app slug with 422', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const res = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'not-a-real-app', entityType: 'invoice', entityId: randomUUID() });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('Unknown app slug');
    });

    it('refuses an entity type the app does not declare with 422', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const res = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'spaceship', entityId: randomUUID() });

      expect(res.status).toBe(422);
    });

    it('refuses a non-UUID entityId with 400', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const res = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });

    it('lists documents filtered by entity', async () => {
      const agent = await loginAgent(app, userA);
      const attached = await agent.post(BASE).attach('file', PDF_BYTES, 'attached.pdf');
      await agent.post(BASE).attach('file', Buffer.from('%PDF-1.7\nother\n'), 'other.pdf');

      const entityId = randomUUID();
      await agent
        .post(`${BASE}/${attached.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId });

      const res = await agent.get(
        `${BASE}?appSlug=ledger-core&entityType=invoice&entityId=${entityId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.documents).toHaveLength(1);
      expect(res.body.documents[0].id).toBe(attached.body.document.id);
    });

    it('GET /documents/:id includes its links', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
      await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      const res = await agent.get(`${BASE}/${created.body.document.id as string}`);
      expect(res.body.document.links).toHaveLength(1);
      expect(res.body.document.linkCount).toBe(1);
    });

    it('DELETE /documents/:id while linked returns 409', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
      await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      const res = await agent.delete(`${BASE}/${created.body.document.id as string}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Detach this document from every record before deleting it');
    });

    it('detaching then deleting succeeds', async () => {
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
      const link = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      const detach = await agent.delete(
        `${BASE}/${created.body.document.id as string}/links/${link.body.link.id as string}`,
      );
      expect(detach.status).toBe(204);

      const del = await agent.delete(`${BASE}/${created.body.document.id as string}`);
      expect(del.status).toBe(204);
    });

    it('attach by a VIEWER returns 403', async () => {
      const ownerAgent = await loginAgent(app, userA);
      const created = await ownerAgent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const viewerAgent = await switchTo(await loginAgent(app, userViewer), orgA);
      const res = await viewerAgent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      expect(res.status).toBe(403);
    });

    it("attaching another org's document returns 404", async () => {
      const agentC = await loginAgent(app, userC);
      const created = await agentC.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const agentA = await loginAgent(app, userA);
      const res = await agentA
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      expect(res.status).toBe(404);
    });

    it("detaching another org's link returns 404", async () => {
      const agentA = await loginAgent(app, userA);
      const created = await agentA.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');
      const link = await agentA
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      const agentC = await loginAgent(app, userC);
      const res = await agentC.delete(
        `${BASE}/${created.body.document.id as string}/links/${link.body.link.id as string}`,
      );
      expect(res.status).toBe(404);
    });

    it('an entity id from another org can be linked, and that is documented as tolerated', async () => {
      // document_links.entity_id carries NO foreign key: checking it would
      // mean the platform reading an app's own tables, which guardrails
      // rule 16 forbids. A dangling or cross-tenant entity id is accepted
      // and left to the consuming app.
      const agent = await loginAgent(app, userA);
      const created = await agent.post(BASE).attach('file', PDF_BYTES, 'invoice.pdf');

      const res = await agent
        .post(`${BASE}/${created.body.document.id as string}/links`)
        .send({ appSlug: 'ledger-core', entityType: 'invoice', entityId: randomUUID() });

      expect(res.status).toBe(201);
    });
  });
});
