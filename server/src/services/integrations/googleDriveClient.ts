import {
  GOOGLE_AUTH_URL,
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_HTTP_TIMEOUT_MS,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from '../../config/constants.js';

/**
 * Google Drive OAuth 2.0 + PKCE and the Drive v3 REST surface, hand-rolled
 * over `fetch` — no `googleapis` package (guardrails rule 14; AP-Flow is
 * inside the LLM/vision carve-out already, and Drive intake follows the
 * identical no-SDK precedent `modelClient.ts`'s Gemini adapter set).
 *
 * Touches no database — this file must never import `db/connect.js`. Every
 * network call takes an injectable `fetchImpl` so tests never reach the
 * network, mirroring `modelClient.ts`'s `geminiModelClient` seam.
 */

export type FetchLike = typeof fetch;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleDriveErrorCode = 'INVALID_GRANT' | 'NO_REFRESH_TOKEN' | 'TOO_LARGE' | 'HTTP_ERROR';

export class GoogleDriveError extends Error {
  readonly code: GoogleDriveErrorCode;

  constructor(code: GoogleDriveErrorCode, message: string) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
  }
}

/** A raw Drive folder id, a `/folders/<id>` URL, or a `?id=<id>` URL. Never a query string with special characters. */
export const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/** Accepts a raw id, `.../folders/<id>...`, or `...?id=<id>`. Returns null when nothing valid is found. */
export function parseFolderInput(input: string): string | null {
  const trimmed = input.trim();

  if (DRIVE_ID_PATTERN.test(trimmed)) return trimmed;

  const folderMatch = /\/folders\/([A-Za-z0-9_-]{10,200})/.exec(trimmed);
  if (folderMatch?.[1] !== undefined) return folderMatch[1];

  try {
    const url = new URL(trimmed);
    const idParam = url.searchParams.get('id');
    if (idParam !== null && DRIVE_ID_PATTERN.test(idParam)) return idParam;
  } catch {
    // Not a URL at all — fall through to null.
  }

  return null;
}

export function buildAuthorizationUrl(config: GoogleOAuthConfig, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new GoogleDriveError('HTTP_ERROR', `Google token exchange failed with status ${String(response.status)}`);
  }

  const json = (await response.json()) as GoogleTokenResponse;
  if (json.refresh_token === undefined) {
    throw new GoogleDriveError('NO_REFRESH_TOKEN', 'Google did not return a refresh token');
  }
  if (json.access_token === undefined) {
    throw new GoogleDriveError('HTTP_ERROR', 'Google token exchange returned no access token');
  }

  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 400) {
      let json: GoogleTokenResponse = {};
      try {
        json = (await response.json()) as GoogleTokenResponse;
      } catch {
        // fall through to the generic error below
      }
      if (json.error === 'invalid_grant') {
        throw new GoogleDriveError('INVALID_GRANT', 'Google Drive access was revoked — reconnect');
      }
    }
    throw new GoogleDriveError('HTTP_ERROR', `Google token refresh failed with status ${String(response.status)}`);
  }

  const json = (await response.json()) as GoogleTokenResponse;
  if (json.access_token === undefined) {
    throw new GoogleDriveError('HTTP_ERROR', 'Google token refresh returned no access token');
  }
  return json.access_token;
}

interface GoogleAboutResponse {
  user?: { emailAddress?: string };
}

export async function getAccountEmail(accessToken: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(`${GOOGLE_DRIVE_API_BASE}/about?fields=user(emailAddress)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new GoogleDriveError('HTTP_ERROR', `Google Drive "about" request failed with status ${String(response.status)}`);
  }

  const json = (await response.json()) as GoogleAboutResponse;
  const email = json.user?.emailAddress;
  if (email === undefined) {
    throw new GoogleDriveError('HTTP_ERROR', 'Google Drive "about" response carried no email address');
  }
  return email;
}

interface GoogleFileMetadata {
  id?: string;
  name?: string;
  mimeType?: string;
}

export async function getFolder(
  accessToken: string,
  folderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string; name: string; mimeType: string } | null> {
  if (!DRIVE_ID_PATTERN.test(folderId)) return null;

  const response = await fetchImpl(
    `${GOOGLE_DRIVE_API_BASE}/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS) },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new GoogleDriveError('HTTP_ERROR', `Google Drive "get folder" request failed with status ${String(response.status)}`);
  }

  const json = (await response.json()) as GoogleFileMetadata;
  if (json.id === undefined || json.name === undefined || json.mimeType === undefined) return null;
  return { id: json.id, name: json.name, mimeType: json.mimeType };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
}

interface GoogleFileListResponse {
  nextPageToken?: string;
  files?: {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    md5Checksum?: string;
    modifiedTime?: string;
  }[];
}

/** Only a bare mime type like `application/pdf` — no wildcards, no query operators. */
const DRIVE_MIME_PATTERN = /^[a-z]+\/[A-Za-z0-9.+-]+$/;

/** An RFC-3339 UTC instant, the shape Drive's own `modifiedTime` field uses. */
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export interface ListFolderOptions {
  /** Drive mimeTypes to include. Purpose-dependent — the caller decides (see DRIVE_MIME_TYPES_BY_PURPOSE). */
  mimeTypes: readonly string[];
  /** RFC-3339 UTC floor, inclusive. Omit for a full listing. */
  modifiedSince?: string;
  /** Stop paging once this many files are collected. */
  limit: number;
}

export async function listFolderFiles(
  accessToken: string,
  folderId: string,
  options: ListFolderOptions,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile[]> {
  // The `q` string below has NO bind parameters — Drive's query language has
  // none to offer — so every fragment interpolated into it is whitelisted
  // BEFORE any fetch. This is the parameterization equivalent for a query
  // language that has no bind parameters (guardrails rule 4's spirit).
  if (!DRIVE_ID_PATTERN.test(folderId)) {
    throw new GoogleDriveError('HTTP_ERROR', 'Invalid Drive folder id');
  }
  for (const mimeType of options.mimeTypes) {
    if (!DRIVE_MIME_PATTERN.test(mimeType)) {
      throw new GoogleDriveError('HTTP_ERROR', 'Invalid Drive mime type');
    }
  }
  if (options.modifiedSince !== undefined && !RFC3339_UTC_PATTERN.test(options.modifiedSince)) {
    throw new GoogleDriveError('HTTP_ERROR', 'Invalid Drive cursor');
  }

  const mimeClause = options.mimeTypes.map((mimeType) => `mimeType = '${mimeType}'`).join(' or ');
  const q =
    `'${folderId}' in parents and trashed = false and (${mimeClause})` +
    (options.modifiedSince === undefined ? '' : ` and modifiedTime >= '${options.modifiedSince}'`);

  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)',
      // Ascending modifiedTime, not createdTime: with a modifiedTime cursor
      // and a capped page, this ordering makes the processed prefix
      // contiguous, so the caller's cursor can safely advance past exactly
      // what this call returned. Ordering by createdTime while cursoring on
      // modifiedTime would strand files between the two orderings.
      orderBy: 'modifiedTime',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken !== undefined) params.set('pageToken', pageToken);

    const response = await fetchImpl(`${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new GoogleDriveError('HTTP_ERROR', `Google Drive "list files" request failed with status ${String(response.status)}`);
    }

    const json = (await response.json()) as GoogleFileListResponse;
    for (const file of json.files ?? []) {
      if (file.id === undefined || file.name === undefined || file.mimeType === undefined) continue;
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.size === undefined ? null : Number(file.size),
        md5Checksum: file.md5Checksum ?? null,
        modifiedTime: file.modifiedTime ?? null,
      });
    }
    pageToken = json.nextPageToken;
    // Stop paging once the cap is met rather than walking the entire folder
    // and slicing afterward — on a large folder that is the difference
    // between one API call and fifty.
  } while (pageToken !== undefined && files.length < options.limit);

  return files;
}

export async function downloadFile(
  accessToken: string,
  fileId: string,
  maxBytes: number,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const response = await fetchImpl(`${GOOGLE_DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new GoogleDriveError('HTTP_ERROR', `Google Drive "download file" request failed with status ${String(response.status)}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new GoogleDriveError('TOO_LARGE', 'File exceeds the size limit');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new GoogleDriveError('TOO_LARGE', 'File exceeds the size limit');
  }
  return buffer;
}

/** Best-effort. Swallows every error — a revoked grant does not need a second revoke to succeed. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — the caller has already deleted the ciphertext, so the
    // grant is useless locally regardless of whether Google acknowledges it.
  }
}
