import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, clearStorage, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 19 — POST /ap-flow/documents/upload, straight from AP-Flow's own
 * page: vault + register in one call. Every case here proves the
 * mime-type/role gates it shares with the two-step flow, plus the new
 * idempotent-capture behaviour.
 */

const app = createApp();
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';

const CSV_BYTES = Buffer.from('date,amount\n2026-01-01,100.00\n');
const JUNK_BYTES = Buffer.from('not a real file at all');

async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
}

describe('ap-flow direct upload API', () => {
  let userA: SeededUser;
  let orgA: string;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  it('uploading a PNG vaults it and creates a PENDING AP-Flow document in one call', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();
    const res = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', png, 'receipt.png');

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.document.status).toBe('PENDING');

    const { rows: docRows } = await pool.query('SELECT id FROM documents WHERE org_id = $1', [orgA]);
    expect(docRows).toHaveLength(1);
    const { rows: apRows } = await pool.query('SELECT id FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    expect(apRows).toHaveLength(1);
    const { rows: linkRows } = await pool.query(
      "SELECT id FROM document_links WHERE org_id = $1 AND app_slug = 'ap-flow'",
      [orgA],
    );
    expect(linkRows).toHaveLength(1);
  });

  it('re-uploading identical bytes returns 200 with the same document', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();

    const first = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(first.status).toBe(201);

    const second = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', png, 'receipt-again.png');
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.document.id).toBe(first.body.document.id);

    const { rows } = await pool.query('SELECT id FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(1);
  });

  it('a CSV upload returns 422 and stores nothing', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', CSV_BYTES, 'statement.csv');
    expect(res.status).toBe(422);

    const { rows } = await pool.query('SELECT id FROM documents WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('an unrecognised file returns 415', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', JUNK_BYTES, 'mystery.bin');
    expect(res.status).toBe(415);
  });

  it('a VIEWER cannot upload', async () => {
    const agent = await loginAgent(app, userViewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const png = await pngBytes();
    const res = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(res.status).toBe(403);
  });

  it("an upload is visible only to the uploader's organization", async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();
    const uploadRes = await agent.post(`${AP_FLOW_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(uploadRes.status).toBe(201);
    const apFlowDocId = uploadRes.body.document.id as string;

    const carol = await createUserWithOrg({ label: 'carol2', orgName: 'Org Carol' });
    const carolAgent = await loginAgent(app, carol);
    const listRes = await carolAgent.get(AP_FLOW_BASE);
    expect(listRes.body.totalCount).toBe(0);

    const getRes = await carolAgent.get(`${AP_FLOW_BASE}/${apFlowDocId}`);
    expect(getRes.status).toBe(404);
  });
});
