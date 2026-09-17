import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { createUserWithOrg, loginAgent, resetTables, clearStorage } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as driveConnectionService from '../../services/integrations/driveConnectionService.js';
import * as driveFolderService from '../../services/integrations/driveFolderService.js';
import * as driveSyncService from '../../services/integrations/driveSyncService.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import type { DriveServiceDeps } from '../../services/integrations/driveConnectionService.js';
import type { FetchLike } from '../../services/integrations/googleDriveClient.js';

/**
 * Guardrails rule 15's mandatory cross-tenant isolation suite for the Drive
 * integration, at the HTTP layer — driveIntake.test.ts and
 * driveDispatcher.test.ts already prove the equivalent at the service layer.
 */

const app = createApp();
const BASE = '/api/v1/integrations/drive';
const TEST_OAUTH = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/cb' };
const TEST_KEY = 'a'.repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(): FetchLike {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams((init?.body as string) ?? '');
      if (body.get('grant_type') === 'authorization_code') {
        return Promise.resolve(jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1' }));
      }
      return Promise.resolve(jsonResponse(200, { access_token: 'at-2' }));
    }
    if (url.includes('/about')) return Promise.resolve(jsonResponse(200, { user: { emailAddress: 'owner@example.com' } }));
    if (url.includes('/files?')) return Promise.resolve(jsonResponse(200, { files: [] }));
    // Any other /files/<id>?... is the folder-metadata GET (getFolder) —
    // this suite doesn't care which id, only that app-level isolation holds.
    const folderMetaMatch = /\/files\/([^?]+)\?/.exec(url);
    if (folderMetaMatch?.[1] !== undefined) {
      return Promise.resolve(
        jsonResponse(200, { id: folderMetaMatch[1], name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  }) as unknown as FetchLike;
}

async function connectOrg(orgId: string, userId: string): Promise<DriveServiceDeps> {
  const deps: DriveServiceDeps = { fetchImpl: fakeFetch(), oauth: TEST_OAUTH, encryptionKeyHex: TEST_KEY };
  const { authorizationUrl } = await driveConnectionService.startConnect(orgId, userId, deps);
  const state = new URL(authorizationUrl).searchParams.get('state') as string;
  await driveConnectionService.completeConnect(state, 'auth-code', deps);
  return deps;
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

describe('integrations drive cross-tenant isolation', () => {
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

  it("GET a folder belonging to another org 404s, never 403", async () => {
    const depsA = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsA,
    );

    await expect(driveFolderService.getFolder(orgB, folder.id)).rejects.toMatchObject({ status: 404 });
  });

  it('PATCH and DELETE on another org\'s folder both 404, and the row is unchanged', async () => {
    const depsA = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsA,
    );

    await expect(driveFolderService.updateFolder(orgB, folder.id, { isActive: false })).rejects.toMatchObject({
      status: 404,
    });
    await expect(driveFolderService.deleteFolder(orgB, folder.id)).rejects.toMatchObject({ status: 404 });

    const stillThere = await driveFolderService.getFolder(orgA, folder.id);
    expect(stillThere.isActive).toBe(true);
  });

  it("syncFolder for another org's folder id writes to neither organization", async () => {
    const depsA = await connectOrg(orgA, userA.id);
    const folder = await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsA,
    );

    const result = await driveSyncService.syncFolder(orgB, folder.id, depsA);
    expect(result).toEqual({ imported: 0, skipped: 0 });

    const { rows: docsA } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgA]);
    const { rows: docsB } = await pool.query('SELECT count(*)::int AS n FROM ap_flow_documents WHERE org_id = $1', [orgB]);
    expect(docsA[0]?.n).toBe(0);
    expect(docsB[0]?.n).toBe(0);
  });

  it("creating a BANK_STATEMENT folder naming another org's account fails with account-not-found, not a leak", async () => {
    const depsA = await connectOrg(orgA, userA.id);
    const cashAccountB = await accountId(orgB, '1110');

    await expect(
      driveFolderService.createFolder(
        orgA,
        userA.id,
        { purpose: 'BANK_STATEMENT', folder: 'folder1234567', ledgerAccountId: cashAccountB, dateFormat: 'ISO', columnMap: null },
        depsA,
      ),
    ).rejects.toMatchObject({ status: 422, message: 'Bank account not found' });
  });

  it('GET /integrations/drive as org A never lists org B\'s folders', async () => {
    const depsA = await connectOrg(orgA, userA.id);
    await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsA,
    );
    const depsB = await connectOrg(orgB, userB.id);
    await driveFolderService.createFolder(
      orgB,
      userB.id,
      { purpose: 'VENDOR_BILL', folder: 'folder7654321000', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsB,
    );

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(BASE);
    expect(res.body.folders).toHaveLength(1);
    expect(res.body.folders[0].folderId).toBe('folder1234567');
  });

  it('a forged org id in the query, header, and body all together changes nothing — the active org comes only from the token', async () => {
    const depsA = await connectOrg(orgA, userA.id);
    await driveFolderService.createFolder(
      orgA,
      userA.id,
      { purpose: 'VENDOR_BILL', folder: 'folder1234567', ledgerAccountId: null, dateFormat: null, columnMap: null },
      depsA,
    );

    const agentA = await loginAgent(app, userA);
    const honest = await agentA.get(BASE);
    const forged = await agentA
      .get(`${BASE}?orgId=${orgB}`)
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(honest.status);
    expect(forged.body).toEqual(honest.body);
  });
});
