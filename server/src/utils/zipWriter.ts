import zlib from 'node:zlib';

/**
 * Phase 45 — a minimal ZIP writer (PKWARE APPNOTE 4.3), just enough for .xlsx.
 * Deflate (method 8) or stored (method 0), UTF-8 names, no ZIP64, no encryption.
 * The DOS timestamp is fixed at 1980-01-01 so the output is deterministic.
 * `zlib.crc32` needs Node 22.2+ (engines.node).
 */

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const MAX_U32 = 0xffffffff;
const FLAGS_UTF8 = 0x0800;
const DOS_DATE_1980 = 0x0021;

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('ZIP64 is not supported');

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = zlib.crc32(entry.data); // CRC of the UNCOMPRESSED bytes
    const deflated = zlib.deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const method = stored ? 0 : 8;
    const body = stored ? entry.data : deflated;

    if (body.length >= MAX_U32 || entry.data.length >= MAX_U32 || offset >= MAX_U32) {
      throw new Error('ZIP64 is not supported');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAGS_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  if (centralBuf.length >= MAX_U32 || offset >= MAX_U32) throw new Error('ZIP64 is not supported');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}
