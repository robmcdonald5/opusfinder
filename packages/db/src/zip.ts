/**
 * Read one file out of a zip archive, for places:load's cities500.zip, without a zip dependency. Handles
 * what GeoNames ships: stored or deflated entries, sizes in the central directory (the local header may
 * defer them to a data descriptor), no zip64, no encryption. The archive is untrusted input, so every
 * offset is bounds-checked and the inflated bytes must match the recorded size and CRC-32.
 */
import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const EOCD_SEARCH = 22 + 0xffff;

export function readZipEntry(zip: Buffer, name: string): Buffer {
  const eocd = findEocd(zip);
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    need(zip, at, 46);
    if (zip.readUInt32LE(at) !== CENTRAL_SIGNATURE)
      throw new Error("zip: bad central directory entry");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    need(zip, at + 46, nameLength);
    const entryName = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;

    if (flags & 0x1) throw new Error(`zip: ${name} is encrypted`);
    if (compressedSize === 0xffffffff || size === 0xffffffff)
      throw new Error("zip: zip64 is not supported");
    need(zip, localOffset, 30);
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error("zip: bad local header");
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    need(zip, dataStart, compressedSize);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    let out: Buffer;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) out = inflateRawSync(data, { maxOutputLength: size });
    else throw new Error(`zip: unsupported compression method ${method}`);
    if (out.length !== size || crc32(out) !== crc)
      throw new Error(`zip: ${name} failed its size/CRC check`);
    return out;
  }
  throw new Error(`zip: no entry named ${name}`);
}

function findEocd(zip: Buffer): number {
  const stop = Math.max(0, zip.length - EOCD_SEARCH);
  for (let i = zip.length - 22; i >= stop; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("zip: no end-of-central-directory record");
}

function need(zip: Buffer, offset: number, length: number): void {
  if (offset < 0 || offset + length > zip.length) throw new Error("zip: truncated archive");
}
