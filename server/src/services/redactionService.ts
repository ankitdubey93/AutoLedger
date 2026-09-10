import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import type Tesseract from 'tesseract.js';
import { ApiError } from '../utils/apiError.js';
import { regionsForWords } from '../utils/pii.js';
import { AP_FLOW_MAX_PAGES, AP_FLOW_RASTER_DPI, AP_FLOW_REDACTION_PAD_PX, TESSERACT_CACHE_DIR } from '../config/constants.js';
import type { OcrPageResult, OcrWord, RedactedRegion } from '../types/ap-flow.js';

/**
 * The AP-Flow capture pipeline's document-processing surface (Phase 10) —
 * shared, unprefixed infrastructure like `storageService.ts`, per
 * docs/ap-flow.md's promotion note. Touches no database — this file must
 * never import db/connect.js. rasterize/redactPage are pure over buffers;
 * tesseractOcr is the one real I/O boundary, and it is always reached
 * through the injectable `OcrAdapter` seam.
 */

export interface RasterPage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
}

/**
 * The minimal shape this file relies on from the `@napi-rs/canvas` canvas
 * pdfjs-dist's NodeCanvasFactory creates internally. `@napi-rs/canvas` is a
 * transitive optionalDependency of pdfjs-dist, never imported directly here
 * — this interface documents the one method used, rather than importing
 * the package as if it were a direct dependency.
 *
 * `context` is deliberately untyped (`unknown`): the DOM lib
 * (`CanvasRenderingContext2D`) is not in this project's `tsconfig` `lib`
 * list (`ES2023` only, no DOM), so that name cannot be spelled here at all.
 * pdfjs-dist's own `.d.ts` references it too, which `skipLibCheck` quietly
 * tolerates for a `.d.ts` file — but this file is real `.ts` and gets full
 * checking, so `canvas` (not `canvasContext`) is what's passed to
 * `page.render()` below, matching the recommended (non-legacy) parameter.
 */
interface NapiCanvas {
  toBuffer(mime: 'image/png'): Buffer;
}

interface CanvasAndContext {
  canvas: NapiCanvas | null;
}

interface PdfCanvasFactory {
  create(width: number, height: number): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

/** Renders a document to one PNG per page. Never touches the database. */
export async function rasterize(
  buffer: Buffer,
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg',
): Promise<RasterPage[]> {
  if (mimeType === 'application/pdf') {
    return rasterizePdf(buffer);
  }

  // image/png or image/jpeg -> a single page. `.rotate()` with no argument
  // applies the EXIF orientation — a phone photo of a receipt is otherwise
  // rendered sideways and OCR fails on it.
  const normalized = await sharp(buffer).rotate().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  return [{ pageNumber: 1, width: metadata.width ?? 0, height: metadata.height ?? 0, png: normalized }];
}

async function rasterizePdf(buffer: Buffer): Promise<RasterPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // `isEvalSupported` does not exist on this version's DocumentInitParameters
  // — verified against the installed package's own types (pdfjs-dist 6.x
  // dropped the sandboxed-eval option entirely, so there is nothing to
  // disable here; PDF.js no longer executes embedded JavaScript at all).
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
  });
  const doc = await loadingTask.promise;

  try {
    if (doc.numPages > AP_FLOW_MAX_PAGES) {
      throw new ApiError(
        422,
        `Document has ${String(doc.numPages)} pages; the limit is ${String(AP_FLOW_MAX_PAGES)}`,
      );
    }

    // pdfjs auto-selects NodeCanvasFactory when running under Node (it
    // detects isNodeJS internally) and exposes it here so the caller can
    // allocate a canvas per page without importing @napi-rs/canvas itself.
    const canvasFactory = doc.canvasFactory as unknown as PdfCanvasFactory;
    const pages: RasterPage[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: AP_FLOW_RASTER_DPI / 72 });
      const width = Math.floor(viewport.width);
      const height = Math.floor(viewport.height);
      const canvasAndContext = canvasFactory.create(width, height);

      await page.render({ canvas: canvasAndContext.canvas, viewport }).promise;

      const canvas = canvasAndContext.canvas;
      if (canvas === null) throw new Error('pdfjs canvas factory produced no canvas');
      const png = canvas.toBuffer('image/png');
      canvasFactory.destroy(canvasAndContext);

      pages.push({ pageNumber, width, height, png });
    }

    return pages;
  } finally {
    // pdfjs holds worker resources that must be released explicitly.
    // destroy() lives on the loading task, not the resolved document proxy
    // — verified against the installed package's own types.
    await loadingTask.destroy();
  }
}

/**
 * The OCR seam. Every consumer takes an adapter rather than importing
 * tesseract directly, so a test injects a deterministic fake and CI never
 * downloads a 15MB language file or spends 30 seconds on a real recognise.
 */
export type OcrAdapter = (png: Buffer) => Promise<OcrPageResult>;

/**
 * Tesseract's `Page` result nests words three levels deep
 * (`blocks[].paragraphs[].lines[].words[]`) and carries no top-level image
 * dimensions — verified against the installed package's own types. Both are
 * flattened/derived here so the rest of this file only ever sees the flat
 * `OcrWord[]` shape `types/ap-flow.ts` declares.
 */
function flattenWords(page: Tesseract.Page): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            box: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
            confidence: word.confidence / 100,
          });
        }
      }
    }
  }
  return words;
}

/** The real adapter. Used in dev and production, never in a unit test. */
export const tesseractOcr: OcrAdapter = async (png) => {
  const [worker, metadata] = await Promise.all([
    createWorker('eng', 1, { cachePath: TESSERACT_CACHE_DIR }),
    sharp(png).metadata(),
  ]);
  try {
    const { data } = await worker.recognize(png, {}, { blocks: true });
    return {
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      text: data.text,
      words: flattenWords(data),
    };
  } finally {
    // A leaked tesseract worker keeps the process alive and hangs `npm test`.
    await worker.terminate();
  }
};

/**
 * Paints opaque black over every PII region and returns the masked PNG.
 * The ONLY function that produces bytes safe to send to a third party.
 *
 * This is destructive by construction and that is the point — the returned
 * buffer has no layer to peel back, unlike a PDF annotation or a CSS
 * overlay, both of which are recoverable redaction and would make the
 * phase's central claim false.
 */
export async function redactPage(
  png: Buffer,
  words: OcrWord[],
): Promise<{ png: Buffer; regions: RedactedRegion[] }> {
  const regions = regionsForWords(words, AP_FLOW_REDACTION_PAD_PX);
  if (regions.length === 0) return { png, regions: [] };

  const metadata = await sharp(png).metadata();
  const imgWidth = metadata.width ?? 0;
  const imgHeight = metadata.height ?? 0;

  const clamped = regions
    .map((r) => {
      const x0 = Math.max(0, Math.min(r.box.x0, imgWidth));
      const y0 = Math.max(0, Math.min(r.box.y0, imgHeight));
      const x1 = Math.max(0, Math.min(r.box.x1, imgWidth));
      const y1 = Math.max(0, Math.min(r.box.y1, imgHeight));
      return { kind: r.kind, box: { x0, y0, x1, y1 } };
    })
    .filter((r) => r.box.x1 > r.box.x0 && r.box.y1 > r.box.y0);

  if (clamped.length === 0) return { png, regions: [] };

  // `create` rather than an SVG overlay: it needs no font and no librsvg,
  // and it cannot fail on a locale or a missing glyph.
  const redacted = await sharp(png)
    .composite(
      clamped.map((r) => ({
        input: {
          create: {
            width: r.box.x1 - r.box.x0,
            height: r.box.y1 - r.box.y0,
            channels: 4 as const,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          },
        },
        left: r.box.x0,
        top: r.box.y0,
      })),
    )
    .png()
    .toBuffer();

  return { png: redacted, regions: clamped };
}
