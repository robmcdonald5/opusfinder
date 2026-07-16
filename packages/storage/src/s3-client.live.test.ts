/**
 * LIVE gate (opt-in) — a real put/get/delete round-trip against the configured Cloudflare R2 bucket.
 * Ports the retired `scripts/test-r2.ts` into the vitest `live` project. Proves the seam PGlite/MSW
 * cannot fake (VITEST_MIGRATION_PLAN
 * §8, "R2/S3 real round-trip"): that `createS3StorageClient`'s checksum config is correct — the
 * `requestChecksumCalculation:"WHEN_REQUIRED"` option is LOAD-BEARING, because @aws-sdk/client-s3 >= 3.729
 * sends CRC32 FULL_OBJECT checksums by default and R2 rejects them ("x-amz-checksum-crc32 not
 * implemented"), so WITHOUT the option every PutObject fails. Also exercises the binary (Uint8Array) body
 * path, which serializes through a different SDK branch than a string.
 *
 * LIVES IN THE `live` VITEST PROJECT (`*.live.test.ts`, no MSW) — NOT `integration`. MSW 2.x's setupServer
 * intercepts `fetch`, so the S3 client's real HTTPS request would hard-fail under the integration project's
 * onUnhandledRequest:"error". The no-MSW `live` project lets the real request through.
 *
 * NEVER runs in CI's secret-free lane: gated on an EXPLICIT opt-in flag (R2_LIVE_TEST=1) ON TOP of creds,
 * so it SKIPS cleanly on every dev box and in `pnpm test` even when a package .env defines R2 creds. The
 * gated nightly lane runs it against a dedicated `opusfinder-ci` bucket (§9 Q6). The top-level imports are
 * side-effect-free apart from loadPackageEnv (a lazy config reader), so the file loads — and skips —
 * without any creds present.
 *
 *   R2_LIVE_TEST=1 pnpm test:live
 */
import { afterAll, describe, expect, it } from "vitest";

import type { StorageClient } from "./types";

import { getR2Config } from "./env";
import { createS3StorageClient } from "./s3-client";

// getR2Config() reads R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME and one of
// R2_ACCOUNT_ID | S3_ENDPOINT_URL; gate on all of them so an incomplete .env SKIPS rather than throwing
// at getR2Config() time.
const LIVE =
  process.env.R2_LIVE_TEST === "1" &&
  !!process.env.R2_ACCESS_KEY_ID &&
  !!process.env.R2_SECRET_ACCESS_KEY &&
  !!process.env.R2_BUCKET_NAME &&
  !!(process.env.R2_ACCOUNT_ID || process.env.S3_ENDPOINT_URL);

describe.skipIf(!LIVE)("R2 round-trip (live: real bucket)", () => {
  let storage: StorageClient | undefined;

  afterAll(() => {
    // The S3Client holds keep-alive HTTP sockets; destroy it or the process won't exit cleanly.
    storage?.close();
  });

  it("round-trips string + binary bodies and returns null for a missing key (WHEN_REQUIRED checksum OK)", async () => {
    storage = createS3StorageClient(getR2Config());
    // Unique per run so a prior run's failed teardown can't collide; the leading `_livetest/` prefix
    // segregates these from real CV artifacts.
    const runId = crypto.randomUUID();

    const textKey = `_livetest/${runId}/string.txt`;
    const payload = "opusfinder R2 round-trip check";
    await storage.putObject({ key: textKey, body: payload, contentType: "text/plain" });
    const got = await storage.getObject(textKey);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe(payload);

    // A genuinely-absent key returns null (NOT a throw) — the contract the CV pipeline branches on.
    expect(await storage.getObject(`_livetest/${runId}/missing.txt`)).toBeNull();

    await storage.deleteObject(textKey);
    expect(await storage.getObject(textKey)).toBeNull();

    // Binary path: the real PDF write is a Uint8Array, which goes through a different SDK body
    // serialization branch than a string — prove bytes round-trip identically (incl. NUL + high bytes).
    const binKey = `_livetest/${runId}/bytes.bin`;
    const bytes = new Uint8Array([0, 1, 2, 200, 254, 255, 0, 42]);
    await storage.putObject({ key: binKey, body: bytes, contentType: "application/octet-stream" });
    const gotBin = await storage.getObject(binKey);
    expect(gotBin).not.toBeNull();
    expect(Array.from(gotBin!)).toEqual(Array.from(bytes));
    await storage.deleteObject(binKey);
    expect(await storage.getObject(binKey)).toBeNull();
  });
});
