// Public surface of @opusfinder/storage — the object-storage seam for CV artifacts. Deliberately does
// NOT re-export ./env (it runs loadPackageEnv and is Node/script-only); import `@opusfinder/storage/env`
// directly from a script to read R2 creds from the environment.
export { createS3StorageClient } from "./s3-client";
export { originalKey, textKey } from "./keys";
export type { PutObjectInput, R2Config, StorageClient } from "./types";
