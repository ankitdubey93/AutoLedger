import type { Readable } from 'node:stream';
import * as corpusService from '../../services/taxguard/corpusService.js';
import * as documentService from '../../services/documentService.js';
import { embedTexts } from '../../services/taxguard/embeddingService.js';
import type { EmbeddingsClient } from '../../services/taxguard/embeddingService.js';
import { parseTaxAct } from '../../utils/taxActParse.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * TaxGuard AI's ingestion job handler (Phase 16). Runs in the worker
 * process, so the AsyncLocalStorage-published audit actor
 * (utils/requestContext.ts) does not cross the process boundary — rows this
 * handler causes to be audited carry a null actor, the same accepted
 * behaviour the outbox drain and the AP-Flow extract handler already have.
 */

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

/** Extracts a PDF's text, page by page, joined with '\n\n'. Exported so
 *  parse and embed can be tested separately. */
export async function extractPdfText(stream: Readable): Promise<string> {
  const buffer = await streamToBuffer(stream);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false });
  const doc = await loadingTask.promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      // Each TextItem is one text-showing operation, with no embedded
      // line break of its own — `hasEOL` is pdfjs's own signal that a line
      // break follows. Without honouring it, a multi-line page collapses
      // to one line and taxActParse's line-anchored heading regex cannot
      // find a second "Section N" heading after the first.
      let pageText = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      pageTexts.push(pageText);
    }
    return pageTexts.join('\n\n');
  } finally {
    await loadingTask.destroy();
  }
}

export async function handleTaxGuardEmbed(
  payload: JobPayloads['taxguard-embed'],
  client?: EmbeddingsClient,
): Promise<void> {
  const { orgId, corpusDocumentId } = payload;

  const corpus = await corpusService.loadForIngestion(orgId, corpusDocumentId);
  if (corpus === null) {
    // The corpus document was deleted; retrying is pointless.
    console.warn(`[worker] taxguard-embed: corpus document ${corpusDocumentId} no longer exists`);
    return;
  }

  const startedParsing = await corpusService.markStatus(orgId, corpusDocumentId, 'PENDING', 'PARSING');
  if (!startedParsing) {
    // Duplicate job under at-least-once delivery, or the row has already
    // moved past PENDING — a no-op, not an error.
    return;
  }

  try {
    const { stream } = await documentService.openDocumentStream(orgId, corpus.documentId);
    const text = await extractPdfText(stream);

    const chunks = parseTaxAct(text, { actLabel: corpus.title });
    await corpusService.replaceChunks(orgId, corpusDocumentId, chunks);

    await corpusService.markStatus(orgId, corpusDocumentId, 'PARSING', 'EMBEDDING');

    const unembedded = await corpusService.listUnembeddedChunks(orgId, corpusDocumentId);
    if (unembedded.length > 0) {
      const vectors = await embedTexts(
        unembedded.map((chunk) => chunk.content),
        'document',
        client,
      );
      for (let i = 0; i < unembedded.length; i += 1) {
        const chunk = unembedded[i];
        const vector = vectors[i];
        if (chunk === undefined || vector === undefined) continue;
        await corpusService.setChunkEmbedding(orgId, chunk.id, vector);
      }
    }

    await corpusService.markReady(orgId, corpusDocumentId, chunks.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await corpusService.markFailed(orgId, corpusDocumentId, message);
    // Re-thrown so BullMQ retries, and a terminal failure still reaches the
    // dead-letter queue via the worker's existing 'failed' listener.
    throw err instanceof Error ? err : new Error(message);
  }
}
