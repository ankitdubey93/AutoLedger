import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';
import { blobPath, get, put, stat } from '../services/storageService.js';

/**
 * Unit tier — no database, but real filesystem I/O against STORAGE_ROOT
 * (pinned to `storage-test/` by vitest.config.ts, never the dev store).
 */

beforeEach(async () => {
  await rm(env.STORAGE_ROOT, { recursive: true, force: true });
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe('storageService', () => {
  it('put returns the sha256 of the bytes', async () => {
    const buf = Buffer.from('hello world');
    const { sha256 } = await put(randomUUID(), buf);
    expect(sha256).toBe(createHash('sha256').update(buf).digest('hex'));
  });

  it('put fans the path out two levels under the org id', async () => {
    const orgId = randomUUID();
    const buf = Buffer.from('fan-out check');
    const { sha256 } = await put(orgId, buf);
    const target = blobPath(orgId, sha256);
    expect(target.endsWith(`${orgId}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`)).toBe(
      true,
    );
  });

  it('put twice with the same bytes is idempotent', async () => {
    const orgId = randomUUID();
    const buf = Buffer.from('repeat upload');
    const first = await put(orgId, buf);
    const second = await put(orgId, buf);
    expect(second.sha256).toBe(first.sha256);
    const info = await stat(orgId, first.sha256);
    expect(info?.byteSize).toBe(buf.byteLength);
  });

  it('two orgs uploading identical bytes get two blobs', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const buf = Buffer.from('shared content');
    const a = await put(orgA, buf);
    const b = await put(orgB, buf);
    expect(a.sha256).toBe(b.sha256);
    expect(blobPath(orgA, a.sha256)).not.toBe(blobPath(orgB, b.sha256));
    expect(await stat(orgA, a.sha256)).not.toBeNull();
    expect(await stat(orgB, b.sha256)).not.toBeNull();
  });

  it('get streams back exactly what put wrote', async () => {
    const orgId = randomUUID();
    const buf = Buffer.from('stream this back exactly');
    const { sha256 } = await put(orgId, buf);
    const streamed = await streamToBuffer(get(orgId, sha256));
    expect(streamed.equals(buf)).toBe(true);
  });

  it('stat returns null for a missing blob', async () => {
    const orgId = randomUUID();
    const missingSha = createHash('sha256').update('nope').digest('hex');
    expect(await stat(orgId, missingSha)).toBeNull();
  });

  it('blobPath rejects a traversal attempt in the hash', () => {
    const orgId = randomUUID();
    expect(() => blobPath(orgId, '../../etc/passwd')).toThrow(ApiError);
    try {
      blobPath(orgId, '../../etc/passwd');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('Invalid storage key');
    }
  });

  it('blobPath rejects a non-UUID org id', () => {
    const sha = createHash('sha256').update('x').digest('hex');
    try {
      blobPath('../other-org', sha);
      throw new Error('expected blobPath to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('Invalid storage key');
    }
  });
});
