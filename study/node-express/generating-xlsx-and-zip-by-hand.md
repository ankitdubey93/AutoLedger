# Generating XLSX and ZIP by hand (and exporting safely)

> An .xlsx is a ZIP of XML parts. We write both formats ourselves with `node:zlib`, with no package, and the integer-cents rule survives because money is written from integers, never floats.

**Category:** Node/Express · Security
**Introduced by:** Phase 45 — PDF/Excel/CSV export for every report
**Verified against:** Node 22.23.2 (`zlib.crc32` was added in v22.2.0 — hence `engines.node ">=22.2"`), pdfkit as already in the repo, ECMA-376 / ISO 29500 SpreadsheetML, PKWARE APPNOTE 6.3.x. Not verified against Microsoft Excel itself — only LibreOffice (`soffice --headless --convert-to csv`) and `unzip -t`. Flagged: Excel is stricter than LibreOffice about some parts, so an Excel-only "repair" prompt is the residual risk.

---

## Mechanism

### The ZIP container

A ZIP is a sequence of **local file headers + data**, then a **central directory** (one record per file, repeating the sizes/CRC and holding the offset of the local header), then an **end-of-central-directory (EOCD)** record that holds the directory's offset and entry count. Readers start at the *end* (scan back for the EOCD signature `0x06054b50`), jump to the central directory, then to each local header. That is why you can append to a ZIP without rewriting it and why a truncated ZIP is unreadable: the index is at the back.

Our `buildZip` writes, per entry: signature `0x04034b50`, version 20, flags `0x0800` (names are UTF-8), method (8 = deflate, 0 = stored), time/date, CRC-32, compressed size, uncompressed size, name length, extra length 0, name, data. The CRC is of the **uncompressed** bytes — hashing the deflated buffer is the classic mistake, and every reader rejects it.

- **Raw deflate, not zlib-wrapped.** ZIP method 8 is a bare RFC 1951 stream. `zlib.deflateSync` adds a 2-byte header and an Adler-32 trailer (RFC 1950) and is wrong here; `deflateRawSync` is right. The tests' `readZip` uses `inflateRawSync`.
- **Stored fallback.** When deflate makes a buffer bigger (random bytes) we write method 0.
- **Fixed timestamp.** The DOS date is pinned to 1980-01-01 so the same input produces byte-identical output. That makes the writer testable with `Buffer.equals` and makes downloads cacheable/diffable. A real "now" would make every test snapshot flaky.
- **No ZIP64.** Past 65535 entries or a 4 GiB size/offset we throw rather than emit a malformed file. A report has 6 parts.
- **CRC-32** is `zlib.crc32(buffer)` (Node 22.2+). Before that you needed a 256-entry table; the table version is 10 lines and a fine fallback.

### The OOXML package on top

An .xlsx needs: `[Content_Types].xml` (maps every part to a MIME type — a part missing here makes Excel "repair" the file), `_rels/.rels` (points to the workbook), `xl/workbook.xml` (sheet list), `xl/_rels/workbook.xml.rels` (workbook → sheet, workbook → styles), `xl/styles.xml`, and `xl/worksheets/sheet1.xml`. Six parts total.

- **Inline strings vs sharedStrings.** Cells can be `t="inlineStr"` (`<is><t>…</t></is>`) so there is no `sharedStrings.xml` to build and keep consistent. The cost is a larger file when strings repeat, which a report with a few hundred rows does not feel. Excel rewrites them as shared strings on save.
- **Styles are an index.** `cellXfs` is an ordered array and a cell says `s="2"`. We fix nine styles (text, bold text, money, money bold, date, percent, quantity and bold variants). Reordering them silently re-styles every cell — the writer's tests pin the indexes.
- **Numbers are numbers.** A money cell is `<c s="2"><v>1234.56</v></c>`, with the number format `#,##0.00` doing the display. The value comes from integer cents via string arithmetic (`centsToDecimal`: `Math.trunc`, `%`, `padStart`), not `cents / 100`. Writing `123456 / 100` would usually come out right but a float is exactly what rule 3 forbids, and `0.1 + 0.2` shows why. The string `"1234.56"` is also parsed by Excel into a double — the cell is then subject to Excel's 15-digit precision, a limit of the file format we cannot remove (flag: amounts over ~10^13 in cents lose digits *in Excel*, not in our CSV).
- **Dates** are serial numbers (`Date.UTC(y, m-1, d)/86400000 + 25569`) with style `numFmtId 14`. Excel has a deliberate 1900 leap-year bug; serials after 1900-03-01 are unaffected, so we ignore it.
- **Text sanitising.** XML-escape `& < > " '` and strip control characters illegal in XML 1.0 (`\u0000–\u0008`, `\u000B`, `\u000C`, `\u000E–\u001F`). One stray `\u0001` from a vendor name makes the whole file unreadable.
- **Sheet names** cannot contain `\ / ? * [ ] :` and are capped at 31 characters.

### CSV

CSV for a spreadsheet user needs three decisions: a **BOM** (`﻿`) so Excel reads UTF-8 rather than the local code page; **CRLF** line endings (RFC 4180); and **quoting** (wrap in `"` for `, " \r \n` or leading/trailing space; double any `"`).

**CSV/formula injection (OWASP).** A text cell beginning `=`, `+`, `-`, `@`, TAB or CR is executed as a formula by Excel/Sheets (`=HYPERLINK(...)`, DDE payloads). A vendor name is attacker-controlled text that a bookkeeper will export. We prefix such *text* cells with `'`. Money cells are not text, so `-5.00` is not guarded — otherwise every negative number would be corrupted. The guard checks the original value's first character, before indentation is applied.

### Download headers and CORS

The response carries `Content-Disposition: attachment; filename="…"` and `Cache-Control: no-store` (a financial report must not sit in a shared cache). The SPA runs on another origin, and a browser only exposes the **CORS-safelisted response headers** (`Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`, `Last-Modified`, `Pragma`) to `fetch`. `Content-Disposition` is not on the list, so `apiDownloadBlob` could never read the filename cross-origin until `exposedHeaders: ['X-Request-Id', 'Content-Disposition']` was added. That was a **pre-existing bug found by this phase**: it was hidden because the dev proxy and the same-origin production setup both bypass CORS, and the client had a `'download'` fallback.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `exceljs` / `xlsx` / `sheetjs` | Full feature set, but a large dependency tree, a history of prototype-pollution/ReDoS advisories in the SheetJS community edition, and rule 14 forbids a dependency before the phase needs it | Rejected — we need one flat sheet |
| CSV only | Trivial, but loses number formats, column widths and the frozen header; "Excel opens it as text" is a real support burden | Rejected as the only format |
| Server PDF only | Not editable | Rejected as the only format |
| Hand-written ZIP + SpreadsheetML on `node:zlib` | ~250 lines, byte-level tests, one subtle area (Excel strictness) | **Chosen** |
| Push to Google Sheets via Drive API | OAuth scopes, token storage, a new integration | Rejected — Sheets imports .xlsx/.csv |

## Where it lives in this codebase

- `server/src/utils/zipWriter.ts`, `xlsxWriter.ts`, `reportCsv.ts`, `reportCellText.ts`
- `server/src/__tests__/helpers/zipReader.ts` — an independent reader, so the writer is not tested against itself
- `server/src/services/accounting/reportPdfRenderer.ts` — pdfkit, same Helvetica/WinAnsi limitation as quotes
- `server/src/controllers/accounting/reportExport.ts` — `readReportFormat`, `sendReportFile`
- `server/src/app.ts` — `exposedHeaders`

## Gotchas

- Hash the uncompressed bytes. Use raw deflate.
- An XML-illegal control character corrupts the whole part.
- An Excel "repair" dialog is nearly always a `[Content_Types].xml` or `.rels` `Target` mismatch.
- `zlib.crc32` does not exist before Node 22.2; the `engines` field is the guard.
- PDF text is WinAnsi: Latin only; non-Latin names render wrongly. Stated, not fixed.
- The whole file is built in memory on the request. Fine at the 20,000-line cap, a queued export job otherwise.

## Interview Q&A

**Q: What is inside an .xlsx file?**
A: A ZIP archive of XML parts: `[Content_Types].xml`, relationship files, `workbook.xml`, `styles.xml` and one `sheetN.xml` per sheet. Cell values are `<v>` numbers or inline/shared strings; the displayed format comes from a style index into `cellXfs` whose `numFmtId` points at a format string. We write six parts.

**Q: Why is the central directory at the end of a ZIP?**
A: So an archive can be created in one streaming pass: you do not know a file's compressed size and CRC until you have written it, so the per-file records that need them are collected and written last. Readers locate the EOCD at the end, read the directory offset from it, and seek.

**Q: A ZIP entry fails the CRC check. What are the likely causes?**
A: Hashing the compressed rather than the uncompressed bytes; mixing zlib-wrapped and raw deflate; or writing the stored size where the compressed size belongs. The fix is in the writer, not the library.

**Q: Why write money into the spreadsheet from integer cents rather than `cents / 100`?**
A: The system's rule is that money is never a float. Formatting integers by integer division and remainder yields an exact decimal string; the spreadsheet then parses it. Dividing produces a binary float whose string form usually, but not provably, round-trips, and it normalises the habit we are trying to avoid.

**Q: What is CSV injection and how do you stop it without breaking negative numbers?**
A: Spreadsheet applications evaluate cells that start with `= + - @` (and TAB/CR) as formulas, so attacker-controlled text such as a vendor name can run `=HYPERLINK(...)` on the accountant's machine. Prefix *text* cells with an apostrophe. Numbers are not text, so a negative amount is written as a number and untouched.

**Q: The frontend can't read the filename from `Content-Disposition`. Why?**
A: Cross-origin, a browser exposes only CORS-safelisted response headers. The server must list others in `Access-Control-Expose-Headers`. Same-origin setups (the Vite proxy) hide the bug, which is how it survived until the phase tested CORS explicitly.

**Q: Why a fixed timestamp in the ZIP?**
A: Determinism. Identical input gives identical bytes, so the writer is testable with a byte comparison and the output is reproducible. A real mtime would add noise with no value for a generated report.

**Q: When would you reach for a library instead?**
A: Multiple sheets, formulas, rich styles, shared-string optimisation, streaming of millions of rows, or reading uploaded workbooks. Then the dependency is worth its surface. For one flat sheet it is not.

## Follow-ups they'll dig into

- "How would you stream a million-row export?" Switch to a streaming zip with data descriptors (flag bit 3, sizes after the data), write rows incrementally, and move generation to a worker.
- "Does Excel open it?" We verified with LibreOffice and `unzip -t`; Excel itself is the unverified edge.
- "What about files above 4 GiB?" ZIP64 — deliberately unbuilt, we throw.

## See also

- [parsing-untrusted-csv.md](parsing-untrusted-csv.md) — the import side of the same format
- [../security-auth/user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md) — another place untrusted text is rendered into an interpreted format
