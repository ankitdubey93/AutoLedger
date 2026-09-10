# File Storage and Streaming: Content Addressing, the Org-Keyed Trade, and Getting Bytes Back Out

> The simplest possible file store is "write it somewhere, remember where." The interesting decisions are how to name that "somewhere" so a duplicate upload is free, how to key it so one tenant can't learn what another tenant holds, and how to get the bytes back out without holding the whole file in memory a second time.

**Category:** Architecture
**Introduced by:** Phase 9.5 — the Document Vault, promoted from AP-Flow to shared platform infrastructure on 2026-09-10 (see `docs/roadmap.md#phase-renumbering--2026-09-10`)
**Verified against:** Node 22 (`node:fs`, `node:crypto`), Express 5.2, PostgreSQL 16

---

## Mechanism

### Content-addressed storage: naming a file by what it contains

A conventional file store names a blob by something extrinsic — a generated id, the original filename, an upload timestamp. Content-addressed storage instead names it by a hash of its own bytes: `services/storageService.ts`'s `put` computes `sha256(buffer)` and uses that hash as the file's identity. Two consequences fall out of this immediately, and both are load-bearing here:

1. **Deduplication is free and automatic.** Uploading the same bytes twice produces the same hash, which means the same path — the second `put` just overwrites the first with identical content, a no-op in every way that matters. `documentService.uploadDocument` turns this into an API-level idempotency guarantee: `INSERT ... ON CONFLICT (org_id, sha256) DO NOTHING RETURNING id` either creates a new metadata row or discovers the existing one, and the response's `created: boolean` tells the caller which happened (`201` vs `200`).
2. **The content can never silently drift from its name.** A conventional id-named file could be overwritten with different bytes while keeping the same id — nothing in the naming scheme would notice. A SHA-256-named file cannot be corrupted-in-place without also changing its name; the hash *is* an integrity check, for free, forever.

### Why this vault is org-keyed, not globally content-addressed

The naive extension of content addressing to a multi-tenant system is one global namespace: every organization's files live under `STORAGE_ROOT/<sha256>`, and two organizations uploading byte-identical files share one blob. AP-Flow's original single-app spec called for exactly this. Promoted to a suite-wide vault, that scheme has two real problems, not just a theoretical one:

- **A cross-tenant existence oracle.** If storage is keyed globally, one organization can test whether *another* organization has ever uploaded a specific file, by uploading that same file themselves and observing whether the operation reports "already existed" versus "newly created." For a suite whose entire premise is strict tenant isolation (guardrails rule 1), this is a real information leak — it doesn't reveal the file's *contents*, but it reveals a fact about another tenant's data that tenant never agreed to disclose.
- **Deletion becomes unsafe.** If a globally-shared blob is deleted because one organization no longer references it, and a second organization's metadata row still points at that same path, the second organization's document silently breaks. Safe deletion in a globally-addressed scheme requires a reference count across every tenant sharing that blob — real complexity for a problem the org-keyed design sidesteps entirely.

The vault's actual layout is `STORAGE_ROOT/<org_id>/<sha[0:2]>/<sha[2:4]>/<sha256>` — the organization id is the first path segment, so two organizations uploading identical bytes get two independent blobs at two independent paths. This costs disk (the same bytes stored twice, once per tenant that uploaded them) and buys the same trade this codebase makes everywhere else: tenant isolation is worth more than the storage savings, and every access path already scopes by `org_id` first regardless.

### Two-level hex fan-out

Within one organization's directory, blobs aren't stored flat — `<sha[0:2]>/<sha[2:4]>/<sha256>` splits on the hash's own first four hex characters, producing up to 256 first-level directories and 256 second-level directories under each, for up to 65,536 leaf directories total. This is the standard fix for a filesystem limitation: most filesystems degrade (directory listing, file creation, and lookup all get measurably slower) once a single directory holds tens of thousands of entries, because many implementations still do an effectively linear scan for a name lookup even when the underlying structure is a B-tree. Deriving the fan-out directories from the hash itself — rather than a separate counter or a date-based scheme — means no extra bookkeeping: the same `sha256` that names the file also determines exactly where it lives, and the split is perfectly random by construction (a hash's output bits are uniformly distributed), so no fan-out bucket grows disproportionately large relative to the others.

### The narrow `put`/`get`/`stat` interface as the object-storage seam

`storageService.ts` exposes exactly three operations:

```ts
export function blobPath(orgId: string, sha256: string): string;
export async function put(orgId: string, buffer: Buffer): Promise<{ sha256: string; byteSize: number }>;
export function get(orgId: string, sha256: string): Readable;
export async function stat(orgId: string, sha256: string): Promise<{ byteSize: number } | null>;
```

No caller anywhere in the codebase touches `node:fs` directly for document bytes — every read and write goes through this interface. That's deliberate: a local-filesystem backend is explicitly not a production-grade choice (it doesn't survive more than one server instance; two processes on two machines each see only their own disk), and the roadmap says so outright. When object storage (S3 or equivalent) eventually replaces it, the swap is contained entirely to this one file — every caller keeps calling `put`/`get`/`stat` with the same signatures, unaware the implementation now makes network calls instead of `fs` calls.

### Why the blob is written before the database row, and an orphan is tolerated

`uploadDocument`'s sequence is: sniff the MIME type, then `storageService.put` (write bytes to disk), *then* open a transaction and insert the metadata row. This ordering — filesystem write before database commit — is the only one that avoids a worse failure mode. Consider the alternative: commit the metadata row first, then write the blob. A crash between those two steps leaves a `documents` row whose `sha256` points at a file that was never written — every future `GET /documents/:id/file` for that row 404s or errors, and the row itself is otherwise indistinguishable from a healthy one. Writing the blob first means the *only* possible inconsistency after a crash is an orphaned file on disk with no database row pointing at it — inert, harmless, and eventually reclaimable, rather than a database row lying about the existence of data that was never actually persisted.

This ordering is also the direct, mechanical consequence of guardrails rule 5 — **no post-`COMMIT` follow-up work inside a request**. If the write order were reversed (commit the row, then write the file), the file write would be exactly the kind of "do something after the transaction closes" step rule 5 forbids, because a crash between `COMMIT` and the file write has no transaction left to roll back and silently loses the file while the row survives. Doing the filesystem write *before* opening the transaction sidesteps the problem instead of needing a queue to fix it: the transaction the request runs commits or rolls back atomically around the metadata alone, and the one thing that can go stale (a blob nobody's row references) is deliberately the harmless direction to fail in.

### Streaming a file back out: `pipe`, backpressure, and the mandatory `'error'` listener

Downloading a file could buffer the whole thing into memory (`fs.readFile`, then `res.send(buffer)`) or stream it directly to the response (`fs.createReadStream(path).pipe(res)`). `documentController.download` streams:

```ts
const stream = storageService.get(orgId, document.sha256);
stream.on('error', () => { res.destroy(); });
stream.pipe(res);
```

`.pipe()` doesn't just forward data events — it manages **backpressure**: if the HTTP response can't be written to as fast as the file can be read (a slow client connection, for instance), `pipe` pauses the source stream until the destination drains, rather than reading the entire file into memory ahead of what the network can actually send. For a file near the upload size ceiling, buffering the whole thing first means holding that many bytes in the process's memory for the duration of one request; streaming holds only a small buffer's worth at any instant, regardless of file size.

The `'error'` listener is not optional. A read stream can fail mid-read — the file was deleted between the metadata lookup and the stream open, a disk I/O error, permissions changed — and an `Error` event on a stream with no listener attached is one of the few places Node.js treats an unhandled event as fatal: it throws, uncaught, which by default crashes the entire process. Piping alone does not add this listener for you (`pipe` propagates *data*, not error handling), so it has to be attached explicitly. `res.destroy()` here ends the response abruptly rather than trying to send a clean error body after a stream has already been partially written to the client — by the time bytes are flowing, the headers are already sent, and no coherent error JSON can go out on the same response.

### Why deletion leaves the blob

`deleteDocument` removes the `documents` row (after confirming nothing links to it) but never calls `fs.unlink` on the underlying blob. This is the same rule-5 reasoning as the upload ordering, from the other direction: deleting the file *inside* the same transaction that deletes the row would mean a `ROLLBACK` (say, because a concurrent request attached a link in between) would need to somehow un-delete a file already removed from disk — filesystem operations don't participate in Postgres's transaction and can't be rolled back by it. Deleting the file *after* `COMMIT` reintroduces the exact post-commit-follow-up problem rule 5 forbids: a crash between commit and unlink leaves an orphaned blob anyway, just via a different path. So the vault accepts the orphan as the deliberate cost of correctness: a deleted document's bytes stay on disk, unreferenced and inert, and blob garbage collection is explicitly out of scope for this phase (`docs/roadmap.md`'s "deliberately not planned" list) — a background sweep comparing disk contents against live `documents` rows is the natural place that would live, whenever it's built.

### The link table as the rule-16 boundary

`document_links` is what lets LedgerCore attach a PDF to an invoice and (later) AP-Flow attach a source image to its own record, without either app ever reading the other's tables. Both operations are really "an app talks to the platform" — `POST /documents/:id/links` with `{ appSlug, entityType, entityId }` — never "app A queries app B's schema directly." `entity_id` deliberately carries no foreign key: adding one would mean the platform (`documentService.ts`) querying `invoices`, `bills`, or any other app's table to validate the reference, which is precisely the direct cross-app read guardrails rule 16 forbids. The tolerated cost is a link that can outlive its entity (an invoice hard-deleted with an attachment still pointing at its id) — accepted and tested, rather than closed by a violation of the boundary the whole design exists to protect.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Bytes in a `BYTEA` column | Transactionally consistent with the metadata row by construction; no filesystem coordination needed | Rejected — bloats the database's working set and backup size with binary blobs Postgres isn't optimized to serve efficiently at scale; the filesystem is a better fit for streaming reads |
| Bytes as a PostgreSQL large object (`lo_import`/`lo_export`) | Built-in streaming API, transactional | Rejected — same fundamental cost as `BYTEA` for this use case, plus a less familiar API; doesn't solve anything the filesystem doesn't already solve more simply here |
| Globally content-addressed storage (one shared namespace across all tenants) | Maximum deduplication — identical files across tenants share one blob | Rejected — creates a cross-tenant existence oracle and makes deletion unsafe without a cross-tenant reference count; the isolation cost outweighs the disk savings |
| A per-app attachment table (each app owns its own upload/storage code) | No shared service to design or maintain | Rejected — three apps (LedgerCore, AP-Flow, BoardDeck/TaxGuard) all need files; duplicating upload, hashing, and storage three times is the same promotion `redactionService.ts` already went through for the identical reason |
| An FK from `document_links.entity_id` to each app's own table | Referential integrity enforced by the database | Rejected — requires the platform to know about and query every app's schema, which is exactly what guardrails rule 16 exists to prevent |
| **Org-keyed filesystem storage, content-addressed within each org, narrow `put`/`get`/`stat` interface** | Duplicate bytes across tenants; single-instance only; requires an explicit later swap for real deployment | **Chosen** — the simplest thing that satisfies the audit requirement today, isolated by construction, and the interface is deliberately the one-file seam a real object store slots into later |

---

## Where it lives in this codebase

- `server/src/services/storageService.ts` — `blobPath`, `put`, `get`, `stat`; the entire filesystem-touching surface for documents
- `server/src/services/documentService.ts` — `uploadDocument` (write-before-commit ordering), `deleteDocument` (row-only removal), `attachDocument`/`detachDocument` (the link-table boundary)
- `server/src/controllers/documentController.ts` — `download` (`pipe`, the `'error'` listener, response headers)
- `server/src/db/migrations/030_platform_documents.sql` — `documents`, `document_links`; the composite FK `(org_id, document_id) → documents (org_id, id)` and the deliberately absent FK on `entity_id`
- `server/src/__tests__/storageService.test.ts` — fan-out path assertions, idempotent `put`, cross-org isolation (`two orgs uploading identical bytes get two blobs`)
- `server/src/__tests__/platform/documentConstraints.test.ts` — the composite FK rejecting a cross-tenant link at the database level

---

## Gotchas

- **This backend does not survive more than one server instance.** Two API processes on two machines (or two containers with separate disks) each see only their own local `STORAGE_ROOT` — a file uploaded to one is invisible to the other. Fine for a single-instance deployment; a hard blocker the moment horizontal scaling is needed, which is exactly why the `put`/`get`/`stat` interface exists as the planned swap point.
- **A deleted document's blob is never reclaimed.** Over a long-lived deployment, `server/storage/` grows monotonically even as `documents` rows are deleted. There is no garbage collector in this phase.
- **`verify:integrity` does not check that every `documents` row has a blob behind it**, or vice versa — the existing integrity checker (Phase 5) validates ledger invariants, not filesystem-to-database consistency. A storage-integrity check is a reasonable future addition, not something this phase builds.
- **Streaming a file back out means the download route is the one place in this codebase that isn't a JSON response** — `res.json()` is not called; headers and a piped stream are written directly. Any change to the shared error-handling middleware has to account for a route that may have already started writing a response body before an error could occur mid-stream.

---

## Interview Q&A

**Q: What is content-addressed storage, and what does it buy you?**
A: Naming a stored object by a hash of its own contents (here, SHA-256) rather than an arbitrary generated id. Two consequences: deduplication becomes free — identical bytes hash identically and land at the identical storage location, so a duplicate upload is a no-op — and the content can never silently drift from its name, since changing the bytes changes the hash and therefore the identity. It turns "does this exact file already exist" from a database lookup with its own consistency risks into a property of the naming scheme itself.

**Q: Why is this vault's storage keyed by organization instead of one global content-addressed namespace?**
A: A single global namespace lets one organization learn whether another organization has ever uploaded a specific file, by uploading it themselves and observing whether the system reports it as new or already-existing — a cross-tenant information leak, even though it reveals nothing about the file's *contents*. It also makes deletion unsafe: if a blob is shared across tenants and one tenant's reference is removed, deleting the underlying file would break every other tenant still pointing at it, which needs a cross-tenant reference count to do safely. Keying by organization first means two tenants uploading identical bytes get two independent blobs — more disk used, but tenant isolation preserved by construction, matching the isolation guarantee this codebase makes everywhere else.

**Q: Why is the file written to disk before the database transaction that records its metadata commits?**
A: To make the only possible post-crash inconsistency the harmless one. If the metadata row were committed first and the file write came after, a crash in between leaves a database row claiming a file exists that was never actually written — every future read of it fails, and nothing about the row itself reveals why. Writing the file first means a crash between the write and the commit leaves, at worst, an orphaned file on disk that no row references — inert and reclaimable, never a row lying about data that isn't there. It's also the direct consequence of the rule against doing work after a transaction commits: writing the file after `COMMIT` would be exactly that kind of post-commit follow-up, and a crash right there would silently lose the file forever with no transaction left to retry it in.

**Q: What does `stream.pipe(res)` do that manually reading the file and calling `res.send(buffer)` doesn't?**
A: It manages backpressure. If the client's connection can't absorb data as fast as the file can be read from disk, `pipe` pauses the source stream until the destination (the HTTP response) has drained its buffer, rather than reading the entire file into process memory regardless of how fast it can actually be sent. Buffering the whole file first means holding that many bytes in memory for the life of one request; streaming holds only a small window of it at any instant, independent of the file's total size.

**Q: Why does the download route need an explicit `'error'` listener on the read stream?**
A: A stream's `Error` event is one of the cases Node.js treats as fatal by default when nothing is listening for it — an unhandled `'error'` event throws and can crash the whole process. `pipe()` forwards data from source to destination but doesn't attach error handling for you, so a mid-read failure (the file deleted after the metadata lookup, a disk error) needs its own listener. By the time bytes are streaming, response headers are already sent, so the handler can't send a clean JSON error — it can only end the connection abruptly with `res.destroy()`.

**Q: Why does `document_links.entity_id` have no foreign key, and doesn't that risk dangling references?**
A: Adding a foreign key would require the platform's `documentService` to know the schema of — and directly query — every app's own tables (`invoices`, `bills`, whatever entity type an app declares), which is exactly the cross-app table access guardrails rule 16 exists to prevent. The tolerated cost is a link that can outlive the entity it points at — an invoice hard-deleted while an attachment link still references its id — accepted as a known, tested limitation rather than solved by breaking the app-boundary rule the entire link-table design exists to preserve.

---

## Follow-ups they'll dig into

- *"How would blob garbage collection actually work, if you built it?"* A periodic job would walk `STORAGE_ROOT`'s directory tree (or, cheaper, iterate `documents` rows and check `stat` per org rather than crawling every file) and compare disk contents against live `documents` rows, deleting any blob with zero referencing rows. It would need to tolerate a race against an in-flight upload — a blob that's been written but whose transaction hasn't committed yet — most simply by only reclaiming files older than some grace window past their expected commit time.
- *"What changes if `storageService` starts calling S3 instead of the local filesystem?"* The `put`/`get`/`stat` signatures stay identical from every caller's perspective; only the implementation inside `storageService.ts` changes — `put` becomes a `PutObjectCommand`, `get` returns the SDK's readable stream from `GetObjectCommand`, `stat` becomes a `HeadObjectCommand`. `blobPath`'s org-keyed, hash-fanned-out string becomes the S3 object key instead of a filesystem path — the same traversal-safety reasoning (validate before building the key) still applies, since an S3 key built from unvalidated input is an over-broad-access risk in its own right.
- *"Given the orphan-tolerance policy, how would you prove nothing is actually being lost — that every row does have a real blob?"* Extend `verify:integrity` (or a sibling script) with a pass that, for each `documents` row, calls `storageService.stat(orgId, sha256)` and asserts it's non-null — the same "prove the database and the derived-from-it invariant actually agree" discipline `verify:integrity` already applies to the ledger, just pointed at the filesystem instead of `ledger_lines`.

---

## See also

- [../security-auth/file-upload-threat-model.md](../security-auth/file-upload-threat-model.md) — what happens *before* a file reaches this storage layer: MIME sniffing, the traversal guard `blobPath` enforces, and the headers that make serving it back out safe
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — the sibling content-hashing pattern for bank-statement rows, and why a natural key isn't enough there either
- [../postgresql/composite-foreign-keys-for-tenancy.md](../postgresql/composite-foreign-keys-for-tenancy.md) — the `(org_id, document_id) → documents (org_id, id)` composite FK technique `document_links` reuses
- [transactional-outbox.md](transactional-outbox.md) — another place in this codebase where "never do real work after `COMMIT`" shapes the design, there solved with a queue instead of an accepted orphan
