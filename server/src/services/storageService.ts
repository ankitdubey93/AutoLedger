import { createReadStream } from 'node:fs';
import { mkdir, stat as fsStat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';

/**
 * The Document Vault's filesystem backend (Phase 9.5) — shared
 * infrastructure, unprefixed, the same status as `authService`. It touches
 * no database: `documentService.ts` owns the metadata, this file owns only
 * the bytes.
 *
 * Storage is org-keyed, never globally content-addressed:
 * `STORAGE_ROOT/<org_id>/<sha[0:2]>/<sha[2:4]>/<sha256>`. Two tenants
 * uploading identical bytes get two blobs — global addressing would let one
 * tenant detect that another holds the same file, and would make deleting a
 * blob unsafe whenever two organizations shared it. See
 * docs/roadmap.md#phase-renumbering--2026-09-10.
 *
 * The put/get/stat interface is deliberately narrow so object storage is a
 * one-file swap later — this backend does not survive a multi-instance
 * deployment.
 *
 * See study/architecture/file-storage-and-streaming.md.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Absolute on-disk path for one blob. The path-traversal guard lives HERE
 * and nowhere else: `orgId` and `sha256` are validated against strict
 * regexes before anything is joined, so neither value can structurally
 * contain `/`, `\` or `..` — the join below cannot escape STORAGE_ROOT.
 */
export function blobPath(orgId: string, sha256: string): string {
  if (!UUID_RE.test(orgId) || !SHA256_RE.test(sha256)) {
    throw new ApiError(400, 'Invalid storage key');
  }
  return path.join(env.STORAGE_ROOT, orgId, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/**
 * Writes the buffer and returns its content hash and size. Idempotent:
 * rewriting an existing identical blob is not an error, since the bytes at
 * that path are always the same bytes by construction.
 */
export async function put(
  orgId: string,
  buffer: Buffer,
): Promise<{ sha256: string; byteSize: number }> {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const target = blobPath(orgId, sha256);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return { sha256, byteSize: buffer.byteLength };
}

/**
 * A read stream over one blob. Existence is not pre-checked — a missing
 * file surfaces as an `'error'` event on the returned stream, which the
 * caller (documentController.download) pipes-and-handles.
 */
export function get(orgId: string, sha256: string): Readable {
  return createReadStream(blobPath(orgId, sha256));
}

/** Byte size on disk, or null when the blob is missing. */
export async function stat(orgId: string, sha256: string): Promise<{ byteSize: number } | null> {
  try {
    const info = await fsStat(blobPath(orgId, sha256));
    return { byteSize: info.size };
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
