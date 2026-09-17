import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import { pkceChallengeS256 } from '../utils/pkce.js';

const KEY = 'a'.repeat(64);

describe('secretBox', () => {
  it('round-trips a secret', () => {
    const payload = encryptSecret('my-refresh-token', KEY);
    expect(decryptSecret(payload, KEY)).toBe('my-refresh-token');
  });

  it('two encryptions of the same plaintext differ', () => {
    const a = encryptSecret('same-value', KEY);
    const b = encryptSecret('same-value', KEY);
    expect(a).not.toBe(b);
  });

  it('a tampered ciphertext is rejected', () => {
    const payload = encryptSecret('my-refresh-token', KEY);
    const parts = payload.split('.');
    const last = parts[3] as string;
    const flipped = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
    const tampered = [parts[0], parts[1], parts[2], flipped].join('.');
    expect(() => decryptSecret(tampered, KEY)).toThrow('Invalid secret payload');
  });

  it('the wrong key is rejected', () => {
    const payload = encryptSecret('my-refresh-token', KEY);
    const wrongKey = 'b'.repeat(64);
    expect(() => decryptSecret(payload, wrongKey)).toThrow('Invalid secret payload');
  });

  it('pkceChallengeS256 matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
