import * as documentService from '../documentService.js';
import * as corpusService from './corpusService.js';
import { loadFixture } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import { taxguardActFixtureSchema } from '../../schemas/sandboxSchema.js';

const LINES_PER_PAGE = 40;

/**
 * Phase 18 — TaxGuard's sandbox seeder.
 *
 * Imports `services/taxguard/` plus `documentService`, the platform Vault —
 * the same route `corpusService.createCorpusDocument` itself takes into the
 * platform (guardrails rule 16).
 *
 * Unlike AP-Flow, this file does NOT skip `createCorpusDocument`'s automatic
 * enqueue: there is no canned override to race against. With no embeddings
 * provider configured the `taxguard-embed` job fails honestly (embeddingService
 * throws 503) and the row is left at PENDING or PARSING — never a fabricated
 * READY, which `chk_taxguard_corpus_ready` would reject outright since it
 * requires `ingested_at IS NOT NULL AND chunk_count > 0`. Once Phase 19 lands
 * a working provider and a worker is running, the same job genuinely ingests
 * the act and the row reaches READY for real.
 */
export async function seedSandbox(ctx: SandboxSeedContext): Promise<Partial<SandboxCounts>> {
  const fixture = await loadFixture('taxguard/sample-act.json', taxguardActFixtureSchema);

  const pdfBuffer = buildMinimalPdf(fixture.body);

  const { document } = await documentService.uploadDocument(ctx.orgId, ctx.userId, {
    buffer: pdfBuffer,
    originalname: fixture.fileName,
  });

  await corpusService.createCorpusDocument(ctx.orgId, ctx.userId, {
    documentId: document.id,
    title: fixture.title,
    jurisdiction: fixture.jurisdiction,
    actYear: fixture.actYear,
  });

  return { corpusDocuments: 1 };
}

/**
 * A minimal, valid, hand-written multi-page PDF from plain text lines — the
 * same technique `__tests__/helpers/factories.ts`'s `buildTestPdf` uses for
 * a single page, extended here to paginate at `LINES_PER_PAGE`. Kept as a
 * small, deliberate duplication rather than an import from test code:
 * production code must never depend on a test helper. Splitting the act
 * across pages, rather than shrinking it to fit one, is what lets this
 * fixture genuinely exercise `utils/taxActParse.ts`'s page-by-page text
 * extraction — the property the roadmap calls out as the thing to get right.
 */
function buildMinimalPdf(lines: string[]): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  let nextId = 4; // 1=Catalog, 2=Pages, 3=Font — page/content objects start at 4

  const contentObjects: { id: number; content: string }[] = [];
  for (const pageLines of pages) {
    const escaped = pageLines.map((line) => line.replace(/([()\\])/g, '\\$1'));
    const commands: string[] = ['BT', '/F1 11 Tf', '10 780 Td'];
    escaped.forEach((line, i) => {
      if (i > 0) commands.push('0 -14 Td');
      commands.push(`(${line}) Tj`);
    });
    commands.push('ET');
    const content = commands.join('\n');

    const pageId = nextId++;
    const contentId = nextId++;
    pageObjectIds.push(pageId);
    contentObjects.push({ id: contentId, content });

    objects.push(
      [
        `${String(pageId)} 0 obj`,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentId)} 0 R >>`,
        'endobj',
      ].join('\n'),
    );
    objects.push(
      [
        `${String(contentId)} 0 obj`,
        `<< /Length ${String(content.length)} >>`,
        'stream',
        content,
        'endstream',
        'endobj',
      ].join('\n'),
    );
  }

  const header = [
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pageObjectIds.length)} >>`,
    'endobj',
    '3 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ];

  const pdf = [
    '%PDF-1.4',
    ...header,
    ...objects,
    'trailer',
    `<< /Size ${String(nextId)} /Root 1 0 R >>`,
    '%%EOF',
  ].join('\n');

  return Buffer.from(pdf, 'latin1');
}
