import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, clearStorage, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 19 — POST /capture/documents/upload, straight from Capture's own
 * page: vault + register in one call. Every case here proves the
 * mime-type/role gates it shares with the two-step flow, plus the
 * duplicate-content capture behaviour a later change (2026-09-18) added:
 * a repeat upload of identical bytes is a NEW, visible DUPLICATE row now,
 * not a silent merge into the original.
 */

const app = createApp();
const CAPTURE_BASE = '/api/v1/capture/documents';

const CSV_BYTES = Buffer.from('date,amount\n2026-01-01,100.00\n');
const JUNK_BYTES = Buffer.from('not a real file at all');

async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
}

describe('capture direct upload API', () => {
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

  it('uploading a PNG vaults it and creates a PENDING Capture document in one call', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();
    const res = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');

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

  it('re-uploading identical bytes creates a second, DUPLICATE row instead of merging silently', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();

    const first = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(first.status).toBe(201);
    expect(first.body.document.status).toBe('PENDING');

    const second = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt-again.png');
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(true);
    expect(second.body.document.id).not.toBe(first.body.document.id);
    expect(second.body.document.status).toBe('DUPLICATE');
    expect(second.body.document.duplicateOfId).toBe(first.body.document.id);
    expect(second.body.document.duplicateOfFilename).toBe('receipt.png');

    // Both rows point at the SAME vault document — the vault itself still
    // dedupes by content hash; only Capture's own registration doesn't.
    const { rows: vaultRows } = await pool.query('SELECT id FROM documents WHERE org_id = $1', [orgA]);
    expect(vaultRows).toHaveLength(1);
    const { rows: apRows } = await pool.query(
      'SELECT status FROM ap_flow_documents WHERE org_id = $1 ORDER BY created_at',
      [orgA],
    );
    expect(apRows.map((r: { status: string }) => r.status)).toEqual(['PENDING', 'DUPLICATE']);
  });

  it('the duplicate row is not queued for extraction — no AI spend on an unconfirmed re-submission', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();

    await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');
    const second = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt-again.png');
    const duplicateId = second.body.document.id as string;

    const { rows } = await pool.query<{ processed_at: Date | null; page_count: number | null }>(
      'SELECT processed_at, page_count FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, duplicateId],
    );
    expect(rows[0]?.processed_at).toBeNull();
    expect(rows[0]?.page_count).toBeNull();
  });

  it('pushing a duplicate through re-enters the normal pipeline via re-extract', async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();

    await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');
    const second = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt-again.png');
    const duplicateId = second.body.document.id as string;

    const reextractRes = await agent.post(`${CAPTURE_BASE}/${duplicateId}/reextract`);
    expect(reextractRes.status).toBe(200);
    expect(reextractRes.body.document.status).toBe('PENDING');
    // duplicateOfId is left in place as history — pushing it through doesn't
    // erase where it came from, it just stops treating it specially.
    expect(reextractRes.body.document.duplicateOfId).not.toBeNull();
  });

  it('a CSV upload returns 422 and stores nothing', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', CSV_BYTES, 'statement.csv');
    expect(res.status).toBe(422);

    const { rows } = await pool.query('SELECT id FROM documents WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('an unrecognised file returns 415', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', JUNK_BYTES, 'mystery.bin');
    expect(res.status).toBe(415);
  });

  it('a VIEWER cannot upload', async () => {
    const agent = await loginAgent(app, userViewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const png = await pngBytes();
    const res = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(res.status).toBe(403);
  });

  it("an upload is visible only to the uploader's organization", async () => {
    const agent = await loginAgent(app, userA);
    const png = await pngBytes();
    const uploadRes = await agent.post(`${CAPTURE_BASE}/upload`).attach('file', png, 'receipt.png');
    expect(uploadRes.status).toBe(201);
    const captureDocId = uploadRes.body.document.id as string;

    const carol = await createUserWithOrg({ label: 'carol2', orgName: 'Org Carol' });
    const carolAgent = await loginAgent(app, carol);
    const listRes = await carolAgent.get(CAPTURE_BASE);
    expect(listRes.body.totalCount).toBe(0);

    const getRes = await carolAgent.get(`${CAPTURE_BASE}/${captureDocId}`);
    expect(getRes.status).toBe(404);
  });
});
