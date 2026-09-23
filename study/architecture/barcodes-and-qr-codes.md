# Barcodes and QR Codes: Encoding, Checksums, and What a Label Should Actually Contain

> A barcode is a serialization format for a string, nothing more — the interesting engineering questions are what string goes in, how you catch a corrupted read before it reaches the database, and who can act on a code once it's out of your control.

**Category:** Architecture
**Introduced by:** Phase 28 — StockLedger's GS1 barcode validation (`utils/gtin.ts`) and QR label generation (`services/stock/labelService.ts`)
**Verified against:** `qrcode` npm package 1.5.4; GS1 GTIN specification (publicly documented check-digit algorithm, verified by hand-calculation in this codebase's own test suite)

---

## Mechanism

### GS1 GTIN and the mod-10 check digit, worked through

A GTIN (Global Trade Item Number) is the umbrella term for what most people call a "barcode number" — UPC-A (12 digits) and EAN-13 (13 digits) are both GTINs at different lengths, alongside GTIN-8 and GTIN-14. Every valid GTIN's last digit is a **checksum**, computed from every digit before it, which exists purely to catch a single mistyped or misscanned digit before it's trusted as real data.

The algorithm, walking `isValidGtin` in `utils/gtin.ts`: starting from the digit immediately to the *left* of the check digit and moving leftward, alternate multiplying each digit by 3 and by 1 — the rightmost of the remaining digits gets weight 3, the next gets weight 1, then 3, then 1, and so on — sum everything, and the check digit is whatever value, added to that sum, would make the total a multiple of 10:

```
checkDigit = (10 - (sum mod 10)) mod 10
```

The outer `mod 10` handles the one edge case: if `sum mod 10` is already `0`, `10 - 0 = 10`, which isn't a valid single digit — the second `mod 10` folds that case to `0`, since a sum already divisible by 10 needs a check digit of 0, not 10.

Concretely, for GTIN-13 `4006381333931`: the check digit is `1`, and the body is `400638133393`. From the rightmost body digit leftward, the weights alternate `3,1,3,1,...`: `3×3 + 9×1 + 3×3 + 3×1 + 3×3 + 1×1 + 8×3 + 3×1 + 6×3 + 0×1 + 0×3 + 4×1 = 9+9+9+3+9+1+24+3+18+0+0+4 = 89`. `(10 - (89 mod 10)) mod 10 = (10 - 9) mod 10 = 1` — matches the check digit, so the code is valid. Flip any single digit in the body and the sum changes by a nonzero multiple of the position's weight (1 or 3), which is never a multiple of 10 for a single-digit change at a fixed position — so a single-digit transcription error is *always* caught. (Certain digit-transposition errors can still slip through undetected — mod-10 with alternating 1/3 weights catches all single-digit errors but not every possible transposition, which is a known, accepted limitation of this checksum family, not specific to this implementation.)

This is exactly the same *category* of defense — a cheap arithmetic check that turns "garbage in" into "rejected at the boundary" rather than "silently corrupts a downstream record" — as the Luhn and Verhoeff checksums this codebase's PII-detection note (`security-auth/pii-detection-and-redaction.md`) already documents for card and Aadhaar numbers. All three exist for the identical reason: a human or a scanner will occasionally produce a single wrong digit, and a checksum is the cheapest possible way to catch that before it becomes bad data in a database.

`isValidGtin` accepts lengths 8, 12, 13, and 14 — the four real GTIN lengths GS1 defines — and rejects anything else outright via a length-and-digits-only regex before any arithmetic runs. It's used purely as an input-quality gate on `stock_items.barcode`: an item *can* be created with no barcode at all, or (deliberately) with an arbitrary non-GTIN string if the org's own internal barcode scheme doesn't follow GS1 — the check only refuses a barcode that *claims* to be shaped like a GTIN (right digit count) but fails its own checksum, which is a strong signal of a typo or a bad scan, not a legitimate internal code.

### QR code structure — what's verified here and what's flagged as not

A QR (Quick Response) code encodes data as a 2D grid of black/white modules, with structural elements (three large "finder" squares at three corners, a smaller "alignment" square, and timing patterns) that let a scanner locate and correct the code's orientation from any angle. Beyond that structural sketch, most of QR's internal machinery — the specific Reed–Solomon error-correction math, the exact bit-layout algorithm, mask-pattern selection — is delegated entirely to the `qrcode` npm library; this codebase does not implement or verify any of that math itself, and this note does not claim to. What *is* directly configured and worth understanding:

- **Error correction level.** QR codes carry redundant data so a partially damaged, dirty, or poorly-lit code can still scan. Four levels exist — L (~7% of the code can be reconstructed if damaged), M (~15%), Q (~25%), H (~30%) — each higher level trading more redundancy for less raw data capacity at a fixed physical size. `labelService.ts` uses `errorCorrectionLevel: 'M'`, a reasonable middle default for a printed warehouse label (handles light wear and smudging) without inflating the module count the way H would for a payload that's already short.
- **Data capacity vs. payload length.** A QR code's *version* (its grid size, from 21×21 up to 177×177) is chosen automatically by the encoding library based on how much data needs to fit at the chosen error-correction level — this codebase never manually picks a version, and doesn't need to, because the payload (a URL plus a UUID, well under 100 characters) fits comfortably in a small, easily-scanned code at any reasonable error-correction level.

### Why the payload is a bare URL + UUID, not a name, price, or org id

`labelService.ts`'s own header comment states the payload contract directly: `${FRONTEND_URL}/app/stock/scan/<kind>/<id>` — a route and a UUID, nothing else. This is a deliberate security-by-minimization choice, not an oversight of "we could have put more in." A QR code, once printed and stuck on a physical shelf or box, is trivially readable by *anyone* with a phone camera — there is no access control on the act of scanning itself. Encoding the item's name, its cost, or the organization's identity directly into the payload would leak that information to literally anyone who photographs the label, with no way to ever revoke it (a printed label can't be patched). Encoding nothing but an opaque route and a UUID means a scanned label, on its own, reveals only "this is some StockLedger entity" — resolving it into anything meaningful (an item name, a quantity, a cost) requires the scan route's own server-side lookup, which — like every other StockLedger route — is scoped to the caller's authenticated org via the verified access token (rule 1). A label photographed by someone outside the organization, or lost, or scanned by accident, therefore leaks nothing beyond "a QR code exists here" — it's exactly as informative as a bare, unguessable UUID to anyone not already an authenticated member of the owning org.

This is the same reasoning `oauth2-pkce-and-secrets-at-rest.md` applies to why an OAuth `state` parameter carries no sensitive data of its own — a value that will pass through an environment you don't control (a URL bar, a printed label, a photograph) should be treated as public the instant it leaves your server, and its job is to be an unguessable *reference*, never the sensitive data itself.

### SVG vs. PNG/raster, and why generation happens server-side

QR generation happens once, server-side, as SVG — `QRCode.toString(payload, { type: 'svg', ... })` — never client-side and never as a raster PNG. Two reasons stack:

- **Vector scales losslessly.** A label sheet needs to render the same QR code at multiple physical sizes (small/medium/large presets — `.label-sm`/`.label-md`/`.label-lg` in `index.css`) and, ultimately, on a printer whose DPI the browser doesn't control. An SVG is defined by paths and coordinates, not a pixel grid, so scaling it up or down for print never introduces the blocky pixelation a raster image would show when scaled past its native resolution — and a QR code, uniquely among images, becomes *unscannable* rather than just ugly if scaling blurs the sharp module edges a scanner's decoder depends on.
- **Server-side generation keeps the payload construction, and its `FRONTEND_URL` base, in one trusted place.** Generating on the client would mean shipping the URL-construction logic (and the base URL configuration) to the browser and trusting it there; generating server-side means the payload a label actually encodes is exactly what the server decided it should be, with no way for a compromised or modified client to alter what gets embedded in a printed code before it's ever scanned. `labelService.ts` also caches identical payloads within one `buildLabels` call (`qrCache`), since several requested copies of the same label all encode the identical URL and there's no reason to re-run the encoding library once per copy.

### `<img>` with a data URI, never `dangerouslySetInnerHTML`

The generated SVG string reaches the client as a JSON field (`qrSvg`) and is rendered as `<img src="data:image/svg+xml;base64,${btoa(qrSvg)}" alt="QR code for ...">` — an ordinary `<img>` tag pointed at a data URI, never injected into the DOM via `dangerouslySetInnerHTML` (which would parse the string as live HTML/SVG markup and execute anything embedded in it). This is the same discipline as `schema-driven-forms-and-print-layouts.md`'s note on the same choice: an `<img>` treats its `src` as opaque image data to be rasterized, never as markup the DOM tree will parse and potentially execute scripts from — so even if the SVG string origin were ever less trusted than "generated by our own server from a URL our own server constructed," rendering it as an image source rather than inline markup closes off the XSS surface a raw SVG injection would open.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Linear barcode (UPC/EAN/Code128) instead of QR | Smaller, cheaper scanners can be simpler | Rejected as the primary label format — a linear barcode encodes only a short numeric/alphanumeric string with no built-in error correction beyond a single check digit, whereas the payload here is a full URL; QR's error correction and higher data density are a better fit for a printed warehouse label that will get scuffed |
| Encode item name/cost/org directly in the QR payload | One scan gives full info with no network round trip | Rejected — a printed label is scannable by anyone; encoding sensitive business data directly into it leaks that data to anyone who photographs the label, permanently and unrevocably |
| Client-side QR generation | No server round trip needed to render a preview | Rejected — keeps payload construction and the frontend base URL configuration entirely server-side, and avoids re-implementing the encoding logic twice |
| Raster (PNG) QR output | Slightly smaller payload for a very simple code | Rejected — loses lossless scaling across the label-size presets and risks blur-induced unscannability at large print sizes |
| `dangerouslySetInnerHTML` for the SVG | Avoids a base64 data-URI wrap | Rejected — treats the string as live markup the DOM parses and can execute, rather than opaque image data |

## Where it lives in this codebase

- `server/src/utils/gtin.ts` — `isValidGtin`, the mod-10 GTIN checksum
- `server/src/services/stock/labelService.ts` — `buildLabels`, the QR payload construction and SVG generation, with the payload-minimization reasoning stated directly in the file's header comment
- `server/src/schemas/stock/labelSchema.ts`, `server/src/controllers/stock/labelController.ts`, `server/src/routes/stock/labelRoutes.ts` — the request/response boundary
- `client/src/Pages/stock/StockLabelsPage.tsx` — renders each `qrSvg` as an `<img src="data:image/svg+xml...">`, never `dangerouslySetInnerHTML`
- `server/src/__tests__/stock/labels.test.ts` — 12 tests, including an `<img>`-safe-rendering assertion and a payload-shape assertion
- `server/src/__tests__/stockCodePattern.test.ts` (indirectly) — GTIN validation is exercised alongside code-pattern rendering in the item creation tests

## Gotchas

- **A GS1 checksum only proves the code is internally *well-formed*, not that it corresponds to a real registered product.** `isValidGtin` catches a mistyped digit; it says nothing about whether the GTIN was ever actually issued by GS1 to anyone — that would require a lookup against GS1's own registry, which this codebase doesn't have and doesn't need (barcodes here are an input-quality gate on an org's own item data, not a global product-identity claim).
- **The QR payload's security depends entirely on the scan route being genuinely org-scoped.** If `lookupService.lookupById` (or any route the scan page calls) ever dropped its `org_id` predicate, a scanned label from one organization could resolve against another organization's data — the label's own minimal payload is only as safe as the authorization check behind it, not a substitute for one.
- **Error-correction level is a one-time choice baked into every already-printed label.** Changing `errorCorrectionLevel` in the service only affects labels generated *after* the change — a batch of labels already printed at level M doesn't retroactively become more damage-tolerant.
- **This note does not claim to have verified QR's internal Reed–Solomon/mask-selection algorithms** — those are entirely the `qrcode` library's responsibility, and the specifics of that math are outside what's actually implemented or checked in this codebase.

## Interview Q&A

**Q: How does a barcode checksum digit actually work?**
A: Walking the digits from right to left (excluding the check digit itself), you alternate multiplying by two fixed weights — 3 and 1 for GS1's GTIN family — sum the results, and the check digit is whatever value would make that sum plus the check digit a multiple of 10. Any single-digit transcription error changes the weighted sum by a nonzero amount that's never itself a multiple of 10 at that position, so the checksum catches it. It's a cheap, purely arithmetic defense against exactly the failure mode you'd expect from a human retyping a number or a scanner misreading one digit — not a security mechanism, just a data-quality gate.

**Q: Why would you deliberately choose a middle error-correction level like M rather than the highest available, H?**
A: Error correction and data capacity trade off at a fixed physical size — more redundancy means fewer usable data bits before the code has to grow (more modules, a bigger printed square) to fit the same payload. For a payload that's already short (a URL plus a UUID, well under 100 characters), the difference in physical size between M and H is small, but M is a sensible default that tolerates real-world wear (light smudging, a corner scuff on a warehouse label) without over-paying in code density for protection the use case doesn't need. If the labels were going somewhere genuinely harsh — outdoor, exposed to abrasion — bumping to Q or H would be the right call.

**Q: Why not just encode the item's name and cost directly into the QR code instead of a bare URL and ID?**
A: Because a printed QR code has no access control on the act of scanning — literally anyone with a camera can read it, and once it's printed and stuck on a shelf, you can't revoke or update what's encoded in it. Putting business data directly in the payload means that data leaks to anyone who photographs the label, permanently. Encoding only an opaque route and a UUID means the label alone tells a stranger nothing beyond "this is some entity in this system" — actually resolving it into a name, quantity, or cost requires hitting the server's scan-lookup route, which enforces the same org-scoped authentication and authorization every other endpoint in this system does. The label is a pointer, not a payload.

**Q: Why generate the QR image as an SVG on the server rather than as a PNG, or client-side in the browser?**
A: SVG is vector data — paths and coordinates rather than a fixed pixel grid — so scaling it to different label sizes (small/medium/large presets, or an arbitrary printer DPI) never introduces blur or pixelation the way scaling a raster image up would. That matters specifically for QR codes because unlike a photo, a blurred QR code doesn't just look worse — it can become genuinely unscannable, since the decoder depends on sharp module edges. Server-side generation also keeps the actual payload construction — the URL, the frontend base — in one trusted place, rather than shipping that logic to the client and trusting whatever runs there to build the same URL correctly.

**Q: The QR SVG comes back from the server as a string. How do you render it in React without opening an XSS hole?**
A: Wrap it as a data URI and put it in an ordinary `<img src="data:image/svg+xml;base64,...">` tag, never pass the raw SVG string to `dangerouslySetInnerHTML`. An `<img>` tag treats its `src` as opaque image data to be rasterized by the browser's image decoder — it never gets parsed as live DOM markup, so even if the SVG string somehow contained something malicious, there's no code path by which it would execute. `dangerouslySetInnerHTML` does the opposite: it inserts the string directly as markup the DOM parses, which is exactly the mechanism that turns an untrusted string into arbitrary script execution.

**Q: What does a valid GTIN checksum actually prove, and what does it not prove?**
A: It proves the number is internally self-consistent — specifically, that it hasn't suffered a single-digit transcription error, which is the overwhelmingly common real-world failure mode for hand-typed or poorly-scanned barcodes. It proves nothing about whether that GTIN was ever actually registered to a real product by GS1 — that would require an external lookup against GS1's own database, which this system doesn't perform and isn't trying to. It's a data-quality gate on input the org is choosing to enter, not a claim of global product-identity verification.

## Follow-ups they'll dig into

- "What transposition errors can a mod-10/alternating-weight checksum miss?" — certain adjacent-digit swaps where the difference happens to be a multiple of the modulus can slip through; this is a known, accepted limitation of the checksum family, not something this implementation tries to close.
- "How would you support scanning a barcode/QR with a phone camera in the browser itself, rather than a separate scanner app?" — a client-side decoding library (e.g. one using `getUserMedia` + a WASM QR/barcode decoder) feeding the same scan-route lookup; not built here, since labels are printed and scanned by external hardware or a phone's native camera/scanner app that then opens the resolved URL directly.
- "What would you need to add if labels had to work offline, with no connectivity to resolve the scan URL?" — the payload itself would need to carry enough data to be useful without a round trip (defeating the minimization argument above), which is a real trade-off this design doesn't attempt to solve — it assumes the scanning device has network access.

## See also

- [../security-auth/pii-detection-and-redaction.md](../security-auth/pii-detection-and-redaction.md) — the Luhn/Verhoeff checksums, the same defensive category applied to card and Aadhaar numbers
- [../security-auth/oauth2-pkce-and-secrets-at-rest.md](../security-auth/oauth2-pkce-and-secrets-at-rest.md) — the same "a value that leaves your server should carry no sensitive data of its own" reasoning, applied to an OAuth `state` parameter
- [../react/schema-driven-forms-and-print-layouts.md](../react/schema-driven-forms-and-print-layouts.md) — the client-side rendering of these labels, including the print-layout CSS they share a page with
- [inventory-valuation-and-perpetual-stock.md](inventory-valuation-and-perpetual-stock.md) — what a scanned SERIAL/LOT/ITEM label actually resolves to
