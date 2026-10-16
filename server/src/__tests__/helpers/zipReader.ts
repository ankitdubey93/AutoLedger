import zlib from 'node:zlib';

/** Test-only ZIP reader: the inverse of utils/zipWriter, verifying every CRC. */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('end of central directory not found');

  const total = buffer.readUInt16LE(eocd + 10);
  let cd = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central directory header');
    const method = buffer.readUInt16LE(cd + 10);
    const crc = buffer.readUInt32LE(cd + 16);
    const compressedSize = buffer.readUInt32LE(cd + 20);
    const nameLen = buffer.readUInt16LE(cd + 28);
    const extraLen = buffer.readUInt16LE(cd + 30);
    const commentLen = buffer.readUInt16LE(cd + 32);
    const localOffset = buffer.readUInt32LE(cd + 42);
    const path = buffer.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (zlib.crc32(data) !== crc) throw new Error(`crc mismatch for ${path}`);
    out.set(path, data);

    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
