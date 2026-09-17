import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption at rest for third-party secrets (Phase 19.2 —
 * Google Drive refresh tokens and PKCE verifiers). A 12-byte random IV per
 * call, so two encryptions of the same plaintext never look alike; the GCM
 * auth tag detects any tampering with the ciphertext before decryption ever
 * runs.
 *
 * NOT the JWT token secrets (guardrails rule 11) — this key
 * (INTEGRATION_ENCRYPTION_KEY) is a separate concern with a separate env
 * var, never reused across purposes.
 *
 * Output format: `v1.<iv>.<tag>.<ciphertext>`, each segment base64url —
 * versioned so a future algorithm change can be detected on read.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

function keyBuffer(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('Encryption key must be 32 bytes');
  }
  return key;
}

/** Encrypts `plaintext` under `keyHex` (64 hex chars = 32 bytes). */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = keyBuffer(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a payload from `encryptSecret`. Throws `Error('Invalid secret
 * payload')` on a bad format, a wrong key, or a tampered ciphertext/tag —
 * the auth tag check inside `final()` is what catches the last case.
 */
export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid secret payload');
  }
  const [, ivPart, tagPart, ciphertextPart] = parts;

  try {
    const key = keyBuffer(keyHex);
    const iv = Buffer.from(ivPart as string, 'base64url');
    const tag = Buffer.from(tagPart as string, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart as string, 'base64url');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('Invalid secret payload');
  }
}
