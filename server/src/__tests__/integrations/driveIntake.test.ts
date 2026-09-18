import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { addMember, createUserWithOrg, loginAgent, resetTables, clearStorage, buildTestPdf } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as driveConnectionService from '../../services/integrations/driveConnectionService.js';
import * as driveFolderService from '../../services/integrations/driveFolderService.js';
import * as driveSyncService from '../../services/integrations/driveSyncService.js';
import { handleIntegrationDriveSweep } from '../../queue/handlers/integrationDriveSweepHandler.js';
import { decryptSecret } from '../../utils/secretBox.js';
import { sha256Hex } from '../../utils/pkce.js';
import { listCallsForEntity } from '../../services/aiUsageService.js';
import { handleApFlowExtract } from '../../queue/handlers/apFlowExtractHandler.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import { INTEGRATION_DRIVE_POLL_INTERVAL_MS } from '../../config/constants.js';
import type { DriveServiceDeps } from '../../services/integrations/driveConnectionService.js';
import type { FetchLike } from '../../services/integrations/googleDriveClient.js';

/**
 * Google Drive folder intake — Phase 19.3. Every case injects a `deps` object
 * with a fake `fetchImpl` router; no case reaches the network.
 */

const app = createApp();
const BASE = '/api/v1/integrations/drive';

const TEST_OAUTH = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/cb' };
const TEST_SA = { clientEmail: 'sa@my-project.iam.gserviceaccount.com', privateKeyPem: 'test-key' };
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
  modifiedTime?: string;
}

/**
 * A small router over URL prefixes, mirroring modelClient.test.ts's fake
 * fetchImpl style. `tokenBehavior` lets a case simulate invalid_grant on
 * refresh. The `assertion` grant type (service-account auth) is handled
 * identically to `authorization_code` — this file doesn't unit-test JWT
 * signing itself (serviceAccountAuth.test.ts does), only that the connection
 * lifecycle around it behaves.
 */
function fakeFetch(options: { files?: FakeDriveFile[]; refreshInvalidGrant?: boolean; email?: string }): FetchLike {
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
      if (grantType === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return Promise.resolve(jsonResponse(200, { access_token: 'sa-at-1' }));
      }
      return Promise.resolve(jsonResponse(400, {}));
    }

    if (url.includes('/about')) {
      return Promise.resolve(jsonResponse(200, { user: { emailAddress: email } }));
    }

    if (url.includes('/files?')) {
      return Promise.resolve(
        jsonResponse(200, {
          files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime })),
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

/**
 * Wraps a connected `deps` with a handler for the folder-metadata GET
 * (`getFolder`), which the base `fakeFetch` router does not answer — its
 * `/files?` branch only matches the LIST endpoint (a query string), not
 * `/files/<id>?fields=...`.
 */
function withFolderMetadata(
  deps: DriveServiceDeps,
  files: FakeDriveFile[] = [],
  driveFolderId = 'folder1234567',
): DriveServiceDeps {
  return {
    ...deps,
    fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes(`/files/${driveFolderId}?`)) {
        return Promise.resolve(
          jsonResponse(200, { id: driveFolderId, name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' }),
        );
      }
      return (fakeFetch({ files }) as unknown as (u: typeof input, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as FetchLike,
  };
}

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
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

  // ---------------------------------------------------------- connection

  it('GET /integrations/drive returns no connection or folders for a fresh organization', async () => {
    // `modes` is deliberately NOT asserted here — driveModes() reads
    // server-wide env config (GOOGLE_SERVICE_ACCOUNT_EMAIL etc.), not
    // anything org-scoped, so its value depends on whichever machine runs
    // this test, not on this org being fresh. Asserting a literal value
    // here would make the suite fail on any developer's machine that has
    // real Drive credentials configured in server/.env for manual testing
    // — a real, once-observed failure, not a hypothetical one. The
    // service-account-specific cases below use an explicit `deps` override
    // instead, which is the only way to make this deterministic.
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.connection).toBeNull();
    expect(res.body.folders).toEqual([]);
  });

  it('POST /connect returns 503 when Google Drive is not configured', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${BASE}/connect`);
    expect(res.status).toBe(503);
  });

  it('POST /connect is refused for an ACCOUNTANT', async () => {
    const acct = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, acct.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, acct);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const res = await agent.post(`${BASE}/connect`);
    expect(res.status).toBe(403);
  });

  it('startConnect stores only a hash of the state and an encrypted verifier', async () => {
    const deps: DriveServiceDeps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state');
    const codeChallenge = new URL(authorizationUrl).searchParams.get('code_challenge');
    expect(state).not.toBeNull();

    const { rows } = await pool.query<{ oauth_state_sha256: string; pkce_verifier_ciphertext: string; auth_mode: string }>(
      'SELECT oauth_state_sha256, pkce_verifier_ciphertext, auth_mode FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.auth_mode).toBe('OAUTH');
    expect(rows[0]?.oauth_state_sha256).toBe(sha256Hex(state as string));
    expect(rows[0]?.pkce_verifier_ciphertext).toMatch(/^v1\./);
    expect(rows[0]?.pkce_verifier_ciphertext).not.toContain(codeChallenge);
  });

  it('completeConnect stores an encrypted refresh token and marks the connection CONNECTED', async () => {
    const deps: DriveServiceDeps = {
      fetchImpl: fakeFetch({ email: 'Owner@Example.com' }),
      oauth: TEST_OAUTH,
      encryptionKeyHex: TEST_KEY,
    };
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
      'SELECT status, refresh_token_ciphertext, google_account_email, oauth_state_sha256 FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.status).toBe('CONNECTED');
    expect(rows[0]?.refresh_token_ciphertext).not.toBe('rt-1');
    expect(decryptSecret(rows[0]?.refresh_token_ciphertext as string, TEST_KEY)).toBe('rt-1');
    expect(rows[0]?.google_account_email).toBe('owner@example.com');
    expect(rows[0]?.oauth_state_sha256).toBeNull();
  });

  it('an authorization state works only once', async () => {
    const deps: DriveServiceDeps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    await driveConnectionService.completeConnect(state, 'auth-code', deps);
    await expect(driveConnectionService.completeConnect(state, 'auth-code', deps)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('an expired authorization state is rejected', async () => {
    const deps: DriveServiceDeps = { fetchImpl: fakeFetch({}), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgA, userA.id, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;

    await pool.query(
      `UPDATE integration_drive_connections SET oauth_state_expires_at = now() - interval '1 minute' WHERE org_id = $1`,
      [orgA],
    );

    await expect(driveConnectionService.completeConnect(state, 'auth-code', deps)).rejects.toMatchObject({
      status: 400,
    });
  });

  async function connectOrg(
    orgId: string,
    userId: string,
    options: Parameters<typeof fakeFetch>[0] = {},
  ): Promise<DriveServiceDeps> {
    const deps: DriveServiceDeps = { fetchImpl: fakeFetch(options), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
    const { authorizationUrl } = await driveConnectionService.startConnect(orgId, userId, deps);
    const state = new URL(authorizationUrl).searchParams.get('state') as string;
    await driveConnectionService.completeConnect(state, 'auth-code', deps);
    return deps;
  }

  // ------------------------------------------------------ service account

  it('connectServiceAccount needs no network and stores no refresh token', async () => {
    const deps: DriveServiceDeps = { serviceAccount: TEST_SA, fetchImpl: fakeFetch({}) as unknown as FetchLike };
    const netSpy = deps.fetchImpl as ReturnType<typeof vi.fn>;

    const connection = await driveConnectionService.connectServiceAccount(orgA, userA.id, deps);

    expect(connection.status).toBe('CONNECTED');
    expect(connection.authMode).toBe('SERVICE_ACCOUNT');
    expect(connection.googleAccountEmail).toBe(TEST_SA.clientEmail);
    expect(netSpy).not.toHaveBeenCalled();

    const { rows } = await pool.query<{ refresh_token_ciphertext: string | null }>(
      'SELECT refresh_token_ciphertext FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.refresh_token_ciphertext).toBeNull();
  });

  it('connectServiceAccount is refused when an OAuth connection already exists, and its token is untouched', async () => {
    await connectOrg(orgA, userA.id, {});
    const { rows: before } = await pool.query<{ refresh_token_ciphertext: string }>(
      'SELECT refresh_token_ciphertext FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );

    await expect(
      driveConnectionService.connectServiceAccount(orgA, userA.id, { serviceAccount: TEST_SA }),
    ).rejects.toMatchObject({ status: 409 });

    const { rows: after } = await pool.query<{ refresh_token_ciphertext: string; auth_mode: string }>(
      'SELECT refresh_token_ciphertext, auth_mode FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(after[0]?.auth_mode).toBe('OAUTH');
    expect(after[0]?.refresh_token_ciphertext).toBe(before[0]?.refresh_token_ciphertext);
  });

  // -------------------------------------------------------------- folders

  it('createFolder rejects a Drive item that is not a folder', async () => {
    const deps = await connectOrg(orgA, userA.id);
    const customDeps: DriveServiceDeps = {
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

    await expect(
      driveFolderService.createFolder(
        orgA,
        userA.id,
        { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
        customDeps,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a BANK_STATEMENT folder needs a ledger account before it can be created', async () => {
    const deps = await connectOrg(orgA, userA.id);
    await expect(
      driveFolderService.createFolder(
        orgA,
        userA.id,
        { purpose: 'BANK_STATEMENT', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
        withFolderMetadata(deps),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  // ---------------------------------------------------------------- sync

  it('syncFolder imports each new file once across repeated runs', async () => {
    const png = await makePng();
    const pdf = buildTestPdf(['Invoice']);
    const files: FakeDriveFile[] = [
      { id: 'file-png-1', name: 'receipt.png', mimeType: 'image/png', size: String(png.byteLength), bytes: png },
      { id: 'file-pdf-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: String(pdf.byteLength), bytes: pdf },
    ];
    const deps = await connectOrg(orgA, userA.id);
    const syncDeps = withFolderMetadata(deps, files);

    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      syncDeps,
    );

    const first = await driveSyncService.syncFolder(orgA, folder.id, syncDeps);
    expect(first).toEqual({ imported: 2, skipped: 0 });

    // Immediately repeated: still blocked by the claim (60s poll window),
    // not by re-listing — the fetchImpl below is fresh, so 0 calls proves it
    // never even reached listFolderFiles.
    const secondDeps = withFolderMetadata(deps, files);
    const second = await driveSyncService.syncFolder(orgA, folder.id, secondDeps);
    expect(second).toEqual({ imported: 0, skipped: 0 });
    expect(secondDeps.fetchImpl).not.toHaveBeenCalled();

    const { rows: docCount } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    expect(docCount[0]?.n).toBe(2);
    const { rows: fileRows } = await pool.query(
      "SELECT status FROM integration_drive_files WHERE org_id = $1 AND status = 'IMPORTED'",
      [orgA],
    );
    expect(fileRows).toHaveLength(2);
  });

  it('after the poll interval passes, the next sync sends the stored cursor and re-listing the same file is harmless', async () => {
    const pdf = buildTestPdf(['Invoice']);
    const files: FakeDriveFile[] = [
      { id: 'cursor-file-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: String(pdf.byteLength), bytes: pdf, modifiedTime: '2026-01-01T00:00:00.000Z' },
    ];
    const deps = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps, files),
    );

    await driveSyncService.syncFolder(orgA, folder.id, withFolderMetadata(deps, files));
    const { rows: afterFirst } = await pool.query<{ drive_cursor: Date | null }>(
      'SELECT drive_cursor FROM integration_drive_folders WHERE id = $1',
      [folder.id],
    );
    expect(afterFirst[0]?.drive_cursor).not.toBeNull();

    // Simulate the poll interval having passed — the claim in syncFolder
    // would otherwise refuse a second attempt this soon.
    await pool.query(
      "UPDATE integration_drive_folders SET last_synced_at = now() - interval '2 minutes' WHERE id = $1",
      [folder.id],
    );

    const secondDeps = withFolderMetadata(deps, files);
    const second = await driveSyncService.syncFolder(orgA, folder.id, secondDeps);

    // Nothing new imported — the same Drive file is filtered by the known-id
    // check even though the cursor's lag window re-lists it.
    expect(second).toEqual({ imported: 0, skipped: 0 });

    const listCall = (secondDeps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('/files?'),
    );
    expect(listCall).toBeDefined();
    const q = new URL(String(listCall?.[0])).searchParams.get('q') ?? '';
    expect(q).toContain("modifiedTime >= '");

    const { rows: fileRows } = await pool.query(
      'SELECT count(*)::int AS n FROM integration_drive_files WHERE org_id = $1 AND drive_file_id = $2',
      [orgA, 'cursor-file-1'],
    );
    expect(fileRows[0]?.n).toBe(1);
  });

  it('a folder returning exactly the sync cap worth of files leaves drive_cursor unchanged', async () => {
    const files: FakeDriveFile[] = Array.from({ length: 25 }, (_, i) => ({
      id: `cap-file-${String(i)}`,
      name: `${String(i)}.pdf`,
      mimeType: 'application/pdf',
      size: '20000000', // over MAX_UPLOAD_BYTES — skipped by the pre-download gate, no real dispatch
      bytes: Buffer.alloc(0),
      modifiedTime: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    }));
    const deps = await connectOrg(orgA, userA.id);
    const syncDeps = withFolderMetadata(deps, files);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      syncDeps,
    );

    const result = await driveSyncService.syncFolder(orgA, folder.id, syncDeps);
    expect(result).toEqual({ imported: 0, skipped: 25 });

    const { rows } = await pool.query<{ drive_cursor: Date | null }>(
      'SELECT drive_cursor FROM integration_drive_folders WHERE id = $1',
      [folder.id],
    );
    expect(rows[0]?.drive_cursor).toBeNull();
  });

  it('a file whose download fails is not recorded, and the cursor does not advance past it', async () => {
    const files: FakeDriveFile[] = [
      { id: 'flaky-file-1', name: 'flaky.pdf', mimeType: 'application/pdf', size: '1000', bytes: Buffer.alloc(0), modifiedTime: '2026-01-01T00:00:00Z' },
    ];
    const deps = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps, files),
    );

    const flakyDeps: DriveServiceDeps = {
      ...deps,
      fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('alt=media')) return Promise.resolve(new Response('', { status: 500 }));
        return (withFolderMetadata(deps, files).fetchImpl as (u: typeof input, i?: RequestInit) => Promise<Response>)(
          input,
          init,
        );
      }) as unknown as FetchLike,
    };

    const result = await driveSyncService.syncFolder(orgA, folder.id, flakyDeps);
    expect(result).toEqual({ imported: 0, skipped: 0 });

    const { rows: fileRows } = await pool.query(
      'SELECT count(*)::int AS n FROM integration_drive_files WHERE org_id = $1 AND drive_file_id = $2',
      [orgA, 'flaky-file-1'],
    );
    expect(fileRows[0]?.n).toBe(0);

    const { rows: folderRows } = await pool.query<{ drive_cursor: Date | null }>(
      'SELECT drive_cursor FROM integration_drive_folders WHERE id = $1',
      [folder.id],
    );
    expect(folderRows[0]?.drive_cursor).toBeNull();
  });

  it('a file over the size limit is SKIPPED and never downloaded', async () => {
    let downloadHit = false;
    const files: FakeDriveFile[] = [
      { id: 'huge-file-01', name: 'huge.pdf', mimeType: 'application/pdf', size: '20000000', bytes: Buffer.alloc(0) },
    ];
    const deps = await connectOrg(orgA, userA.id);
    const baseDeps = withFolderMetadata(deps, files);
    const syncDeps: DriveServiceDeps = {
      ...baseDeps,
      fetchImpl: vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('alt=media')) downloadHit = true;
        return (baseDeps.fetchImpl as (u: typeof input, i?: RequestInit) => Promise<Response>)(input, init);
      }) as unknown as FetchLike,
    };

    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      syncDeps,
    );

    const result = await driveSyncService.syncFolder(orgA, folder.id, syncDeps);
    expect(result).toEqual({ imported: 0, skipped: 1 });
    expect(downloadHit).toBe(false);
  });

  it('invalid_grant during sync marks the connection NEEDS_REAUTH', async () => {
    const deps = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps),
    );

    const failingDeps: DriveServiceDeps = { ...deps, fetchImpl: fakeFetch({ refreshInvalidGrant: true }) };
    await driveSyncService.syncFolder(orgA, folder.id, failingDeps);

    const { rows: statusRows } = await pool.query<{ status: string }>(
      'SELECT status FROM integration_drive_connections WHERE org_id = $1',
      [orgA],
    );
    expect(statusRows[0]?.status).toBe('NEEDS_REAUTH');
  });

  it("sync never writes outside the folder's organization", async () => {
    const depsA = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(depsA),
    );

    const { rows: beforeA } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const { rows: beforeB } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgB]);

    const result = await driveSyncService.syncFolder(orgB, folder.id, depsA);
    expect(result).toEqual({ imported: 0, skipped: 0 });

    const { rows: afterA } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const { rows: afterB } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgB]);
    expect(afterA[0]?.n).toBe(beforeA[0]?.n);
    expect(afterB[0]?.n).toBe(beforeB[0]?.n);
  });

  it('two folders route by purpose: VENDOR_BILL to AP-Flow, BANK_STATEMENT to LedgerCore', async () => {
    const pdf = buildTestPdf(['Invoice']);
    const csvBytes = Buffer.from(['Date,Description,Amount', '2026-06-01,Payment,100.00', '2026-06-02,Fee,-5.00'].join('\n'));
    const billFiles: FakeDriveFile[] = [
      { id: 'bill-file-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: String(pdf.byteLength), bytes: pdf },
    ];
    const bankFiles: FakeDriveFile[] = [
      { id: 'bank-file-1', name: 'statement.csv', mimeType: 'text/csv', size: String(csvBytes.byteLength), bytes: csvBytes },
    ];
    const cashAccountIdA = await accountId(orgA, '1110');

    const deps = await connectOrg(orgA, userA.id);
    const billFolder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps, billFiles, 'folder1234567'),
    );
    const bankFolder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'BANK_STATEMENT', folder: 'folder7654321000', ledgerAccountId: cashAccountIdA, dateFormat: 'ISO', columnMap: null },
      withFolderMetadata(deps, bankFiles, 'folder7654321000'),
    );

    const billResult = await driveSyncService.syncFolder(
      orgA,
      billFolder.id,
      withFolderMetadata(deps, billFiles, 'folder1234567'),
    );
    const bankResult = await driveSyncService.syncFolder(
      orgA,
      bankFolder.id,
      withFolderMetadata(deps, bankFiles, 'folder7654321000'),
    );

    expect(billResult).toEqual({ imported: 1, skipped: 0 });
    expect(bankResult).toEqual({ imported: 1, skipped: 0 });

    const { rows: docCount } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    expect(docCount[0]?.n).toBe(1);
    const { rows: txCount } = await pool.query('SELECT count(*)::int AS n FROM bank_transactions WHERE org_id = $1', [orgA]);
    expect(txCount[0]?.n).toBe(2);

    const { rows: resultApps } = await pool.query<{ result_app: string }>(
      'SELECT result_app FROM integration_drive_files WHERE org_id = $1 ORDER BY result_app',
      [orgA],
    );
    expect(resultApps.map((r) => r.result_app)).toEqual(['ap-flow', 'ledger-core']);
  });

  it('listFoldersDueForSync excludes a recently-synced folder and includes one due', async () => {
    const deps = await connectOrg(orgA, userA.id);
    const recentFolder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps, [], 'folder1234567'),
    );
    const dueFolder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder7654321000', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps, [], 'folder7654321000'),
    );

    await pool.query("UPDATE integration_drive_folders SET last_synced_at = now() - interval '10 seconds' WHERE id = $1", [
      recentFolder.id,
    ]);
    await pool.query("UPDATE integration_drive_folders SET last_synced_at = now() - interval '90 seconds' WHERE id = $1", [
      dueFolder.id,
    ]);
    // Sanity: the interval this test relies on really is under 90s.
    expect(INTEGRATION_DRIVE_POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000);

    const due = await driveSyncService.listFoldersDueForSync();
    const dueIds = due.filter((d) => d.orgId === orgA).map((d) => d.folderId);

    expect(dueIds).toContain(dueFolder.id);
    expect(dueIds).not.toContain(recentFolder.id);
  });

  it('GET /integrations/drive never returns token material', async () => {
    await connectOrg(orgA, userA.id);
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ciphertext');
    expect(body).not.toContain('rt-1');
    expect(body.toLowerCase()).not.toContain('refresh_token');
    expect(body.toLowerCase()).not.toContain('verifier');
    expect(body.toLowerCase()).not.toContain('oauth_state');
  });

  it('the OAuth callback redirects to /integrations with drive=error on a bad state', async () => {
    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get(`${BASE}/oauth/callback`).query({ state: 'bogus', code: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/integrations?drive=error');
  });

  it('the legacy /api/v1/ap-flow/drive/oauth/callback alias still answers', async () => {
    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get('/api/v1/ap-flow/drive/oauth/callback').query({ state: 'bogus', code: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/integrations?drive=error');
  });

  it('the sweep enqueues one sync per due folder and dedupes within an interval', async () => {
    const deps = await connectOrg(orgA, userA.id);
    await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      withFolderMetadata(deps),
    );

    await handleIntegrationDriveSweep({});
    await handleIntegrationDriveSweep({});

    const counts = await queues['integration-drive-sync'].getJobCounts();
    const total = Object.values(counts).reduce((sum: number, n) => sum + (n ?? 0), 0);
    expect(total).toBe(1);
  });

  it("an imported document's extraction is metered against that document", async () => {
    const png = await makePng();
    const files: FakeDriveFile[] = [
      { id: 'file-metered-1', name: 'receipt.png', mimeType: 'image/png', size: String(png.byteLength), bytes: png },
    ];
    const deps = await connectOrg(orgA, userA.id);
    const syncDeps = withFolderMetadata(deps, files);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      syncDeps,
    );
    await driveSyncService.syncFolder(orgA, folder.id, syncDeps);

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
