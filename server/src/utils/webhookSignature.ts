import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as 64 lowercase hex chars — matches the CHECK on webhook_endpoints.secret. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Returns the `X-AutoLedger-Signature` header value:
 *   sha256=<hex HMAC-SHA256(secret, `${timestampSeconds}.${rawBody}`)>
 *
 * The timestamp is INSIDE the signed string, not merely sent beside it: a
 * receiver that rejects a stale timestamp then gets replay protection for
 * free, because changing the timestamp invalidates the signature.
 */
export function signWebhookBody(secret: string, timestampSeconds: number, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${String(timestampSeconds)}.${rawBody}`).digest('hex');
  return `sha256=${mac}`;
}

/** Constant-time comparison, for the test that verifies our own signature. */
export function verifyWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
  header: string,
): boolean {
  const expected = signWebhookBody(secret, timestampSeconds, rawBody);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(header);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
