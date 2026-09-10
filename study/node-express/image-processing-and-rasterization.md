# Image processing and PDF rasterization in Node

> How a native image library streams work through C rather than buffering whole images in JS heap, and how a headless PDF renderer gets pixels without a browser.

**Category:** Node/Express
**Introduced by:** Phase 10 — AP-Flow needs every uploaded document, PDF or photo, converted into per-page PNG buffers before OCR can run
**Verified against:** `sharp` 0.35.4 (libvips 8.18.6), `pdfjs-dist` 6.3.289, `@napi-rs/canvas` 1.0.9, Node 24

---

## Mechanism

### `sharp`: a thin binding over libvips

`sharp` is not a JavaScript image library — it's a native binding to **libvips**, a C image-processing library. The distinction matters for two reasons:

1. **Performance model.** libvips processes images through a *demand-driven, horizontally-striped pipeline* rather than loading a whole decoded bitmap into memory and then transforming it. Each operation in a chain (`sharp(buf).rotate().png()`) is a node in a pipeline graph; libvips pulls image data through that graph a strip of scanlines at a time, so a resize-then-crop on a large image doesn't require the fully decoded original to sit in memory at once. This is why sharp is dramatically faster and more memory-efficient than pure-JS decode/transform/encode for large images — the work happens in native code with a streaming access pattern, not JS object allocation per pixel.
2. **Deployment cost.** Because it's native, `sharp` ships a prebuilt binary per platform/architecture (linux-x64, darwin-arm64, etc.) — `npm install` pulls the right one automatically, but it means the package is not "just JavaScript"; a Docker image or CI runner needs a matching prebuilt binary or a full native build toolchain.

`redactionService.ts` uses three sharp capabilities:

- **`.rotate()` with no argument** — applies the image's EXIF orientation tag before any further processing. A phone photo of a receipt is stored with orientation metadata rather than physically rotated pixels; skip this and the image renders sideways, and OCR (which has no innate sense of "which way is up") fails on it.
- **`.composite([...])`** — the redaction mechanism itself. Each region to mask is a `{ input: { create: { width, height, channels: 4, background: {...} } }, left, top }` entry: an in-memory solid-color image created on the fly and composited at a pixel offset. Using `create` rather than rendering an SVG rectangle avoids any font/glyph dependency — `create` needs no rasterizer beyond libvips' own pixel-fill, so it cannot fail on a missing system font or a locale issue the way SVG text rendering can.
- **`.raw().toBuffer({ resolveWithObject: true })`** — decodes to a flat, uncompressed RGB(A) buffer plus `{ width, height, channels }` metadata. This is what the acceptance test uses to do a genuine pixel-by-pixel comparison, since PNG's own compression means two visually-identical images can have different compressed bytes; comparing decoded pixels is the only way to make "this pixel changed" a real, mechanical assertion.

### `pdfjs-dist`: a renderer, not a decoder

Rendering a PDF page to pixels is a fundamentally different problem from decoding a PNG — a PDF page is a *program* (drawing operators: paths, text runs, images, clipping) that has to be executed against a canvas, not a compressed bitmap that can be inflated directly. `pdfjs-dist` (Mozilla's PDF.js, the same engine Firefox uses) parses the PDF's object graph and content streams and replays the drawing operators onto whatever canvas implementation it's given.

In a browser that canvas is the real DOM `<canvas>`. In Node there is no DOM, so pdfjs needs a **canvas factory** — an injectable object with a `create(width, height)` method returning something canvas-shaped. `pdfjs-dist` v6 auto-selects a `NodeCanvasFactory` when it detects it's running under Node, and that factory lazily `require()`s `@napi-rs/canvas` — a native canvas implementation (itself another libvips-adjacent-but-distinct native binding, this one implementing the Canvas 2D API in Rust) — the first time a canvas is actually needed. `@napi-rs/canvas` arrives as an `optionalDependency` of `pdfjs-dist`, not a direct dependency of this project, which is why it shows up in the lockfile without appearing in `package.json`.

The render call sequence:

```
getDocument({ data, useSystemFonts: false }) → PDFDocumentLoadingTask
  .promise → PDFDocumentProxy
    .getPage(n) → PDFPageProxy
      .getViewport({ scale }) → PageViewport   (maps PDF points to pixel dimensions)
      canvasFactory.create(width, height) → { canvas, context }
      .render({ canvas, viewport }).promise    (executes the page's drawing ops)
canvas.toBuffer('image/png')                   (the @napi-rs/canvas Canvas's own method)
loadingTask.destroy()                          (releases worker resources — NOT on the resolved document)
```

`scale = DPI / 72`, because a PDF's native coordinate space is 1/72 inch per unit ("points") — this is the same reason a font "72pt" and "1 inch tall" are historically the same statement.

### Verifying an API against installed types, not memory or documentation

Two real mismatches surfaced while building this against the actually-installed `pdfjs-dist` 6.3.289, both resolved by reading the package's own `.d.ts` files rather than trusting an assumption from an earlier major version:

- **`isEvalSupported` no longer exists** on `DocumentInitParameters` — this version dropped the sandboxed-JavaScript-execution feature the option used to toggle, so there's nothing left to disable.
- **`destroy()` lives on `PDFDocumentLoadingTask`**, not on the resolved `PDFDocumentProxy` — calling `doc.destroy()` (the intuitive name to reach for) is a type error; `await loadingTask.destroy()` is correct.

Both were caught immediately by `tsc`, which is the actual point: a library's public API is a moving target across majors, and the type checker — not a half-remembered example from an older version or a training cutoff — is the source of truth for what's callable.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `sharp` (native, libvips) | Fast, memory-efficient, but a native dependency with per-platform prebuilt binaries | Chosen — already the pre-approved Phase 10 dependency, and the streaming pipeline model is the right fit for repeated compositing |
| Pure-JS image manipulation (e.g. Jimp) | No native binary to manage; but meaningfully slower and more memory-hungry for anything beyond small images | Rejected — explicitly named as *not* approved for this phase |
| Shelling out to `pdftoppm`/ImageMagick as a subprocess | Works, avoids a JS-side PDF parser entirely; but adds a system-binary dependency the deployment environment has to provide, and subprocess I/O is clumsier to test | Rejected — not in the pre-approved dependency list, and pdfjs-dist gives an in-process, testable API |
| `pdfjs-dist` + `@napi-rs/canvas` (transitive) | Pure-Node PDF rendering, no subprocess, no system package; the tradeoff is depending on an optional transitive native dependency actually installing correctly | Chosen |

## Where it lives in this codebase

- `server/src/services/redactionService.ts` — `rasterize` (both the PNG/JPEG and PDF paths), `redactPage`
- `server/src/config/constants.ts` — `AP_FLOW_RASTER_DPI` (200, the floor at which tesseract reliably reads a thermal receipt), `AP_FLOW_MAX_PAGES` (20, a denial-of-service cap)
- `server/src/__tests__/redaction.test.ts` — rasterization cases for PNG, JPEG, and a hand-built minimal PDF

## Gotchas

- **A missing prebuilt binary fails at require time, not gracefully.** If `sharp` or `@napi-rs/canvas` has no prebuilt binary for the deployment platform/architecture, the failure is a load-time error, not a runtime fallback — there is no pure-JS backup path in this codebase (`jimp` was explicitly rejected), so this is a stop-and-report condition, not something to work around with a build toolchain improvised on the spot.
- **`viewport.width`/`.height` are floats; canvas dimensions must be integers.** `Math.floor` is used rather than `Math.round` — truncating rather than rounding avoids ever requesting a canvas one pixel larger than the viewport actually produces, which some canvas implementations reject or pad unpredictably.
- **`loadingTask.destroy()`, not `doc.destroy()`.** Getting this wrong doesn't throw immediately — it's a type error caught at compile time here, but in a looser codebase it would silently leak the PDF worker's resources per document processed.
- **EXIF orientation is invisible until it isn't.** A photo that looks upright in every image viewer (which all respect EXIF orientation automatically) can be stored bottom-up or sideways in raw pixel order. Skipping `.rotate()` produces a "why is OCR getting garbage on this one receipt" bug that only reproduces with photos from specific phone cameras.

## Interview Q&A

**Q: Why is `sharp` faster than a pure-JavaScript image library for large images?**
A: `sharp` binds to libvips, a native C library that processes images through a demand-driven, horizontally-striped pipeline — it pulls scanlines through a chain of operations rather than fully decoding an image into memory, transforming the whole thing, then re-encoding. A pure-JS library typically has to materialize the full decoded bitmap as JS-accessible memory and iterate pixel-by-pixel in JS, which is both slower (interpreted/JIT'd loops vs. compiled C) and more memory-hungry (a full decoded bitmap held in memory at once, sometimes at multiple pipeline stages).

**Q: What's the tradeoff of using a native binding like `sharp` versus a pure-JS library?**
A: Performance and memory efficiency versus deployment complexity. A native binding ships prebuilt binaries per platform, so `npm install` needs the right one available (or a full build toolchain as a fallback), and a Docker image or CI runner has to match. A pure-JS library has zero native dependency risk but pays for it in speed and memory at scale.

**Q: How does a Node process render a PDF page to an image without a browser?**
A: `pdfjs-dist` parses the PDF's internal object graph and content streams — the actual drawing instructions (paths, text, images) — and replays them against a canvas implementation. In a browser that's the real DOM canvas; in Node, pdfjs auto-detects it's running server-side and uses an injectable canvas factory, which in this project's setup lazily loads `@napi-rs/canvas`, a native (non-DOM) implementation of the Canvas 2D API, to actually receive and rasterize those drawing operations.

**Q: What does `getViewport({ scale })` actually control, and why is the scale `DPI / 72`?**
A: A PDF page's native coordinate system is measured in points, where 72 points equals one inch — a historical convention shared with typography ("72pt" and "1 inch" describe the same size). `getViewport` maps that points-based coordinate space to pixel dimensions at a given scale factor; dividing your target DPI by 72 converts "I want N dots per inch" into "how many pixels per PDF point," which is exactly the scale factor the rendering pipeline needs.

**Q: You mention `@napi-rs/canvas` isn't a direct dependency of your project. Why not just add it directly and use it explicitly?**
A: Because `pdfjs-dist` already declares it as an optional dependency and uses it internally through its own canvas-factory abstraction — adding it again as a direct dependency would just be declaring the same package twice, with no benefit, and it would blur the actual dependency boundary: my code doesn't call `@napi-rs/canvas` APIs directly, it calls `pdfjs-dist`'s `canvasFactory.create()`, which happens to be backed by that package under the hood. If I ever needed to swap the underlying canvas implementation, that's pdfjs-dist's concern, not mine, as long as I stay at its public `canvasFactory` interface.

**Q: How did you discover the two API changes (`isEvalSupported`, `destroy()` location) between what you expected and what pdfjs-dist 6.x actually provides?**
A: `tsc` caught both immediately as compile errors — I wrote the code against my recollection of the API, ran the type checker, and it flagged that `isEvalSupported` wasn't a valid property on the params type and that `.destroy()` didn't exist on the resolved document proxy. Rather than guessing at a fix, I went and read the package's own shipped `.d.ts` files to find what actually exists in this installed version, which turned out to be `loadingTask.destroy()`. That's the more general lesson: a library's API surface across major versions is something the installed type definitions are authoritative about, not memory of an older version.

## Follow-ups they'll dig into

- "What happens if you request a canvas with a huge page — say a poster-sized PDF at high DPI?" — `AP_FLOW_MAX_PAGES` caps page *count*, but nothing here caps a single page's pixel dimensions; a pathological single-page PDF with an enormous `MediaBox` could still allocate a very large canvas.
- "How would you scale this to process many documents concurrently?" — both sharp and pdfjs work in-process; heavy concurrent load would need either worker-thread parallelism or horizontal scaling of the worker process itself, since a single Node event loop still serializes the actual CPU-bound rendering work.
- "What if the PDF is malformed or has a corrupted xref table?" — pdfjs has its own recovery path (re-indexing objects from scratch), which is why a hand-built test PDF with imprecise offsets still renders correctly with a logged warning rather than failing outright.

## See also

- [document-capture-pipeline.md](../architecture/document-capture-pipeline.md)
- [pii-detection-and-redaction.md](../security-auth/pii-detection-and-redaction.md)
