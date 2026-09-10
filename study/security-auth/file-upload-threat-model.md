# File Upload Threat Model: MIME Spoofing, Path Traversal, Header Injection

> A file upload is the one place a client hands the server bytes it didn't write and a filename it doesn't control. Every field in that request — the `Content-Type` header, the original filename, the size — is a claim the attacker makes about their own data, not a fact. The Document Vault trusts none of them.

**Category:** Security & Auth
**Introduced by:** Phase 9.5 — the Document Vault's `POST /documents`, `utils/mimeSniff.ts`, `services/storageService.ts`
**Verified against:** Node 22, Express 5.2, `multer` 2.3.0, PostgreSQL 16

---

## Mechanism

### The `Content-Type` header is an attacker-controlled string

Multipart form data carries a `Content-Type` per part, set by whatever wrote the request — the browser, or a script that built the multipart body by hand. There is no cryptographic or protocol-level guarantee that the bytes that follow actually match it: nothing stops a client from sending a PHP web shell with `Content-Type: application/pdf`. Trusting it (`file.mimetype === 'application/pdf'`) is trusting the attacker's own label for their payload. The only trustworthy signal is the content itself.

### Magic-byte sniffing, and why CSV has none

Most binary formats begin with a fixed byte sequence — a *magic number* — that identifies them independent of any header or extension:

```
PDF:   25 50 44 46 2D         ("%PDF-")
PNG:   89 50 4E 47 0D 0A 1A 0A
JPEG:  FF D8 FF
```

`utils/mimeSniff.ts` checks these first, in order, against the first bytes of the uploaded buffer — never the client's header, never the original filename. A PNG renamed `invoice.pdf` is still reported as `image/png`, because the signature is read from the bytes and the filename never overrides it.

CSV has no signature — it's plain text, and plain text has no reserved byte prefix. So `sniffMimeType` falls back to a *content property* rather than a signature: the buffer must be non-empty, contain no `0x00` byte (binary data routinely does; text essentially never does), and round-trip losslessly through UTF-8 decode-then-re-encode. That round-trip check is the load-bearing part — `Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)` fails whenever the original bytes weren't valid UTF-8, because decoding invalid UTF-8 substitutes the replacement character (`U+FFFD`) for the bad byte, and re-encoding that produces a *different* byte sequence than what went in. A binary file — including one whose magic bytes didn't match PDF/PNG/JPEG, like a stray archive or executable — will almost never survive this round trip. Only after that filter is `originalFilename` finally consulted, and only to require a literal `.csv` suffix — the filename is the last check, not the first, and it can only narrow an already-text-shaped buffer further, never promote binary data to `text/csv`.

### Path traversal through a filename or a hash

A classic upload vulnerability: the server builds a save path by concatenating server-controlled directories with an attacker-controlled string — `path.join(uploadDir, req.body.filename)`. If that string is `../../etc/cron.d/evil`, the join walks outside `uploadDir` entirely, and Node's `path.join` does not stop this — it normalizes `..` segments, it doesn't reject them.

The Document Vault never builds a path from anything client-supplied. `services/storageService.ts`'s `blobPath(orgId, sha256)` builds the on-disk path from exactly two values, and both are validated against a strict regex — a v4-shaped UUID for `orgId`, 64 lowercase hex characters for `sha256` — **before** either reaches `path.join`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function blobPath(orgId: string, sha256: string): string {
  if (!UUID_RE.test(orgId) || !SHA256_RE.test(sha256)) {
    throw new ApiError(400, 'Invalid storage key');
  }
  return path.join(env.STORAGE_ROOT, orgId, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}
```

A string matching `^[0-9a-f]{64}$` cannot contain `/`, `\`, or `.` — it structurally cannot form a `..` traversal segment, because the character class itself excludes every character traversal needs. This is a *positive* allowlist (only these characters may appear) rather than a *negative* denylist (reject strings containing `..`) — denylists are the weaker defense, because they enumerate known-bad patterns and miss encodings the author didn't think of (`..%2f`, `....//`, a URL-decoded variant). An allowlist regex has no such gap: anything that isn't exactly 64 hex characters is rejected, full stop. The original filename the user typed — `../../whatever.pdf` — never touches a path at all; it's stored as `original_filename` in the database, used only for display and for the `Content-Disposition` header (sanitized separately, see below).

The alternative some codebases use — build the path, then check `resolvedPath.startsWith(uploadDir)` — works but is strictly weaker: it validates *after* the join has already happened, so a bug in the join logic or the normalization step is caught late instead of never occurring. Validating the inputs before they're ever concatenated closes the door structurally rather than checking whether it happened to stay shut.

### `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` — stopping stored XSS

A file upload endpoint that serves files back is a stored-XSS vector if the browser is ever allowed to *execute* what it downloads. Two headers close this, and they close different halves of the problem:

- **`Content-Disposition: attachment; filename="..."`** tells the browser "save this, don't render it in the page." Without it, a `GET` to the file endpoint would render inline — an uploaded `.html` file (even one that slipped past the MIME allowlist some other way) opened directly in the browser's origin would execute any script it contained, with access to that origin's cookies. `attachment` forces a save-to-disk dialog instead of a same-origin render.
- **`X-Content-Type-Options: nosniff`** tells the browser "trust the `Content-Type` I'm sending you; don't second-guess it by sniffing the bytes yourself." Browsers have historically sniffed content to guess a "real" MIME type when a server's stated type looked wrong or generic — useful for tolerating misconfigured servers, dangerous when it means a browser decides a response *looks like* HTML and renders it as HTML regardless of what `Content-Type` said. `nosniff` turns that guessing off.

Used alone, each header closes only half the gap: `nosniff` without `attachment` still lets a correctly-typed file render inline (a PDF opens in the PDF viewer, which is fine, but stops being fine if the MIME sniffer downstream in `mimeSniff.ts` were ever wrong); `attachment` without `nosniff` still risks the pre-download sniff on browsers that inspect content before honoring the disposition. Together, the file is both forced to download and, in the moment before that happens, never re-interpreted as something more dangerous than its declared type.

### Header injection through an unsanitized filename

`original_filename` is user-supplied text with no charset or character restriction beyond length — it could legally contain `"`, a backslash, or (this is the actual attack) a literal CRLF sequence. Dropped unsanitized into `Content-Disposition: attachment; filename="${originalFilename}"`, a filename containing `\r\nSet-Cookie: ...` becomes a second HTTP header the attacker chose the content of — classic CRLF/HTTP response splitting. `documentController.ts`'s `safeFilename` strips every quote, backslash, and control character (`\r`, `\n`, and everything below `0x20`) before the value ever reaches a header:

```ts
function safeFilename(name: string): string {
  return name.replace(/["\\\r\n\x00-\x1f]/g, '');
}
```

### Why the size cap has to live in `multer`'s own `limits`, not after the buffer is assembled

`express.json()`'s `1mb` body limit does not apply to multipart bodies at all — multer parses those with its own reader, independent of the JSON body parser. Checking `buffer.byteLength > MAX_UPLOAD_BYTES` *after* multer has already read the whole file into memory means the damage — an arbitrarily large allocation — has already happened; the check would just decide whether to discard it afterward. `multer({ limits: { fileSize: MAX_UPLOAD_BYTES } })` instead makes multer itself abort the read mid-stream the moment the limit is crossed, so a 500MB upload never fully materializes in memory before being rejected.

### Decompression bombs — a stated non-defense here

A "zip bomb" (or gzip bomb) is a small compressed file that expands to an enormous size when decompressed — a classic denial-of-service vector for any pipeline that automatically extracts uploaded archives. The Document Vault has no exposure to this class of attack **because it never decompresses anything it stores** — the four allowed MIME types (PDF, PNG, JPEG, CSV) are all either already-compressed-but-self-contained formats or plain text, and no code path in this phase unzips, inflates, or otherwise expands an uploaded buffer. This is worth stating explicitly rather than leaving implicit: the day this vault accepts `.zip` or any other archive format, this whole non-defense stops being true and a real one is needed.

### Why `file-type` was refused

The Document Vault needs exactly four signatures and one text-property check — a few dozen lines. `docs/development.md`'s dependency policy (guardrails rule 14: no dependency before the phase that needs it) treats a parser this small the same way it treated `utils/csv.ts` and `utils/levenshtein.ts`: hand-write it rather than take on a package, its transitive dependencies, and its own security surface for a problem this narrow. A general-purpose sniffing library also recognizes hundreds of formats this codebase will never accept — every one of those code paths is attack surface the vault doesn't need and can't audit as carefully as four `Buffer.equals` comparisons.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Trust `req.file.mimetype` (the client's `Content-Type`) | Zero code | Rejected — it's an attacker-supplied claim about the attacker's own data; proves nothing |
| Extension-only checks (`.pdf`, `.png`) | Simple | Rejected — trivially defeated by renaming any file; the filename never reaches storage decisions here |
| `file-type` (or similar) npm package | Recognizes hundreds of formats out of the box | Rejected — guardrails rule 14; the vault needs four signatures, not a general-purpose sniffer's full surface |
| **Hand-written magic-byte + UTF-8-round-trip sniffer** | ~60 lines, must be tested against spoofed/renamed fixtures by hand | **Chosen** — no dependency, exactly the four types the allowlist needs, same call as `csv.ts`/`levenshtein.ts` |
| `multer.diskStorage` (write straight to disk as the upload streams) | Avoids buffering the whole file in memory | Rejected — the file must be hashed and sniffed *before* it's persisted anywhere; `memoryStorage` plus a `limits.fileSize` cap is what makes buffering safe at this size ceiling |
| A global multipart parser mounted beside `express.json` | One less line per route | Rejected — would turn every route into an upload target; `docs/development.md` states this explicitly. `singleFileUpload` is scoped to `POST /documents` alone |

---

## Where it lives in this codebase

- `server/src/utils/mimeSniff.ts` — `sniffMimeType`: the four-signature check plus the CSV text carve-out
- `server/src/services/storageService.ts` — `blobPath`: the traversal guard, validated before any `path.join`
- `server/src/middleware/upload.ts` — `singleFileUpload`: `multer.memoryStorage()`, the `fileSize`/`files`/`fields` caps, mapped `MulterError` → `ApiError`
- `server/src/controllers/documentController.ts` — `download`: `Content-Disposition`/`X-Content-Type-Options`, `safeFilename`
- `server/src/__tests__/mimeSniff.test.ts` — spoofed-signature fixtures (`a PNG renamed .csv is still a PNG`, `an executable claiming to be a PDF is refused`)
- `server/src/__tests__/storageService.test.ts` — `blobPath rejects a traversal attempt in the hash`, `blobPath rejects a non-UUID org id`

---

## Gotchas

- **A signature check only proves the *first* bytes match — it says nothing about the rest of the file.** A file could have a valid `%PDF-` header with a payload appended after a legitimate PDF trailer. This vault doesn't defend against a polyglot file that is simultaneously valid as two formats; it only refuses files whose header doesn't match any allowed signature at all.
- **The CSV check's UTF-8 round-trip is a necessary condition for "this is text," not a sufficient proof of "this is well-formed CSV."** A syntactically broken CSV (mismatched quotes, wrong column count) passes the MIME sniff — that's `utils/csv.ts`'s job at a later stage, not this one's.
- **`nosniff` only affects how *browsers* interpret the response — it does nothing for a non-browser client** (a script downloading the file directly and executing it locally). The header protects the browser-rendering attack surface specifically.
- **The size cap protects against one large file, not many small ones.** `MAX_UPLOAD_BYTES` bounds a single request; it says nothing about an authenticated user uploading thousands of small files back-to-back. That's a rate-limiting problem this phase doesn't address (see `docs/development.md`'s note on the login limiter being the only one wired up).

---

## Interview Q&A

**Q: Why can't you trust the `Content-Type` a client sends with a file upload?**
A: The client controls every part of a multipart request, including the `Content-Type` header on each part — it's a label the sender writes about their own data, with no cryptographic or protocol enforcement that the bytes actually match. Nothing stops a client from sending an executable with `Content-Type: application/pdf`. The only way to know what a file actually is is to look at the bytes themselves — a magic-byte signature, or for text formats, a content property like a successful UTF-8 decode.

**Q: How do you detect a file's real type without a library?**
A: Check the first few bytes against known format signatures — PDF starts with `%PDF-` (`25 50 44 46 2D`), PNG has an 8-byte fixed header, JPEG starts `FF D8 FF`. For a format with no signature, like plain-text CSV, fall back to a content property instead: the buffer must contain no NUL byte and must round-trip losslessly through UTF-8 decode-then-re-encode, which fails for genuinely binary data because decoding invalid UTF-8 substitutes replacement characters that don't re-encode back to the original bytes.

**Q: How do you prevent path traversal when saving an uploaded file by a user-influenced name?**
A: Never build the save path from anything the client sent, even indirectly. Build it entirely from server-computed values — here, a SHA-256 hash of the content and the already-authenticated org id — and validate *both* against a strict allowlist regex (exactly 64 lowercase hex characters; a v4 UUID shape) before either reaches `path.join`. A string matching that regex structurally cannot contain `/`, `\`, or `..`, so there's no traversal sequence to walk. This is stronger than building the path first and then checking the result starts with the expected directory, because it prevents the dangerous input from ever being concatenated rather than catching it after the fact.

**Q: What's the difference between `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and why do you need both?**
A: `Content-Disposition: attachment` tells the browser to save the response rather than render it inline in the page — without it, an uploaded HTML-like file served back could execute as a same-origin page. `X-Content-Type-Options: nosniff` tells the browser to trust the server's stated `Content-Type` rather than sniffing the actual bytes and guessing a different type worth rendering. They close different gaps: `nosniff` alone still allows an inline render of a file whose declared type genuinely is renderable; `attachment` alone still risks a pre-download sniff on browsers that inspect content before honoring the disposition header. Sent together, the browser is told both "don't render this" and "don't second-guess what it is" — the sniff-then-render attack chain is broken at both links.

**Q: Why can a filename in a `Content-Disposition` header be a security issue?**
A: If the filename is inserted into the header string unescaped and the client controls it, a filename containing a CRLF sequence (`\r\n`) can inject an entirely new HTTP header into the response — classic HTTP response splitting. The fix is stripping quotes, backslashes, and all control characters (including `\r`/`\n`) from the filename before it's interpolated into any header value, which is exactly what a `safeFilename` sanitizer does.

**Q: Where should a maximum upload size be enforced, and why does it matter?**
A: In the multipart parser's own streaming limits (`multer({ limits: { fileSize } })`), not as a check on the fully-assembled buffer afterward. A JSON body-size limit like `express.json({ limit: '1mb' })` doesn't apply to multipart uploads at all — multer reads those independently. If the size check only runs after the whole file is read into memory, an attacker has already forced that allocation before the rejection happens; enforcing the limit at the parser level aborts the read mid-stream instead.

**Q: When would a decompression-bomb defense actually be necessary here, and why isn't it now?**
A: It becomes necessary the moment any accepted format is decompressed or expanded server-side — accepting `.zip`/`.gz` and unpacking them, for instance. The Document Vault's four allowed types (PDF, PNG, JPEG, CSV) are never decompressed by any code path in this phase, so there's no expansion step a bomb could exploit. That's a property of the current allowlist, not a general guarantee — it would need explicit revisiting (streaming decompression with a hard output-size cap) before any archive format was added.

---

## Follow-ups they'll dig into

- *"What if the attacker crafts a polyglot file — valid as both a PNG and something else?"* A signature check only validates the header prefix; it doesn't preclude a trailer or embedded payload making the same bytes simultaneously interpretable as a second format by a different, more permissive parser somewhere downstream. Defending against that needs a stricter, format-specific validator (a real PDF/PNG parser rejecting trailing garbage), which this phase doesn't build — the sniff decides *storage acceptance*, not full structural validity.
- *"Why validate the UUID and the hash format inside `blobPath` instead of at the API boundary with zod?"* Both matter, but `blobPath` is the one function every caller — including a future internal one that skips the HTTP layer entirely — must go through to touch the filesystem. Putting the guard at the lowest common chokepoint means no caller can accidentally bypass it by constructing a path a different way; zod validation at the route boundary is a second, earlier line of defense that produces a friendlier `400` before the request even reaches the service.
- *"How would this change if uploads went to S3 instead of a local disk?"* The traversal concern shifts shape — an S3 key built from unvalidated input is an over-broad-access or key-collision risk rather than a local filesystem escape — but the same discipline applies: never build the object key from anything client-controlled, validate the components that do build it against a strict allowlist. `storageService`'s narrow `put`/`get`/`stat` interface is deliberately the seam where that swap would happen without touching any caller.

---

## See also

- [../architecture/file-storage-and-streaming.md](../architecture/file-storage-and-streaming.md) — what happens to a file once its type is accepted: content addressing, the org-keyed storage layout, and streaming it back out
- [../node-express/parsing-untrusted-csv.md](parsing-untrusted-csv.md) — the sibling untrusted-input parser this phase's CSV sniff defers structural validation to
- [webhook-signing-and-ssrf.md](webhook-signing-and-ssrf.md) — the other place this codebase treats an external input (a URL, here a file) as hostile by default
