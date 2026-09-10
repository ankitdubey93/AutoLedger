# PII detection and image redaction

> Detecting and permanently masking personal data in a raster image, before it leaves the machine — not stripping it from a response after the fact.

**Category:** Security
**Introduced by:** Phase 10 — AP-Flow's capture pipeline, which must mask card numbers, national IDs and names in a scanned receipt before sending the image to Claude's vision API
**Verified against:** Node 24, hand-written (zero dependencies)

---

## Mechanism

**You cannot regex a JPEG.** PII in a scanned document exists as *pixels*, not text — regex only works once you have a string, and a string only exists once OCR has already read the image. So the pipeline has a hard ordering constraint: rasterize → OCR (local) → detect PII in the OCR'd text → map detections back onto pixel regions → paint over those regions → *only then* is the buffer safe to send anywhere. Reversing steps 3 and 6 — sending the raster before masking it — makes the whole feature a lie regardless of what the detector code says, which is why `apFlowExtractHandler.ts` calls `extractFromPages` on the *redacted* buffers, never the rasterized originals, and that ordering is the one line in the whole phase with a comment warning against "fixing" it.

### Detection: checksum, not digit count

A run of sixteen digits is not a card number — it might be an invoice number, an order reference, or a phone number. `utils/checksum.ts` implements two checksum algorithms by hand:

- **Luhn (mod-10)**, used by card numbers: walk the digit string right to left, double every second digit, subtract 9 from any doubled value over 9, sum everything, valid iff the sum is a multiple of 10. The "subtract 9 if over 9" step is a well-known shortcut for "sum the digits of the doubled value" (e.g. `8 × 2 = 16` → `1+6 = 7`, and `16 - 9 = 7` too) — it avoids a second digit-sum pass.
- **Verhoeff (dihedral D5)**, used by Aadhaar (India's national ID): fold the digit string through a multiplication table `d` and a position-dependent permutation table `p`, right to left; valid iff the final accumulator is 0. Unlike Luhn, Verhoeff catches *all* single-digit errors and *all* adjacent-transposition errors — it's a genuinely stronger checksum, which is why it's the harder one to hand-roll correctly (a table transcription typo silently breaks it in a way that's easy to miss without an independently-verified vector).

`utils/pii.ts`'s `detectPii` runs six detectors over the OCR'd text, in order: `CARD_NUMBER` (13–19 digits, grouped, Luhn-checked), `AADHAAR` (12 digits, first digit 2–9, Verhoeff-checked), `PAN` (India's tax ID, a fixed 10-character pattern), `GSTIN` (India's GST registration number, a fixed 15-character pattern), `SSN` (`###-##-####`), and `PERSON_NAME` (label-anchored — only after `Bill To:`, `Attn:`, `Cardholder:` and similar). Overlapping spans are merged, keeping the longer one.

### Mapping a span back onto pixels

OCR gives you words with bounding boxes, not a raw string. `regionsForWords` builds the flat text by joining `words[i].text` with a single space and recording each word's `[start, end)` offset in that joined string — the *same* joining rule `detectPii` implicitly assumes, since a span's offsets only mean anything against the exact string it was detected in. A detected span is then mapped to every OCR word whose offset range *overlaps* it (`word.start < span.end && span.start < word.end`), not merely touches it. A card number spanning four separate OCR words therefore produces four boxes — you cannot mask a span, only the words underneath it, because the image only has pixels at word positions.

Each box is padded outward (`AP_FLOW_REDACTION_PAD_PX`, default 3px) and clamped to `≥ 0`. Padding isn't cosmetic: OCR boxes are tight-fitting and slightly optimistic, and an unpadded mask leaves a rim of antialiased digit visible at the edge.

### Masking: destructive by construction

`redactionService.redactPage` composites an opaque black rectangle (`sharp().composite()` with a `create`-image input, not an SVG overlay — no font, no librsvg, nothing that can fail on a missing glyph or a locale) over every padded region and re-encodes to PNG. The returned buffer has no layer to peel back. This matters because there are three *other* ways to "redact" an image that all leave the original data recoverable:

- **A PDF/image annotation** — a rectangle drawn on top, with the original pixels still present underneath it in the file.
- **A CSS overlay** — never touches the bytes at all; anyone with the raw file sees everything.
- **A black box over selectable text** in a PDF — the text layer is still extractable by copy-paste even though the visual rendering shows a box (this is a real, repeated failure in legal document redaction).

Pixel compositing followed by re-encoding to a new PNG buffer is the one approach where "redacted" and "cannot be un-redacted" are the same claim.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Send the raw image to a hosted OCR API, mask afterward | Simplest to build; but the unmasked bytes already left the machine by the time masking happens — the whole claim is false | Rejected |
| Regex over the image's raw bytes | Impossible — PII exists as rendered pixels, not as a string, until OCR has run | Rejected (not a real option) |
| A recoverable overlay (PDF annotation / CSS box) | Visually redacts, but the original data is still present in the file for anyone who looks | Rejected — same failure class as several real-world redaction incidents |
| Digit-count-only detection (any 16-digit run is a card) | Cheap; but false-positives on invoice numbers/phone numbers, and a redactor with too many false positives gets its output ignored | Rejected — checksum-verified instead |
| Full named-entity recognition (NER) for names | Would catch unlabelled names too; needs a model, a dependency, and training data none of which exist here | Rejected for Phase 10 — label-anchored heuristic instead, with the limitation stated honestly |

## Where it lives in this codebase

- `server/src/utils/checksum.ts` — `luhn`, `verhoeff`
- `server/src/utils/pii.ts` — `detectPii`, `regionsForWords`
- `server/src/services/redactionService.ts` — `redactPage` (the compositing), `rasterize`, `tesseractOcr`
- `server/src/queue/handlers/apFlowExtractHandler.ts` — the pipeline ordering that makes the claim true
- `server/src/__tests__/redaction.test.ts` — the acceptance test: raw-pixel comparison before/after, not "the code ran without throwing"

## Gotchas

- **This is a heuristic, not a guarantee.** `PERSON_NAME` detection is label-anchored — it will miss an unlabelled name (a signature with no "Attn:" before it) and can over-mask a capitalised line item that happens to sit right after a matched label pattern. Combined with OCR boxes being approximate in the first place, the honest claim this pipeline can make is **"redaction pipeline implemented,"** never **"PII cannot leak."** Measuring actual recall would need a labelled corpus of real receipts, which does not exist yet — `docs/ap-flow.md` requires this limitation to be stated, not glossed over.
- **A checksum without the right table is worse than no checksum** — a single wrong entry in the Verhoeff `d` or `p` table makes every validation silently wrong in a way unit tests only catch if the test vector itself is independently verified (in this codebase, against Wikipedia's own worked example: `236` → check digit `3` → `2363` validates), not invented to match whatever the code happens to compute.
- **Padding trades false negatives at the edge for slightly larger boxes.** Too little padding leaves readable digit fragments; too much starts eating adjacent text. 3px was picked empirically against typical OCR box tightness, not derived analytically.
- **The join-offset contract is easy to break silently.** `regionsForWords` and `detectPii` only agree on span positions because both assume the same `' '.join(words)` construction. Changing the separator in one place without the other produces off-by-one masked regions that look almost right in a spot check and are wrong at every word boundary.

## Interview Q&A

**Q: Why can't you just run a regex over the image file to find PII?**
A: Because PII in a scanned document exists as rendered pixels, not as text. A regex operates on a string, and there is no string until OCR has extracted one. The pipeline has to be rasterize → OCR → detect → mask, in that order, and the masking has to happen before the image is sent anywhere else — sending the original and redacting a copy afterward doesn't protect anything, because the unmasked bytes already left the machine.

**Q: Why use a checksum (Luhn/Verhoeff) instead of just matching digit-count patterns?**
A: A sixteen-digit run is not necessarily a card number — invoice numbers, order references, and phone numbers can all produce a false match on digit count alone. Luhn and Verhoeff are error-detecting checksums specifically designed into card numbers and Aadhaar numbers respectively, so requiring the checksum to pass filters out the overwhelming majority of coincidental digit runs. It's not perfect — a random 16-digit string that happens to pass Luhn is unlikely but not impossible — but it's a large accuracy improvement for zero extra input.

**Q: What's the actual difference between Luhn and Verhoeff, mechanism-wise?**
A: Luhn is a simple weighted-sum check: double every second digit (right to left), fold values over 9 by subtracting 9, sum, and check divisibility by 10. It catches most single-digit errors but misses some adjacent-digit transpositions (notably 09 ↔ 90). Verhoeff uses a dihedral group D5 multiplication table plus a position-dependent permutation table, folding the digit string through both at each position. It's provably stronger — it catches all single-digit errors and all adjacent transpositions — at the cost of needing precomputed tables rather than simple arithmetic.

**Q: Why paint the masked regions black instead of blurring or pixelating them?**
A: Because a mask has to be irreversible, and blur/pixelation are not — both are lossy but partially invertible, and there's a body of research on recovering text from blurred or pixelated redactions using known-font deconvolution. An opaque solid fill destroys the information completely; there's no signal left to recover from a solid black rectangle.

**Q: How do you know the redaction actually worked, as opposed to the code just not throwing an error?**
A: The acceptance test reads both the input and output images as raw RGB buffers and asserts, pixel by pixel, that every pixel inside the masked region equals `(0,0,0)` in the output while at least one pixel in that same region was *not* black in the input. That's a real comparison of pixel values, not an assertion that a function call succeeded — "the code ran" and "the pixels changed" are different claims, and only the second one is the actual requirement.

**Q: What's the biggest limitation of this approach, and how would you actually validate it before trusting it in production?**
A: The biggest limitation is that detection is a heuristic — checksum-verified pattern matching plus a label-anchored name detector — not a guarantee of completeness. It will miss an unlabelled name, and OCR bounding boxes are themselves approximate. To validate it properly you'd need a labelled corpus of real (or realistic synthetic) receipts with every PII instance marked, run the pipeline, and compute actual recall and precision — right now the honest claim is "the pipeline is implemented and demonstrably masks what it detects," not "PII cannot leak," because that measurement hasn't been done.

## Follow-ups they'll dig into

- "What happens if OCR gets the bounding box slightly wrong?" — the padding absorbs small errors, but a badly wrong box either under- or over-masks; there's no cross-check against a second OCR pass.
- "How would you extend this to handle handwriting or non-Latin scripts?" — tesseract supports other trained language packs, but the checksum detectors (Luhn, Verhoeff, SSN, PAN, GSTIN) are all fixed-format patterns that would need per-locale variants; nothing here generalizes automatically.
- "What if two PII spans overlap partially, not one-contained-in-another?" — the current merge only handles full containment (keep the longer span); a genuine partial overlap between two different PII kinds isn't specified behavior and would need a decision (merge into one region covering both, or keep both).

## See also

- [document-capture-pipeline.md](../architecture/document-capture-pipeline.md)
- [image-processing-and-rasterization.md](../node-express/image-processing-and-rasterization.md)
