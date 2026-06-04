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
    console.log("PASS: R2 put/get/delete round-trip (checksum config OK).");
  } finally {
    storage.close();
  }
}

await runScript("test-r2", main);
