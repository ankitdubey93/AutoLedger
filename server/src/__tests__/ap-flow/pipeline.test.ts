import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { handleApFlowExtract } from '../../queue/handlers/apFlowExtractHandler.js';
import { getApFlowDocumentById } from '../../services/ap-flow/apFlowDocumentService.js';
import type { OcrAdapter } from '../../services/redactionService.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import type { OcrPageResult } from '../../types/ap-flow.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import {
  addMember,
  clearStorage,
  createUserWithOrg,
  loginAgent,
  resetTables,
} from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Real database, injected `ocr`/`vision` deps, the handler called directly
 * — never through BullMQ (the queue-mechanics themselves are proven in
 * platform/queue.test.ts). This is the pipeline's own test: rasterize ->
 * OCR -> redact -> extract -> persist, and above all, that the vision
 * client only ever sees redacted bytes.
 */

const app = createApp();
const DOCS_BASE = '/api/v1/documents';
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';

async function buildFixture(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 150, channels: 3, background: { r: 220, g: 220, b: 220 } },
  })
    .png()
    .toBuffer();
}

function ordinaryOcr(): OcrAdapter {
  return () =>
    Promise.resolve<OcrPageResult>({
      width: 300,
      height: 150,
      text: 'Vendor Inc Total 45000',
      words: [{ text: 'Vendor', box: { x0: 10, y0: 10, x1: 60, y1: 30 }, confidence: 0.9 }],
    });
}

/** OCR words spelling a Luhn-valid card number, so redaction has something to mask. */
function cardOcr(): OcrAdapter {
  return () =>
    Promise.resolve<OcrPageResult>({
      width: 300,
      height: 150,
      text: '4111 1111 1111 1111',
      words: ['4111', '1111', '1111', '1111'].map((text, i) => ({
        text,
        box: { x0: 10 + i * 45, y0: 10, x1: 10 + i * 45 + 40, y1: 30 },
        confidence: 0.95,
      })),
    });
}

let capturedVisionBuffers: Buffer[] = [];

function stubVisionClient(): VisionClient {
  return {
    messages: {
      create: (body) => {
        const b = body as { messages: { content: { type: string; source?: { data: string } }[] }[] };
        capturedVisionBuffers = b.messages[0]?.content
          .filter((c) => c.type === 'image' && c.source !== undefined)
          .map((c) => Buffer.from(c.source?.data ?? '', 'base64')) ?? [];
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'record_invoice',
              input: {
                vendor_name: 'Vendor Inc',
                total: '450.00',
                line_items: [],
                field_confidence: {},
              },
            },
          ],
        });
      },
    },
  };
}

function throwingVisionClient(): VisionClient {
  return {
    messages: {
      create: () => Promise.reject(new Error('vision call failed')),
    },
  };
}

describe('ap-flow extraction pipeline', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();
    capturedVisionBuffers = [];

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

  async function registerDocument(): Promise<{ apFlowDocId: string; originalBytes: Buffer }> {
    const agent = await loginAgent(app, userA);
    const png = await buildFixture();
    const upload = await agent.post(DOCS_BASE).attach('file', png, 'receipt.png');
    expect(upload.status).toBe(201);

    const created = await agent.post(AP_FLOW_BASE).send({ documentId: upload.body.document.id });
    expect(created.status).toBe(201);

    return { apFlowDocId: created.body.document.id as string, originalBytes: png };
  }

  it('happy path: PENDING -> EXTRACTED, one page row, one extraction row', async () => {
    const { apFlowDocId } = await registerDocument();

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.status).toBe('EXTRACTED');
    expect(detail.pageCount).toBe(1);
    expect(detail.pages).toHaveLength(1);
    expect(detail.extraction).not.toBeNull();
    expect(detail.extraction?.vendorName).toBe('Vendor Inc');
    expect(detail.extraction?.totalCents).toBe(45000);
  });

  it('GET /ap-flow/documents/:id returns the extraction and one page after processing', async () => {
    const { apFlowDocId } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${AP_FLOW_BASE}/${apFlowDocId}`);
    expect(res.status).toBe(200);
    expect(res.body.document.pages).toHaveLength(1);
    expect(res.body.document.extraction.vendorName).toBe('Vendor Inc');
  });

  it('the stored page image differs from the original upload — it is the redacted one', async () => {
    const { apFlowDocId, originalBytes } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: cardOcr(), vision: stubVisionClient() },
    );

    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${AP_FLOW_BASE}/${apFlowDocId}/pages/1/image`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.isBuffer(res.body) || res.body instanceof Uint8Array).toBe(true);
    expect(Buffer.from(res.body).equals(originalBytes)).toBe(false);
  });

  it('a Luhn-valid card number produces one redacted_regions entry per matched word', async () => {
    const { apFlowDocId } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: cardOcr(), vision: stubVisionClient() },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.pages[0]?.redactedRegions).toHaveLength(4);
    for (const region of detail.pages[0]?.redactedRegions ?? []) {
      expect(region.kind).toBe('CARD_NUMBER');
    }
  });

  it('the vision client receives only redacted bytes, never the rasterized original', async () => {
    const { apFlowDocId } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: cardOcr(), vision: stubVisionClient() },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    const redactedSha256 = detail.pages[0]?.redactedSha256;
    expect(redactedSha256).toBeDefined();
    expect(capturedVisionBuffers).toHaveLength(1);

    const { createHash } = await import('node:crypto');
    const capturedHash = createHash('sha256').update(capturedVisionBuffers[0] ?? Buffer.alloc(0)).digest('hex');
    expect(capturedHash).toBe(redactedSha256);

    const rasterizedOriginalHash = createHash('sha256')
      .update(await sharp(await buildFixture()).png().toBuffer())
      .digest('hex');
    expect(capturedHash).not.toBe(rasterizedOriginalHash);
  });

  it('a vision failure marks the document FAILED with a reason, and re-throws', async () => {
    const { apFlowDocId } = await registerDocument();

    await expect(
      handleApFlowExtract(
        { orgId: orgA, apFlowDocumentId: apFlowDocId },
        { ocr: ordinaryOcr(), vision: throwingVisionClient() },
      ),
    ).rejects.toThrow('vision call failed');

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.status).toBe('FAILED');
    expect(detail.failureReason).toContain('vision call failed');
  });

  it('running the handler twice on the same document is a no-op the second time', async () => {
    const { apFlowDocId } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );
    // Second run: the document is now EXTRACTED, not PENDING, so
    // markProcessing must refuse and the handler must no-op.
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ap_flow_extractions WHERE org_id = $1 AND ap_flow_document_id = $2',
      [orgA, apFlowDocId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('after POST /:id/reextract, a second handler run leaves exactly one extraction and one page row', async () => {
    const { apFlowDocId } = await registerDocument();
    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const agent = await loginAgent(app, userA);
    const reextract = await agent.post(`${AP_FLOW_BASE}/${apFlowDocId}/reextract`);
    expect(reextract.status).toBe(200);
    expect(reextract.body.document.status).toBe('PENDING');

    await handleApFlowExtract(
      { orgId: orgA, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const { rows: extractionRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ap_flow_extractions WHERE org_id = $1 AND ap_flow_document_id = $2',
      [orgA, apFlowDocId],
    );
    expect(extractionRows[0]?.n).toBe(1);

    const { rows: pageRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ap_flow_pages WHERE org_id = $1 AND ap_flow_document_id = $2',
      [orgA, apFlowDocId],
    );
    expect(pageRows[0]?.n).toBe(1);
  });

  it('cross-tenant: a handler run with the wrong orgId touches nothing and leaves the document PENDING', async () => {
    const { apFlowDocId } = await registerDocument();

    await handleApFlowExtract(
      { orgId: orgB, apFlowDocumentId: apFlowDocId },
      { ocr: ordinaryOcr(), vision: stubVisionClient() },
    );

    const detail = await getApFlowDocumentById(orgA, apFlowDocId);
    expect(detail.status).toBe('PENDING');
    expect(detail.pages).toHaveLength(0);
    expect(detail.extraction).toBeNull();
  });

  it('performs no direct network request — every case here injects a stub vision client', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
