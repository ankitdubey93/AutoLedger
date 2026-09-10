/**
 * Decides a MIME type from a buffer's own bytes — magic-byte signatures for
 * the three binary types, plus a narrow text/CSV carve-out — never from the
 * client's `Content-Type` header, which is an attacker-controlled string.
 *
 * `file-type` is not installed for this: docs/development.md refuses it the
 * same way `utils/csv.ts` and `utils/levenshtein.ts` refused their own
 * dependencies (guardrails rule 14) — a signature table this small does not
 * earn a package.
 *
 * See study/security-auth/file-upload-threat-model.md.
 */

export type SniffedMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/csv';

const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  if (buffer.length < signature.length) return false;
  return buffer.subarray(0, signature.length).equals(signature);
}

/**
 * `originalFilename` is consulted for ONE case only — CSV, which has no
 * magic bytes of its own. It is never allowed to override a binary
 * signature: a PNG renamed `evil.csv` is still reported as `image/png`.
 */
export function sniffMimeType(buffer: Buffer, originalFilename: string): SniffedMime | null {
  if (startsWith(buffer, PDF_SIGNATURE)) return 'application/pdf';
  if (startsWith(buffer, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(buffer, JPEG_SIGNATURE)) return 'image/jpeg';

  if (buffer.length === 0) return null;
  if (!originalFilename.toLowerCase().endsWith('.csv')) return null;

  // Strip a UTF-8 BOM before the text checks only — never before the binary
  // signature checks above, since a BOM is itself evidence of text.
  const body = startsWith(buffer, UTF8_BOM) ? buffer.subarray(UTF8_BOM.length) : buffer;

  if (body.length === 0) return null;
  if (body.includes(0x00)) return null;

  // A lossless UTF-8 round trip: decoding then re-encoding a byte sequence
  // that wasn't valid UTF-8 substitutes U+FFFD, which changes the bytes.
  // Equal bytes back out is the proof the buffer was text to begin with.
  const roundTrip = Buffer.from(body.toString('utf8'), 'utf8');
  if (!roundTrip.equals(body)) return null;

  return 'text/csv';
}
