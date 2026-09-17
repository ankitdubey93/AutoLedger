import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { addMember, createUserWithOrg, loginAgent, resetTables, clearStorage, buildTestPdf } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as driveConnectionService from '../../services/ap-flow/driveConnectionService.js';
import { handleApFlowDriveSweep } from '../../queue/handlers/apFlowDriveSweepHandler.js';
import { decryptSecret } from '../../utils/secretBox.js';
import { sha256Hex } from '../../utils/pkce.js';
import { listCallsForEntity } from '../../services/aiUsageService.js';
import { handleApFlowExtract } from '../../queue/handlers/apFlowExtractHandler.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import type { FetchLike } from '../../services/ap-flow/googleDriveClient.js';

/**
 * Google Drive folder intake (Phase 19.2). Every case injects a `deps`
 * object with a fake `fetchImpl` router; no case reaches the network.
 */

const app = createApp();
const BASE = '/api/v1/ap-flow/drive';

const TEST_OAUTH = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/cb' };
const TEST_KEY = 'a'.repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  bytes: Buffer;
}

/**
 * A small router over URL prefixes, mirroring modelClient.test.ts's fake
 * fetchImpl style. `tokenBehavior` lets a case simulate invalid_grant on
 * refresh.
 */
function fakeFetch(options: {
  files?: FakeDriveFile[];
  refreshInvalidGrant?: boolean;
  email?: string;
}): FetchLike {
  const files = options.files ?? [];
  const email = options.email ?? 'owner@example.com';

  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams((init?.body as string) ?? '');
      const grantType = body.get('grant_type');
      if (grantType === 'authorization_code') {
        return Promise.resolve(jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1' }));
      }
      if (grantType === 'refresh_token') {
        if (options.refreshInvalidGrant === true) {
          return Promise.resolve(jsonResponse(400, { error: 'invalid_grant' }));
        }
        return Promise.resolve(jsonResponse(200, { access_token: 'at-2' }));
      }
      return Promise.resolve(jsonResponse(400, {}));
    }

    if (url.includes('/about')) {
      return Promise.resolve(jsonResponse(200, { user: { emailAddress: email } }));
    }

    if (url.includes('/files?')) {
      return Promise.resolve(
        jsonResponse(200, {
          files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size })),
        }),
      );
    }

    const downloadMatch = /\/files\/([^?]+)\?alt=media/.exec(url);
    if (downloadMatch?.[1] !== undefined) {
      const file = files.find((f) => f.id === downloadMatch[1]);
      if (file === undefined) return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(
        new Response(file.bytes, { status: 200, headers: { 'Content-Length': String(file.bytes.byteLength) } }),
      );
    }

    return Promise.resolve(new Response('', { status: 404 }));
  }) as unknown as FetchLike;
}

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
}

describe('Google Drive folder intake', () => {
  let userA: SeededUser;
  let orgA: string;
  let userB: SeededUser;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(async () => {
    await Promise.all(QUEUE_NAMES.map((name) => queues[name].obliterate({ force: true })).map((p) => p.catch(() => undefined)));
    await closeQueues();
    await closePool();
  });

  it('GET /drive returns no connection and configured false on a fresh organization', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.connection).toBeNull();
    expect(res.body.configured).toBe(false);
  });

  it('POST /drive/connect returns 503 when Google Drive is not configured', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${BASE}/connect`);
    expect(res.status).toBe(503);
  });

  it('POST /drive/connect is refused for an ACCOUNTANT', async () => {
    const acct = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, acct.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, acct);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const res = await agent.post(`${BASE}/connect`);
    expect(res.status).toBe(403);
  });

  it('startConnect stores only a hash of the state and an encrypted verifier', async () => {
    const deps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state');
    const codeChallenge = new URL(authorizationUrl).searchParams.get('code_challenge');
    expect(state).not.toBeNull();

    const { rows } = await pool.query<{ oauth_state_sha256: string; pkce_verifier_ciphertext: string }>(
      'SELECT oauth_state_sha256, pkce_verifier_ciphertext FROM ap_flow_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.oauth_state_sha256).toBe(sha256Hex(state as string));
    expect(rows[0]?.pkce_verifier_ciphertext).toMatch(/^v1\./);
    expect(rows[0]?.pkce_verifier_ciphertext).not.toContain(codeChallenge);
  });

  it('completeConnect stores an encrypted refresh token and marks the connection CONNECTED', async () => {
    const deps = { fetchImpl: fakeFetch({ email: 'Owner@Example.com' }), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    const result = await driveConnectionService.completeConnect(state, 'auth-code', deps);
    expect(result.orgId).toBe(orgA);

    const { rows } = await pool.query<{
      status: string;
      refresh_token_ciphertext: string;
      google_account_email: string;
      oauth_state_sha256: string | null;
    }>(
      'SELECT status, refresh_token_ciphertext, google_account_email, oauth_state_sha256 FROM ap_flow_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.status).toBe('CONNECTED');
    expect(rows[0]?.refresh_token_ciphertext).not.toBe('rt-1');
    expect(decryptSecret(rows[0]?.refresh_token_ciphertext as string, TEST_KEY)).toBe('rt-1');
    expect(rows[0]?.google_account_email).toBe('owner@example.com');
    expect(rows[0]?.oauth_state_sha256).toBeNull();
  });

  it('an authorization state works only once', async () => {
    const deps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    await driveConnectionService.completeConnect(state, 'auth-code', deps);
    await expect(driveConnectionService.completeConnect(state, 'auth-code', deps)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('an expired authorization state is rejected', async () => {
    const deps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    await pool.query(
      `UPDATE ap_flow_drive_connections SET oauth_state_expires_at = now() - interval '1 minute' WHERE org_id = $1`,
      [orgA],
    );

    await expect(driveConnectionService.completeConnect(state, 'auth-code', deps)).rejects.toMatchObject({
      status: 400,
    });
  });

  async function connectOrg(orgId: string, userId: string, options: Parameters<typeof fakeFetch>[0] = {}) {
    const deps = { fetchImpl: fakeFetch(options), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgId, userId, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;
    await driveConnectionService.completeConnect(state, 'auth-code', deps);
    return deps;
  }

  it('setFolder rejects a file that is not a folder', async () => {
    const deps = await connectOrg(orgA, userA.id);
    // getFolder is driven by the same /files/<id> route the file-metadata
    // fetch uses; point the fake at a non-folder mimeType by adding a
    // matching "file" entry the router's generic 404 would otherwise miss.
    const customDeps = {
      ...deps,
      fetchImpl: vi.fn((input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/files/folder1234567?')) {
          return Promise.resolve(jsonResponse(200, { id: 'folder1234567', name: 'Not a folder', mimeType: 'application/pdf' }));
        }
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return Promise.resolve(jsonResponse(200, { access_token: 'at-2' }));
        }
        return Promise.resolve(new Response('', { status: 404 }));
      }) as unknown as FetchLike,
    };

    await expect(driveConnectionService.setFolder(orgA, 'folder1234567', customDeps)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('syncConnection imports each new file once across repeated runs', async () => {
    const png = await makePng();
    const pdf = buildTestPdf(['Invoice']);
    const files: FakeDriveFile[] = [
      { id: 'file-png-1', name: 'receipt.png', mimeType: 'image/png', size: String(png.byteLength), bytes: png },
      { id: 'file-pdf-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: String(pdf.byteLength), bytes: pdf },
    ];
    const deps = await connectOrg(orgA, userA.id, { files });

    const customDeps = {
      ...deps,
      fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/files/folder1234567?')) {
          return Promise.resolve(
            jsonResponse(200, { id: 'folder1234567', name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' }),
          );
        }
        return (fakeFetch({ files }) as unknown as (u: typeof input, i?: RequestInit) => Promise<Response>)(url, init);
      }) as unknown as FetchLike,
    };

    await driveConnectionService.setFolder(orgA, 'folder1234567', customDeps);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_drive_connections WHERE org_id = $1', [orgA]);
    const connectionId = rows[0]?.id as string;

    const first = await driveConnectionService.syncConnection(orgA, connectionId, customDeps);
    expect(first).toEqual({ imported: 2, skipped: 0 });

    const second = await driveConnectionService.syncConnection(orgA, connectionId, customDeps);
    expect(second).toEqual({ imported: 0, skipped: 0 });

    const { rows: docCount } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    expect(docCount[0]?.n).toBe(2);
    const { rows: fileRows } = await pool.query(
      "SELECT status FROM ap_flow_drive_files WHERE org_id = $1 AND status = 'IMPORTED'",
      [orgA],
    );
    expect(fileRows).toHaveLength(2);
  });

  it('a file over the size limit is SKIPPED and never downloaded', async () => {
    let downloadHit = false;
    const files: FakeDriveFile[] = [
      { id: 'huge-file-01', name: 'huge.pdf', mimeType: 'application/pdf', size: '20000000', bytes: Buffer.alloc(0) },
    ];
    const deps = await connectOrg(orgA, userA.id, { files });
    const customDeps = {
      ...deps,
      fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('alt=media')) downloadHit = true;
        if (url.includes('/files/folder1234567?')) {
          return Promise.resolve(
            jsonResponse(200, { id: 'folder1234567', name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' }),
          );
        }
        return (fakeFetch({ files }) as unknown as (u: typeof input, i?: RequestInit) => Promise<Response>)(url, init);
      }) as unknown as FetchLike,
    };

    await driveConnectionService.setFolder(orgA, 'folder1234567', customDeps);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_drive_connections WHERE org_id = $1', [orgA]);
    const connectionId = rows[0]?.id as string;

    const result = await driveConnectionService.syncConnection(orgA, connectionId, customDeps);
    expect(result).toEqual({ imported: 0, skipped: 1 });
    expect(downloadHit).toBe(false);
  });

  it('invalid_grant during sync marks the connection NEEDS_REAUTH', async () => {
    const deps = await connectOrg(orgA, userA.id, {});
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_drive_connections WHERE org_id = $1', [orgA]);
    const connectionId = rows[0]?.id as string;
    await pool.query("UPDATE ap_flow_drive_connections SET folder_id = 'folder1234567456' WHERE org_id = $1", [orgA]);

    const failingDeps = { ...deps, fetchImpl: fakeFetch({ refreshInvalidGrant: true }) };
    await driveConnectionService.syncConnection(orgA, connectionId, failingDeps);

    const { rows: statusRows } = await pool.query<{ status: string }>(
      'SELECT status FROM ap_flow_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(statusRows[0]?.status).toBe('NEEDS_REAUTH');
  });

  it('sync never writes outside the connection\'s organization', async () => {
    const depsA = await connectOrg(orgA, userA.id, {});
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_drive_connections WHERE org_id = $1', [orgA]);
    const connectionAId = rows[0]?.id as string;

    const { rows: beforeA } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const { rows: beforeB } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgB]);

    const result = await driveConnectionService.syncConnection(orgB, connectionAId, depsA);
    expect(result).toEqual({ imported: 0, skipped: 0 });

    const { rows: afterA } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const { rows: afterB } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgB]);
    expect(afterA[0]?.n).toBe(beforeA[0]?.n);
    expect(afterB[0]?.n).toBe(beforeB[0]?.n);
  });

  it('GET /drive never returns token material', async () => {
    await connectOrg(orgA, userA.id, {});
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ciphertext');
    expect(body).not.toContain('rt-1');
    expect(body.toLowerCase()).not.toContain('refresh_token');
    expect(body.toLowerCase()).not.toContain('verifier');
    expect(body.toLowerCase()).not.toContain('state');
  });

  it('the OAuth callback redirects to settings with drive=error on a bad state', async () => {
    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get(`${BASE}/oauth/callback`).query({ state: 'bogus', code: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/app/ap-flow/settings?drive=error');
  });

  it('the sweep enqueues one sync per due connection and dedupes within an interval', async () => {
    await connectOrg(orgA, userA.id, {});
    await pool.query("UPDATE ap_flow_drive_connections SET folder_id = 'folder1234567456' WHERE org_id = $1", [orgA]);

    await handleApFlowDriveSweep({});
    await handleApFlowDriveSweep({});

    const counts = await queues['ap-flow-drive-sync'].getJobCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBe(1);
  });

  it('an imported document\'s extraction is metered against that document', async () => {
    const png = await makePng();
    const files: FakeDriveFile[] = [
      { id: 'file-metered-1', name: 'receipt.png', mimeType: 'image/png', size: String(png.byteLength), bytes: png },
    ];
    const deps = await connectOrg(orgA, userA.id, { files });
    const customDeps = {
      ...deps,
      fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/files/folder1234567?')) {
          return Promise.resolve(
            jsonResponse(200, { id: 'folder1234567', name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' }),
          );
        }
        return (fakeFetch({ files }) as unknown as (u: typeof input, i?: RequestInit) => Promise<Response>)(url, init);
      }) as unknown as FetchLike,
    };

    await driveConnectionService.setFolder(orgA, 'folder1234567', customDeps);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_drive_connections WHERE org_id = $1', [orgA]);
    const connectionId = rows[0]?.id as string;
    await driveConnectionService.syncConnection(orgA, connectionId, customDeps);

    const { rows: docRows } = await pool.query<{ id: string }>('SELECT id FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const apFlowDocId = docRows[0]?.id as string;

    const stubVision: VisionClient = {
      messages: {
        create: () =>
          Promise.resolve({
            content: [{ type: 'tool_use', input: { vendor_name: 'V', total: '10.00', line_items: [], field_confidence: {} } }],
          }),
      },
    };
    await handleApFlowExtract({ orgId: orgA, apFlowDocumentId: apFlowDocId }, { vision: stubVision });

    const calls = await listCallsForEntity(orgA, 'ap_flow_document', apFlowDocId);
    expect(calls.length).toBeGreaterThan(0);
  });
});
