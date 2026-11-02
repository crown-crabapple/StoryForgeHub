// A small zip writer and reader on node:zlib. Deterministic output: entries in the order given, timestamps fixed at
// 1980-01-01 00:00:00, no extra fields. The reader works from the central directory and never trusts sizes it has not checked.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;
const UNIX_FILE_MODE = (0o100644 << 16) >>> 0;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * @param {{ name: string, data: Buffer, store?: boolean }[]} entries `store: true` keeps the bytes uncompressed (the EPUB mimetype file)
 * @param {{ comment?: string }} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, { comment = '' } = {}) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const method = e.store || e.data.length === 0 ? 0 : 8;
    const body = method === 0 ? e.data : deflateRawSync(e.data, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(SIG_CENTRAL, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(DOS_TIME, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(UNIX_FILE_MODE, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const commentBytes = Buffer.from(comment, 'utf8');
  if (commentBytes.length > MAX_COMMENT) throw new ZipError('zip comment too long');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...parts, centralBytes, eocd, commentBytes]);
}

/**
 * @typedef {{ name: string, method: number, flags: number, crc: number, compressedSize: number, size: number,
 *             externalAttributes: number, madeBy: number, localOffset: number }} ZipEntry
 */

/**
 * List a zip's entries from its central directory. Throws ZipError for anything that is not a complete, plain (non-zip64) archive.
 * @param {Buffer} bytes
 * @param {{ maxEntries?: number }} [limits] checked before the entry table is walked
 * @returns {{ entries: ZipEntry[], comment: string }}
 */
export function listZip(bytes, { maxEntries = Infinity } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw new ZipError('not a zip file (too short)');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - MAX_COMMENT); i--) {
    if (bytes.readUInt32LE(i) === SIG_EOCD && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('zip end record not found (the file is truncated or not a zip)');
  const disk = bytes.readUInt16LE(eocd + 4);
  const cdDisk = bytes.readUInt16LE(eocd + 6);
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || bytes.readUInt16LE(eocd + 8) !== count) throw new ZipError('multi-disk zips are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (count > maxEntries) throw new ZipTooManyError(count);
  if (cdOffset + cdSize > eocd) throw new ZipError('zip central directory is outside the file (truncated)');
  const comment = bytes.subarray(eocd + 22).toString('utf8');
  /** @type {ZipEntry[]} */
  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || bytes.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('zip central directory is damaged');
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > end) throw new ZipError('zip central directory is damaged');
    const flags = bytes.readUInt16LE(p + 8);
    entries.push({
      name: bytes.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'latin1'),
      madeBy: bytes.readUInt16LE(p + 4),
      flags,
      method: bytes.readUInt16LE(p + 10),
      crc: bytes.readUInt32LE(p + 16),
      compressedSize: bytes.readUInt32LE(p + 20),
      size: bytes.readUInt32LE(p + 24),
      externalAttributes: bytes.readUInt32LE(p + 38),
      localOffset: bytes.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, comment };
}

/** The entry count is over the caller's limit (distinct from a damaged archive). */
export class ZipTooManyError extends ZipError {
  /** @param {number} count */
  constructor(count) {
    super(`too many entries (${count})`);
    this.name = 'ZipTooManyError';
    this.count = count;
  }
}

/**
 * The uncompressed bytes of one listed entry. Checks the local header against the central one, the declared size and the CRC;
 * output is capped at the declared size, so a lying size cannot inflate into memory.
 * @param {Buffer} bytes @param {ZipEntry} entry
 * @returns {Buffer}
 */
export function readEntry(bytes, entry) {
  const o = entry.localOffset;
  if (o + 30 > bytes.length || bytes.readUInt32LE(o) !== SIG_LOCAL) throw new ZipError(`bad local header for ${entry.name}`);
  const nameLen = bytes.readUInt16LE(o + 26);
  const extraLen = bytes.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError(`entry data of ${entry.name} is truncated`);
  const localName = bytes.subarray(o + 30, o + 30 + nameLen).toString(entry.flags & 0x0800 ? 'utf8' : 'latin1');
  if (localName !== entry.name) throw new ZipError(`local and central names differ for ${entry.name}`);
  const raw = bytes.subarray(start, end);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch (e) {
      throw new ZipError(`cannot inflate ${entry.name}: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    throw new ZipError(`unsupported compression method ${entry.method} for ${entry.name}`);
  }
  if (data.length !== entry.size) throw new ZipError(`size of ${entry.name} does not match its header`);
  if (crc32(data) !== entry.crc) throw new ZipError(`checksum of ${entry.name} does not match`);
  return data;
}

/** Every entry as a Map of name -> bytes (directory entries skipped). For small, trusted archives (export verification). @param {Buffer} bytes */
export function unzip(bytes) {
  const { entries } = listZip(bytes);
  return new Map(entries.filter((e) => !e.name.endsWith('/')).map((e) => [e.name, readEntry(bytes, e)]));
}
