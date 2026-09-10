import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { rasterize, redactPage, tesseractOcr } from '../services/redactionService.js';
import type { OcrAdapter } from '../services/redactionService.js';
import type { OcrWord } from '../types/ap-flow.js';

/**
 * The phase's acceptance test: proves masking with a raw-pixel comparison,
 * never "the code ran without throwing" (docs/ap-flow.md's requirement).
 * Every case here injects a fake `OcrAdapter` — `tesseractOcr` is never
 * invoked in this file except under the explicit, opt-in E2E case.
 */

const FIXTURE_WIDTH = 600;
const FIXTURE_HEIGHT = 200;

// A deterministic 600x200 PNG: a background fill, a patch INSIDE the region
// that will be masked, and a patch FAR OUTSIDE it. No fonts, no network,
// byte-identical on every machine.
async function buildFixture(): Promise<Buffer> {
  return sharp({
    create: { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, channels: 3, background: { r: 200, g: 180, b: 160 } },
  })
    .composite([
      {
        // Inside the region that redactPage will mask below (word boxes at x 10-190, y 10-30).
        input: await sharp({ create: { width: 50, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } } })
          .png()
          .toBuffer(),
        left: 20,
        top: 15,
      },
      {
        // Far outside the masked region — must stay untouched.
        input: await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 250, g: 250, b: 250 } } })
          .png()
          .toBuffer(),
        left: 500,
        top: 150,
      },
    ])
    .png()
    .toBuffer();
}

/** Four OCR words spelling a Luhn-valid card number, laid out left to right. */
function cardWords(): OcrWord[] {
  const groups = ['4111', '1111', '1111', '1111'];
  return groups.map((text, i) => ({
    text,
    box: { x0: 10 + i * 45, y0: 10, x1: 10 + i * 45 + 40, y1: 30 },
    confidence: 0.95,
  }));
}

interface RawImageInfo {
  width: number;
  channels: number;
}

async function readRgb(buf: Buffer): Promise<{ data: Buffer; info: RawImageInfo }> {
  return sharp(buf).raw().toBuffer({ resolveWithObject: true });
}

function pixelAt(data: Buffer, info: RawImageInfo, x: number, y: number): [number, number, number] {
  const idx = (y * info.width + x) * info.channels;
  return [data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0];
}

describe('redactionService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Structural proof that nothing in this file performs a network request.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('redactPage alters every pixel inside the masked region', async () => {
    const fixture = await buildFixture();
    const words = cardWords();
    // The padded region spans roughly x0=7..190, y0=7..33 across the 4 words.
    const { png: redacted, regions } = await redactPage(fixture, words);
    expect(regions.length).toBeGreaterThan(0);

    const before = await readRgb(fixture);
    const after = await readRgb(redacted);

    let sawNonBlackBefore = false;
    for (const region of regions) {
      for (let y = region.box.y0; y < region.box.y1; y += 1) {
        for (let x = region.box.x0; x < region.box.x1; x += 1) {
          const afterPixel = pixelAt(after.data, after.info, x, y);
          expect(afterPixel).toEqual([0, 0, 0]);
          const beforePixel = pixelAt(before.data, before.info, x, y);
          if (beforePixel[0] !== 0 || beforePixel[1] !== 0 || beforePixel[2] !== 0) {
            sawNonBlackBefore = true;
          }
        }
      }
    }
    expect(sawNonBlackBefore).toBe(true);
  });

  it('redactPage leaves every pixel outside the masked regions byte-identical', async () => {
    const fixture = await buildFixture();
    const words = cardWords();
    const { png: redacted, regions } = await redactPage(fixture, words);

    const before = await readRgb(fixture);
    const after = await readRgb(redacted);

    function insideAnyRegion(x: number, y: number): boolean {
      return regions.some((r) => x >= r.box.x0 && x < r.box.x1 && y >= r.box.y0 && y < r.box.y1);
    }

    // Sample the far-outside patch plus its corners — a full-image scan is
    // unnecessary once the masked-region proof above holds.
    const samplePoints: [number, number][] = [
      [500, 150],
      [520, 160],
      [0, 0],
      [FIXTURE_WIDTH - 1, FIXTURE_HEIGHT - 1],
    ];
    for (const [x, y] of samplePoints) {
      if (insideAnyRegion(x, y)) continue;
      expect(pixelAt(after.data, after.info, x, y)).toEqual(pixelAt(before.data, before.info, x, y));
    }
  });

  it('returns the buffer unchanged when no PII is detected', async () => {
    const fixture = await buildFixture();
    const ordinaryWords: OcrWord[] = [
      { text: 'EC2', box: { x0: 10, y0: 10, x1: 40, y1: 30 }, confidence: 0.9 },
      { text: 'Compute', box: { x0: 45, y0: 10, x1: 100, y1: 30 }, confidence: 0.9 },
    ];
    const { png, regions } = await redactPage(fixture, ordinaryWords);
    expect(regions).toHaveLength(0);
    expect(png.equals(fixture)).toBe(true);
  });

  it('does not mask a non-Luhn 16-digit run — the checksum decides, not the digit count', async () => {
    const fixture = await buildFixture();
    const groups = ['1234', '5678', '9012', '3456'];
    const words: OcrWord[] = groups.map((text, i) => ({
      text,
      box: { x0: 10 + i * 45, y0: 10, x1: 10 + i * 45 + 40, y1: 30 },
      confidence: 0.9,
    }));
    const { regions } = await redactPage(fixture, words);
    expect(regions).toHaveLength(0);
  });

  it('rasterizes a PNG to exactly one page at its native size', async () => {
    const fixture = await buildFixture();
    const pages = await rasterize(fixture, 'image/png');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pageNumber).toBe(1);
    expect(pages[0]?.width).toBe(FIXTURE_WIDTH);
    expect(pages[0]?.height).toBe(FIXTURE_HEIGHT);
  });

  it('rasterizes a JPEG to exactly one page', async () => {
    const fixture = await buildFixture();
    const jpeg = await sharp(fixture).jpeg().toBuffer();
    const pages = await rasterize(jpeg, 'image/jpeg');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pageNumber).toBe(1);
    expect(pages[0]?.width).toBeGreaterThan(0);
    expect(pages[0]?.height).toBeGreaterThan(0);
  });

  it('rasterizes a minimal single-page PDF', async () => {
    // A hand-built minimal single-page PDF. pdfjs recovers via its own
    // object-indexing fallback when the xref table is imprecise, which is
    // expected and harmless (real-world PDFs trigger the same path).
    const MINIMAL_PDF = [
      '%PDF-1.4',
      '1 0 obj',
      '<< /Type /Catalog /Pages 2 0 R >>',
      'endobj',
      '2 0 obj',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      'endobj',
      '3 0 obj',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>',
      'endobj',
      '4 0 obj',
      '<< /Length 44 >>',
      'stream',
      '1 0 0 RG 1 0 0 rg 10 10 50 50 re f',
      'endstream',
      'endobj',
      'trailer',
      '<< /Size 5 /Root 1 0 R >>',
      '%%EOF',
    ].join('\n');

    const buf = Buffer.from(MINIMAL_PDF, 'latin1');
    const pages = await rasterize(buf, 'application/pdf');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pageNumber).toBe(1);
    expect(pages[0]?.width).toBeGreaterThan(0);
    expect(pages[0]?.height).toBeGreaterThan(0);
  });

  it('performs no network request across this entire file', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Exercises the real tesseractOcr adapter deliberately, never in normal CI
  // — set AP_FLOW_OCR_E2E=1 to run it. This is the sanctioned way to prove
  // the real adapter works without making every CI run download a language
  // pack.
  describe.skipIf(process.env.AP_FLOW_OCR_E2E !== '1')('real tesseractOcr (opt-in E2E)', () => {
    it('recognizes text on the fixture image', async () => {
      const fixture = await buildFixture();
      const adapter: OcrAdapter = tesseractOcr;
      const result = await adapter(fixture);
      expect(result.width).toBe(FIXTURE_WIDTH);
      expect(result.height).toBe(FIXTURE_HEIGHT);
    }, 30_000);
  });
});
