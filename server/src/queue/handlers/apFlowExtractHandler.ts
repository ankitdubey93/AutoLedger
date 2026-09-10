import * as apFlowDocumentService from '../../services/ap-flow/apFlowDocumentService.js';
import * as storageService from '../../services/storageService.js';
import { rasterize, redactPage, tesseractOcr } from '../../services/redactionService.js';
import type { OcrAdapter } from '../../services/redactionService.js';
import { extractFromPages } from '../../services/ap-flow/extractionService.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import type { JobPayloads } from '../../types/jobs.js';
import type { RedactedRegion } from '../../types/ap-flow.js';

/**
 * The AP-Flow capture pipeline's job handler (Phase 10). Runs in the
 * worker process, so the AsyncLocalStorage-published audit actor
 * (utils/requestContext.ts) does not cross the process boundary — rows this
 * handler causes to be audited (via savePipelineResult's writes) carry a
 * null actor, the same accepted behaviour the outbox drain already has.
 */

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function handleApFlowExtract(
  payload: JobPayloads['ap-flow-extract'],
  deps?: { ocr?: OcrAdapter; vision?: VisionClient },
): Promise<void> {
  const { orgId, apFlowDocumentId } = payload;
  const ocr = deps?.ocr ?? tesseractOcr;

  const doc = await apFlowDocumentService.loadForProcessing(orgId, apFlowDocumentId);
  if (doc === null) {
    // The document was deleted; retrying is pointless.
    console.warn(`[worker] ap-flow-extract: document ${apFlowDocumentId} no longer exists`);
    return;
  }

  const started = await apFlowDocumentService.markProcessing(orgId, apFlowDocumentId);
  if (!started) {
    // Duplicate job under at-least-once delivery, or the document has
    // already moved past PENDING/PROCESSING — a no-op, not an error.
    return;
  }

  try {
    const original = await collectStream(storageService.get(orgId, doc.sha256));
    const rasterPages = await rasterize(original, doc.mimeType as 'application/pdf' | 'image/png' | 'image/jpeg');

    const pipelinePages: {
      pageNumber: number;
      widthPx: number;
      heightPx: number;
      redactedSha256: string;
      ocrText: string;
      redactedRegions: RedactedRegion[];
    }[] = [];
    const redactedBuffers: Buffer[] = [];

    for (const page of rasterPages) {
      const ocrResult = await ocr(page.png);
      const { png: redactedPng, regions } = await redactPage(page.png, ocrResult.words);
      const { sha256: redactedSha256 } = await storageService.put(orgId, redactedPng);

      redactedBuffers.push(redactedPng);
      pipelinePages.push({
        pageNumber: page.pageNumber,
        widthPx: page.width,
        heightPx: page.height,
        redactedSha256,
        ocrText: ocrResult.text,
        redactedRegions: regions,
      });
    }

    // Only now — redacted buffers ONLY. Passing page.png (the unredacted
    // raster) here is the one bug that would make this app's central claim
    // false: that PII is masked before any image leaves the machine.
    const extraction = await extractFromPages(redactedBuffers, deps?.vision);

    await apFlowDocumentService.savePipelineResult(orgId, apFlowDocumentId, pipelinePages, extraction);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await apFlowDocumentService.markFailed(orgId, apFlowDocumentId, message);
    // Re-thrown so BullMQ retries, and a terminal failure still reaches the
    // dead-letter queue via the worker's existing 'failed' listener.
    throw err instanceof Error ? err : new Error(message);
  }
}
