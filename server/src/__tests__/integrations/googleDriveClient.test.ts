import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizationUrl,
  downloadFile,
  exchangeCode,
  GoogleDriveError,
  listFolderFiles,
  parseFolderInput,
  refreshAccessToken,
} from '../../services/integrations/googleDriveClient.js';
import type { FetchLike, GoogleOAuthConfig } from '../../services/integrations/googleDriveClient.js';

/**
 * Google Drive OAuth + REST adapter. Every case injects a fake `fetchImpl`;
 * none reaches the network.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CONFIG: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/cb' };

/** The mime filter every case that doesn't test mime validation itself uses. */
const PDF_ONLY = { mimeTypes: ['application/pdf'], limit: 100 };

describe('googleDriveClient', () => {
  it('authorization URL requests offline drive.readonly access with S256 PKCE', () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, 'my-state', 'my-challenge'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly');
    expect(url.searchParams.get('state')).toBe('my-state');
  });

  it('exchangeCode sends the code_verifier', async () => {
    let capturedBody = '';
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(jsonResponse(200, { access_token: 'at', refresh_token: 'rt' }));
    }) as unknown as FetchLike;

    await exchangeCode(CONFIG, 'code-123', 'verifier-abc', fetchImpl);

    const params = new URLSearchParams(capturedBody);
    expect(params.get('code_verifier')).toBe('verifier-abc');
    expect(params.get('grant_type')).toBe('authorization_code');
  });

  it('exchangeCode without a refresh_token throws NO_REFRESH_TOKEN', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: 'at' })),
    ) as unknown as FetchLike;

    await expect(exchangeCode(CONFIG, 'code', 'verifier', fetchImpl)).rejects.toMatchObject({
      code: 'NO_REFRESH_TOKEN',
    });
  });

  it('refreshAccessToken maps invalid_grant to INVALID_GRANT', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(400, { error: 'invalid_grant' })),
    ) as unknown as FetchLike;

    await expect(refreshAccessToken(CONFIG, 'rt', fetchImpl)).rejects.toMatchObject({
      code: 'INVALID_GRANT',
    });
  });

  it('listFolderFiles follows nextPageToken across pages', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          jsonResponse(200, {
            nextPageToken: 'page2',
            files: [
              { id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: '100' },
              { id: 'f2', name: 'b.pdf', mimeType: 'application/pdf', size: '200' },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, { files: [{ id: 'f3', name: 'c.pdf', mimeType: 'application/pdf', size: '300' }] }),
      );
    }) as unknown as FetchLike;

    const files = await listFolderFiles('at', '1AbCdEfGhIjKlMn', PDF_ONLY, fetchImpl);
    expect(files).toHaveLength(3);
    expect(files.every((f) => typeof f.sizeBytes === 'number')).toBe(true);
  });

  it('listFolderFiles rejects a q-injection folder id before fetching', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    await expect(
      listFolderFiles('at', "abcdefghij' or '1'='1", PDF_ONLY, fetchImpl),
    ).rejects.toThrow(GoogleDriveError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('listFolderFiles rejects a q-injection mime type before fetching', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    await expect(
      listFolderFiles('at', '1AbCdEfGhIjKlMn', { mimeTypes: ["image/png' or name = 'x"], limit: 100 }, fetchImpl),
    ).rejects.toThrow(GoogleDriveError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('listFolderFiles rejects a malformed cursor before fetching', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    await expect(
      listFolderFiles(
        'at',
        '1AbCdEfGhIjKlMn',
        { mimeTypes: ['application/pdf'], modifiedSince: '2026-01-01', limit: 100 },
        fetchImpl,
      ),
    ).rejects.toThrow(GoogleDriveError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('listFolderFiles sends the cursor as a modifiedTime >= clause', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      capturedUrl = String(url);
      return Promise.resolve(jsonResponse(200, { files: [] }));
    }) as unknown as FetchLike;

    await listFolderFiles(
      'at',
      '1AbCdEfGhIjKlMn',
      { mimeTypes: ['application/pdf'], modifiedSince: '2026-09-17T10:00:00Z', limit: 100 },
      fetchImpl,
    );

    const q = new URL(capturedUrl).searchParams.get('q') ?? '';
    expect(q).toContain("modifiedTime >= '2026-09-17T10:00:00Z'");
  });

  it('listFolderFiles orders by modifiedTime, not createdTime', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      capturedUrl = String(url);
      return Promise.resolve(jsonResponse(200, { files: [] }));
    }) as unknown as FetchLike;

    await listFolderFiles('at', '1AbCdEfGhIjKlMn', PDF_ONLY, fetchImpl);

    expect(new URL(capturedUrl).searchParams.get('orderBy')).toBe('modifiedTime');
  });

  it('listFolderFiles stops paging once the limit is met', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          nextPageToken: 'page2',
          files: Array.from({ length: 100 }, (_, i) => ({
            id: `f${String(i)}`,
            name: `${String(i)}.pdf`,
            mimeType: 'application/pdf',
          })),
        }),
      ),
    ) as unknown as FetchLike;

    const files = await listFolderFiles(
      'at',
      '1AbCdEfGhIjKlMn',
      { mimeTypes: ['application/pdf'], limit: 25 },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(files).toHaveLength(100); // one page's worth — the cap only stops further PAGING, not truncate this page
  });

  it('downloadFile refuses a Content-Length above the limit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Length': '999999999' } }),
      ),
    ) as unknown as FetchLike;

    await expect(downloadFile('at', 'file1', 1000, fetchImpl)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('parseFolderInput accepts ids and folder URLs', () => {
    expect(parseFolderInput('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=sharing')).toBe(
      '1AbCdEfGhIjKlMn',
    );
    expect(parseFolderInput('https://drive.google.com/open?id=1AbCdEfGhIjKlMn')).toBe('1AbCdEfGhIjKlMn');
    expect(parseFolderInput('1AbCdEfGhIjKlMn')).toBe('1AbCdEfGhIjKlMn');
    expect(parseFolderInput('not a folder')).toBeNull();
  });
});
