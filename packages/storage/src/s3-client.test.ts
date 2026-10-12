import { NoSuchKey, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createS3StorageClient } from "./s3-client";

// The real round-trip is the opt-in live gate (s3-client.live.test.ts); this pins getObject's error
// mapping offline by stubbing the SDK's send().

const CONFIG = {
  endpoint: "https://r2.invalid",
  accessKeyId: "id",
  secretAccessKey: "secret",
  bucket: "bucket",
};

describe("createS3StorageClient getObject — missing object vs other errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null for NoSuchKey", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
      new NoSuchKey({ message: "The specified key does not exist.", $metadata: {} }),
    );
    expect(await createS3StorageClient(CONFIG).getObject("cv/text/a.txt")).toBeNull();
  });

  it("rethrows a NoSuchBucket 404 instead of reporting the object as absent", async () => {
    const noBucket = new S3ServiceException({
      name: "NoSuchBucket",
      $fault: "client",
      message: "The specified bucket does not exist",
      $metadata: { httpStatusCode: 404 },
    });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(noBucket);
    await expect(createS3StorageClient(CONFIG).getObject("cv/text/a.txt")).rejects.toBe(noBucket);
  });
});
