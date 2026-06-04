/**
 * The storage seam for Phase 9 CV artifacts (the durable original PDF + the cached transcript). A
 * thin interface so the pipeline (packages/profiles) depends on this CONTRACT, not on a concrete
 * client: Phase 9 ships the S3-compatible R2 client (createS3StorageClient, Node-only); Phase 12 can
 * drop in a Workers R2-binding implementation behind the SAME interface with no pipeline change.
 */

/** A single object write. `body` is raw bytes (the PDF) or a string (the transcript). */
export interface PutObjectInput {
  key: string;
  body: Uint8Array | string;
  contentType: string;
}

/** The minimal object-store operations the CV pipeline needs. */
export interface StorageClient {
  putObject(input: PutObjectInput): Promise<void>;
  /** The object's bytes, or null if the key does not exist (NOT a throw). */
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
  /** Release underlying resources (HTTP sockets). No-op for a Workers R2 binding. */
  close(): void;
}

/**
 * R2 connection config for the S3-compatible client. The endpoint encodes the account (and any
 * jurisdiction, e.g. an EU endpoint); credentials come from an R2 API token with Object Read & Write.
 */
export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}
