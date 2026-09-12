import sharp from 'sharp';
import * as documentService from '../documentService.js';
import * as storageService from '../storageService.js';
import * as apFlowDocumentService from './apFlowDocumentService.js';
import * as postingService from './postingService.js';
import { parseMoneyText } from '../../utils/money.js';
import { loadFixture } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import { apFlowDocumentsFixtureSchema } from '../../schemas/sandboxSchema.js';
import type { ExtractionResult } from './extractionService.js';
import type { LineItemClassification } from './mappingService.js';

/**
 * Phase 18 — AP-Flow's sandbox seeder.
 *
 * Imports `services/ap-flow/` plus the two platform services (`documentService`,
 * `storageService`) every AP-Flow module already depends on for the same
 * reason (guardrails rule 16 — the Vault is platform infrastructure, not
 * another app's table).
 *
 * This file deliberately does NOT run the real capture pipeline —
 * `extractionService`/`mappingService`/OCR/vision are never called. It
 * inserts a document with `{ skipEnqueue: true }` (so no worker races a
 * canned result against a real, key-less extraction attempt), moves it
 * PENDING -> PROCESSING with the same atomic guard the real handler uses,
 * then supplies the fixture's canned extraction directly through
 * `savePipelineResult` — landing a genuinely EXTRACTED row: real FSM
 * transition, real audit trail, no API key and no worker required.
 */
export async function seedSandbox(
  ctx: SandboxSeedContext,
  accountsByCode: Map<string, string>,
): Promise<Partial<SandboxCounts>> {
  const fixture = await loadFixture('ap-flow/documents.json', apFlowDocumentsFixtureSchema);
  let posted = 0;

  for (const doc of fixture.documents) {
    const invoiceDate = ctx.monthDate(doc.monthOffset, doc.day);
    const pageBuffer = await renderInvoicePng(doc, fixture.pageImage.widthPx, fixture.pageImage.heightPx);

    // The original "captured" file, registered with the platform Vault —
    // the same route a real upload takes.
    const { document: vaultDoc } = await documentService.uploadDocument(ctx.orgId, ctx.userId, {
      buffer: pageBuffer,
      originalname: doc.originalFilename,
    });

    const apFlowDoc = await apFlowDocumentService.createApFlowDocument(
      ctx.orgId,
      ctx.userId,
      { documentId: vaultDoc.id },
      { skipEnqueue: true },
    );

    const started = await apFlowDocumentService.markProcessing(ctx.orgId, apFlowDoc.id);
    if (!started) {
      throw new Error(`sandboxSeed(ap-flow): markProcessing did not accept a fresh PENDING document`);
    }

    // The real pipeline stores each page's redacted raster separately from
    // the vault-tracked original via storageService.put. Nothing here was
    // actually redacted — a synthetic rendered invoice contains no PII to
    // find — so the "redacted" bytes are the same bytes, put a second time;
    // content-addressed storage makes that a no-op, not a duplicate.
    const { sha256: pageSha256 } = await storageService.put(ctx.orgId, pageBuffer);

    const subtotalCents = parseMoneyText(doc.extraction.subtotal);
    const taxCents = parseMoneyText(doc.extraction.tax);
    const totalCents = parseMoneyText(doc.extraction.total);

    const extraction: ExtractionResult = {
      vendorName: doc.extraction.vendorName,
      invoiceNumber: doc.extraction.invoiceNumber,
      invoiceDate,
      currency: doc.extraction.currency,
      subtotalCents,
      taxCents,
      totalCents,
      lineItems: doc.extraction.lineItems.map((li) => ({
        description: li.description,
        amountCents: parseMoneyText(li.amount),
      })),
      fieldConfidence: doc.extraction.fieldConfidence,
      arithmeticOk: doc.extraction.arithmeticOk,
      validationErrors: doc.extraction.validationErrors,
      model: 'sandbox-fixture',
    };

    const classifications: LineItemClassification[] = doc.extraction.lineItems.map((li, index) => {
      const suggestedAccountId = li.accountCode === null ? null : (accountsByCode.get(li.accountCode) ?? null);
      if (li.accountCode !== null && suggestedAccountId === null) {
        throw new Error(`sandboxSeed(ap-flow): account ${li.accountCode} not found`);
      }
      return {
        lineIndex: index,
        description: li.description,
        amountCents: parseMoneyText(li.amount),
        suggestedAccountId,
        mappingSource: suggestedAccountId === null ? 'NONE' : 'HISTORY',
        mappingConfidence: suggestedAccountId === null ? null : 0.9,
      };
    });

    await apFlowDocumentService.savePipelineResult(
      ctx.orgId,
      apFlowDoc.id,
      [
        {
          pageNumber: 1,
          widthPx: fixture.pageImage.widthPx,
          heightPx: fixture.pageImage.heightPx,
          redactedSha256: pageSha256,
          ocrText: '',
          redactedRegions: [],
        },
      ],
      extraction,
      classifications,
    );

    if (doc.outcome === 'POSTED') {
      await postingService.postApFlowDocument(ctx.orgId, ctx.userId, apFlowDoc.id);
      posted += 1;
    }
  }

  return { apFlowDocuments: fixture.documents.length };
}

/**
 * Renders a plain, invoice-looking PNG from the fixture's own extraction
 * values via sharp's SVG rasterization — no binary is committed to the
 * repo, and the bytes an auditor opens genuinely match what the seeded
 * extraction claims.
 */
async function renderInvoicePng(
  doc: { extraction: { vendorName: string; invoiceNumber: string; total: string } },
  widthPx: number,
  heightPx: number,
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(widthPx)}" height="${String(heightPx)}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="0" y="0" width="100%" height="140" fill="#f0f0f0"/>
    <text x="60" y="90" font-size="42" font-family="sans-serif" fill="#111111">INVOICE</text>
    <text x="60" y="220" font-size="26" font-family="sans-serif" fill="#222222">${escapeXml(doc.extraction.vendorName)}</text>
    <text x="60" y="270" font-size="20" font-family="sans-serif" fill="#444444">Invoice ${escapeXml(doc.extraction.invoiceNumber)}</text>
    <text x="60" y="${String(heightPx - 120)}" font-size="30" font-family="sans-serif" fill="#111111">Total: ${escapeXml(doc.extraction.total)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
