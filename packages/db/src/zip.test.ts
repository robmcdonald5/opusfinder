import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { readZipEntry } from "./zip";

/** A minimal zip with one deflated entry whose sizes live only in the central directory (data-descriptor
 *  style, as GeoNames ships it). */
function zipOf(name: string, content: Buffer, opts: { crc?: number } = {}): Buffer {
  const data = deflateRawSync(content);
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0808, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(opts.crc ?? crc32(content), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

describe("readZipEntry", () => {
  const content = Buffer.from("4509177\tColumbus\n".repeat(50), "utf8");

  it("inflates the named entry", () => {
    expect(readZipEntry(zipOf("cities500.txt", content), "cities500.txt").equals(content)).toBe(
      true,
    );
  });

  it("refuses an entry whose CRC doesn't match", () => {
    expect(() =>
      readZipEntry(zipOf("cities500.txt", content, { crc: 1 }), "cities500.txt"),
    ).toThrow(/CRC/);
  });

  it("refuses a missing entry and a truncated archive", () => {
    const zip = zipOf("cities500.txt", content);
    expect(() => readZipEntry(zip, "other.txt")).toThrow(/no entry named other\.txt/);
    expect(() => readZipEntry(zip.subarray(0, 10), "cities500.txt")).toThrow(/zip:/);
  });
});
