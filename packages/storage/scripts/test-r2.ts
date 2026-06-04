// Real put/get/delete round-trip against the configured R2 bucket. Verifies the S3 client works —
// most importantly that the WHEN_REQUIRED checksum config is correct (otherwise PutObject fails with
// "x-amz-checksum-crc32 not implemented"). Requires packages/storage/.env.
// Run: pnpm --filter @opusfinder/storage test:r2
import { runScript } from "@opusfinder/shared/script";

import { getR2Config } from "../src/env";
import { createS3StorageClient } from "../src/index";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const storage = createS3StorageClient(getR2Config());
  const key = `_roundtrip/test-${Date.now()}.txt`;
  const payload = "opusfinder R2 round-trip check";
  try {
    await storage.putObject({ key, body: payload, contentType: "text/plain" });
    const got = await storage.getObject(key);
    assert(got !== null, "getObject returns the written object");
    assert(new TextDecoder().decode(got as Uint8Array) === payload, "round-trip bytes match");
    assert((await storage.getObject("_roundtrip/missing.txt")) === null, "missing key returns null");
    await storage.deleteObject(key);
    assert((await storage.getObject(key)) === null, "deleted key returns null");

    // Binary path: the real PDF write is a Uint8Array, which goes through a different SDK body-
    // serialization branch than a string — prove bytes round-trip identically (incl. NUL + high bytes).
    const binKey = `_roundtrip/bin-${Date.now()}.bin`;
    const bytes = new Uint8Array([0, 1, 2, 200, 254, 255, 0, 42]);
    await storage.putObject({ key: binKey, body: bytes, contentType: "application/octet-stream" });
    const gotBin = await storage.getObject(binKey);
    assert(
      gotBin !== null && gotBin.length === bytes.length && gotBin.every((b, i) => b === bytes[i]),
      "binary (Uint8Array) round-trip bytes match",
    );
    await storage.deleteObject(binKey);

    console.log("PASS: R2 put/get/delete round-trip — string + binary (checksum config OK).");
  } finally {
    storage.close();
  }
}

await runScript("test-r2", main);
