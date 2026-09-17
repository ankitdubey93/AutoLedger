import { generateKeyPairSync, createVerify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAssertion,
  getServiceAccountAccessToken,
  resetServiceAccountTokenCache,
  type ServiceAccountConfig,
} from '../../services/integrations/googleServiceAccount.js';
import { GOOGLE_DRIVE_SCOPE, GOOGLE_TOKEN_URL } from '../../config/constants.js';
import type { FetchLike } from '../../services/integrations/googleDriveClient.js';

/**
 * RFC 7523 JWT-bearer assertion + token minting. Every case is pure or
 * injects a fake `fetchImpl`; none reaches the network, none needs a real
 * Google credential — the keypair is generated in-test.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CONFIG: ServiceAccountConfig = {
  clientEmail: 'autoledger-drive@my-project.iam.gserviceaccount.com',
  privateKeyPem: privateKey,
};

beforeEach(() => {
  resetServiceAccountTokenCache();
});

describe('buildAssertion', () => {
  it('carries the RS256/JWT header', () => {
    const [header] = buildAssertion(CONFIG, 1_000).split('.');
    expect(decodeSegment(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('carries the scope, audience, and a one-hour expiry, with no sub claim', () => {
    const [, claimsSegment] = buildAssertion(CONFIG, 1_000).split('.');
    const claims = decodeSegment(claimsSegment ?? '') as Record<string, unknown>;

    expect(claims.iss).toBe(CONFIG.clientEmail);
    expect(claims.scope).toBe(GOOGLE_DRIVE_SCOPE);
    expect(claims.aud).toBe(GOOGLE_TOKEN_URL);
    expect(claims.iat).toBe(1_000);
    expect(claims.exp).toBe(1_000 + 3600);
    expect('sub' in claims).toBe(false);
  });

  it('signs with a signature that verifies against the matching public key', () => {
    const assertion = buildAssertion(CONFIG, 2_000);
    const [header, claims, signature] = assertion.split('.');
    const signingInput = `${header ?? ''}.${claims ?? ''}`;

    const verified = createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(publicKey, Buffer.from(signature ?? '', 'base64url'));

    expect(verified).toBe(true);
  });

  it('throws at call time on a malformed private key, not at import', () => {
    expect(() => buildAssertion({ clientEmail: CONFIG.clientEmail, privateKeyPem: 'not-a-pem' }, 3_000)).toThrow();
  });
});

describe('getServiceAccountAccessToken', () => {
  it('mints a token via the JWT-bearer grant', async () => {
    let capturedBody = '';
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(jsonResponse(200, { access_token: 'minted-token' }));
    }) as unknown as FetchLike;

    const token = await getServiceAccountAccessToken(CONFIG, fetchImpl);

    expect(token).toBe('minted-token');
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')).toBeTruthy();
  });

  it('single-flights concurrent calls on a cold cache — exactly one fetch for 20 callers', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: 'shared-token' })),
    ) as unknown as FetchLike;

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => getServiceAccountAccessToken(CONFIG, fetchImpl)),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tokens.every((t) => t === 'shared-token')).toBe(true);
  });

  it('mints again after resetServiceAccountTokenCache', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: 'first' })),
    ) as unknown as FetchLike;

    await getServiceAccountAccessToken(CONFIG, fetchImpl);
    resetServiceAccountTokenCache();
    await getServiceAccountAccessToken(CONFIG, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a token minted for one client email is never served for another', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: 'token-for-a' })),
    ) as unknown as FetchLike;

    await getServiceAccountAccessToken(CONFIG, fetchImpl);

    const otherConfig: ServiceAccountConfig = { ...CONFIG, clientEmail: 'other@my-project.iam.gserviceaccount.com' };
    const fetchImplB = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: 'token-for-b' })),
    ) as unknown as FetchLike;

    const tokenB = await getServiceAccountAccessToken(otherConfig, fetchImplB);

    expect(tokenB).toBe('token-for-b');
    expect(fetchImplB).toHaveBeenCalledTimes(1);
  });

  it('throws GoogleDriveError with the status only, never the response body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(400, { error: 'invalid_grant_detail_that_must_not_leak' })),
    ) as unknown as FetchLike;

    await expect(getServiceAccountAccessToken(CONFIG, fetchImpl)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });
    await expect(getServiceAccountAccessToken(CONFIG, fetchImpl)).rejects.not.toMatchObject({
      message: expect.stringContaining('invalid_grant_detail_that_must_not_leak'),
    });
  });

  it('a failed mint does not poison the cache — the next call retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'recovered' })) as unknown as FetchLike;

    await expect(getServiceAccountAccessToken(CONFIG, fetchImpl)).rejects.toThrow();
    const token = await getServiceAccountAccessToken(CONFIG, fetchImpl);

    expect(token).toBe('recovered');
  });
});
