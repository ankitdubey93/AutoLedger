import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { handleApFlowExtract } from '../../queue/handlers/apFlowExtractHandler.js';
import { getApFlowDocumentById } from '../../services/ap-flow/apFlowDocumentService.js';
import { vendorKeyOf } from '../../services/ap-flow/mappingService.js';
import type { OcrAdapter } from '../../services/redactionService.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import type { OcrPageResult } from '../../types/ap-flow.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import { addMember, clearStorage, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 19's auto-post gate, exercised through the real extraction handler
 * — real PostgreSQL, an injected vision stub, and HISTORY-tier account
 * mapping (a pre-seeded ap_flow_vendor_account_map row) so classification
 * never needs a classifier stub of its own.
 */

const app = createApp();
const DOCS_BASE = '/api/v1/documents';
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';
const SETTINGS_BASE = '/api/v1/ap-flow/settings';

function ocrFor(vendor: string): OcrAdapter {
  return () =>
    Promise.resolve<OcrPageResult>({
      width: 300,
      height: 150,
      text: `${vendor} Total 100.00`,
      words: [{ text: vendor, box: { x0: 10, y0: 10, x1: 60, y1: 30 }, confidence: 0.9 }],
    });
}

function stubVisionClient(invoiceNumber: string): VisionClient {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'record_invoice',
              input: {
                vendor_name: 'Acme Vendor',
                invoice_number: invoiceNumber,
                invoice_date: '2026-08-15',
                due_date: null,
                currency: 'USD',
                subtotal: '100.00',
                tax: '0.00',
                total: '100.00',
                line_items: [{ description: 'Office supplies', amount: '100.00' }],
                field_confidence: {
                  vendor_name: 0.99,
                  invoice_number: 0.99,
                  invoice_date: 0.99,
                  total: 0.99,
                },
              },
            },
          ],
        }),
    },
  };
}

async function accountIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
  return id;
}

describe('AP-Flow auto-post (Phase 19)', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
    await addMember(orgA, userB.id, 'ADMIN');
  });

  afterEach(async () => {
    await Promise.all(QUEUE_NAMES.map((name) => queues[name].obliterate({ force: true })));
  });

  afterAll(async () => {
    await closeQueues();
    await closePool();
  });

  /** Registers a document and seeds HISTORY-tier mapping for 'Acme Vendor' -> the given account. */
  async function registerDocument(orgId: string, agentUser: SeededUser, accountId: string): Promise<string> {
    const agent = await loginAgent(app, agentUser);
    const png = await sharp({
      create: { width: 300, height: 150, channels: 3, background: { r: 220, g: 220, b: 220 } },
    })
      .png()
      .toBuffer();
    const upload = await agent.post(DOCS_BASE).attach('file', png, 'receipt.png');
    expect(upload.status).toBe(201);

    const created = await agent.post(AP_FLOW_BASE).send({ documentId: upload.body.document.id });
    expect(created.status).toBe(201);

    await pool.query(
      `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id)
       VALUES ($1, $2, $3)`,
      [orgId, vendorKeyOf('Acme Vendor'), accountId],
    );

    return created.body.document.id as string;
  }

  it('GET /settings returns defaults for a fresh organization', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(SETTINGS_BASE);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      autoPostEnabled: false,
      autoPostMinConfidence: 0.9,
      autoPostMaxTotalCents: null,
      updatedAt: null,
    });
  });

  it('PUT /settings is refused for an ACCOUNTANT', async () => {
    const accountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const res = await agent.put(SETTINGS_BASE).send({ autoPostEnabled: true, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null });
    expect(res.status).toBe(403);
  });

  it('PUT /settings rejects a threshold below 0.5', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .put(SETTINGS_BASE)
      .send({ autoPostEnabled: true, autoPostMinConfidence: 0.4, autoPostMaxTotalCents: null });
    expect(res.status).toBe(400);
  });

  it('PUT /settings persists and GET reads it back', async () => {
    const agent = await loginAgent(app, userA);
    const putRes = await agent
      .put(SETTINGS_BASE)
      .send({ autoPostEnabled: true, autoPostMinConfidence: 0.85, autoPostMaxTotalCents: 500000 });
    expect(putRes.status).toBe(200);

    const getRes = await agent.get(SETTINGS_BASE);
    expect(getRes.body.settings.autoPostEnabled).toBe(true);
    expect(getRes.body.settings.updatedAt).not.toBeNull();
  });

  it('the pipeline auto-posts a clean document when enabled', async () => {
    const agent = await loginAgent(app, userA);
    await agent.put(SETTINGS_BASE).send({ autoPostEnabled: true, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null });

    const account = await accountIdByCode(orgA, '6130');
    const apFlowDocId = await registerDocument(orgA, userA, account);

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('AUTO-1') },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.status).toBe('POSTED');
    expect(detail.autoPosted).toBe(true);
    expect(detail.billId).not.toBeNull();
    expect(detail.autoPostBlockers).toEqual([]);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM bills WHERE org_id = $1 AND id = $2', [
      orgA,
      detail.billId,
    ]);
    expect(rows[0]?.status).toBe('POSTED');
  });

  it('the pipeline leaves a document EXTRACTED with AUTO_POST_DISABLED when disabled', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const apFlowDocId = await registerDocument(orgA, userA, account);

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('AUTO-2') },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.status).toBe('EXTRACTED');
    expect(detail.autoPostBlockers[0]?.code).toBe('AUTO_POST_DISABLED');
  });

  it('a duplicate invoice is blocked with POSTING_REJECTED, not FAILED', async () => {
    const agent = await loginAgent(app, userA);
    await agent.put(SETTINGS_BASE).send({ autoPostEnabled: true, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null });

    const account = await accountIdByCode(orgA, '6130');
    const firstDocId = await registerDocument(orgA, userA, account);
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: firstDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('DUP-AUTO') },
    );
    const first = await getApFlowDocumentById(orgA, firstDocId);
    expect(first.status).toBe('POSTED');

    // A second, distinct upload (different pixel fill => different bytes/hash)
    // for the same vendor and invoice number.
    const agent2 = await loginAgent(app, userA);
    const png2 = await sharp({
      create: { width: 300, height: 150, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const upload2 = await agent2.post(DOCS_BASE).attach('file', png2, 'receipt2.png');
    const created2 = await agent2.post(AP_FLOW_BASE).send({ documentId: upload2.body.document.id });
    const secondDocId = created2.body.document.id as string;

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: secondDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('DUP-AUTO') },
    );

    const second = await getApFlowDocumentById(orgA, secondDocId);
    expect(second.status).toBe('EXTRACTED');
    expect(second.autoPostBlockers[0]?.code).toBe('POSTING_REJECTED');
  });

  it('re-extracting clears auto_post_blockers', async () => {
    const account = await accountIdByCode(orgA, '6130');
    const apFlowDocId = await registerDocument(orgA, userA, account);

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('AUTO-3') },
    );
    const blocked = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(blocked.autoPostBlockers.length).toBeGreaterThan(0);

    const agent = await loginAgent(app, userA);
    const reextractRes = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/reextract`);
    expect(reextractRes.status).toBe(200);

    const afterReextract = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(afterReextract.autoPostBlockers).toEqual([]);
  });

  it('settings are isolated per organization', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.put(SETTINGS_BASE).send({ autoPostEnabled: true, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null });

    const agentB = await loginAgent(app, userB);
    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgB });
    const getRes = await agentB.get(SETTINGS_BASE);
    expect(getRes.body.settings.autoPostEnabled).toBe(false);

    const account = await accountIdByCode(orgB, '6130');
    const apFlowDocId = await registerDocument(orgB, userB, account);
    await handleApFlowExtract(
      { orgId: orgB, apFlowDocumentId: apFlowDocId },
      { ocr: ocrFor('Acme Vendor'), vision: stubVisionClient('AUTO-B1') },
    );
    const detail = await getApFlowDocumentById(orgB, apFlowDocId);
    expect(detail.status).toBe('EXTRACTED');
    expect(detail.autoPostBlockers[0]?.code).toBe('AUTO_POST_DISABLED');
  });
});
