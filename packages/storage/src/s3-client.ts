import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { PutObjectInput, R2Config, StorageClient } from "./types";

/**
 * An S3-compatible {@link StorageClient} backed by Cloudflare R2's S3 API. Node-only (Phase 9 is
 * script-first); Phase 12 can add a Workers R2-binding client behind the same interface.
 *
 * The two checksum options are LOAD-BEARING: `@aws-sdk/client-s3` >= 3.729 defaults to sending CRC32
 * FULL_OBJECT checksums on every request, but R2 only supports CRC32 COMPOSITE and rejects them
 * ("x-amz-checksum-crc32 not implemented"), so WITHOUT this every PutObject fails. WHEN_REQUIRED stops
 * the SDK adding a checksum unless the operation actually requires one. Config is INJECTED (not read
 * from env here) so this module stays env-free; a script reads getR2Config() and passes it in.
 */
export function createS3StorageClient(config: R2Config): StorageClient {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const { bucket } = config;

  return {
    async putObject({ key, body, contentType }: PutObjectInput): Promise<void> {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getObject(key: string): Promise<Uint8Array | null> {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body ? await res.Body.transformToByteArray() : null;
      } catch (err) {
        // R2 returns a typed NoSuchKey for a missing object; some paths surface a bare 404.
        if (err instanceof NoSuchKey || httpStatus(err) === 404) return null;
        throw err;
      }
    },
    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    close(): void {
      client.destroy();
    },
  };
}

/** The HTTP status of an AWS SDK error, if present. */
function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  }
  return undefined;
}
