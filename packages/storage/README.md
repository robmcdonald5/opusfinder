# @opusfinder/storage

The object-storage seam for Phase 9 CV ingestion — the durable original PDF and the cached transcript
live in Cloudflare R2; this package is the thin client over them.

## StorageClient

`StorageClient` (`putObject` / `getObject` / `deleteObject` / `close`) is the contract the CV pipeline
(`packages/profiles`) depends on, NOT a concrete client — so Phase 12 can drop in a Workers
R2-binding implementation behind the same interface with no pipeline change. `getObject` returns
`null` only for a genuinely missing key (a typed `NoSuchKey`); other errors — including a
`NoSuchBucket` from a mistyped bucket — throw. The script that constructs the client owns `close()`
(call it in a `finally`); the injected pipeline never closes a client it didn't create.

## S3-compatible R2 client

`createS3StorageClient(config)` is the Phase-9 (Node-only) implementation over R2's S3 API via
`@aws-sdk/client-s3`. **Critical:** it sets `requestChecksumCalculation` / `responseChecksumValidation`
to `WHEN_REQUIRED`, because `@aws-sdk/client-s3` >= 3.729 otherwise sends CRC32 `FULL_OBJECT`
checksums that R2 rejects (`x-amz-checksum-crc32 not implemented`) — every `PutObject` would fail.

Config is **injected** (not read from env inside the client), so the client module stays env-free; a
script reads it from the environment and passes it in.

## Object keys

`originalKey(userId, fileId)` → `originals/{userId}/{fileId}.pdf`;
`textKey(userId, fileId)` → `text/{userId}/{fileId}.txt`. One definition of the R2 layout.

## Env (`@opusfinder/shared/env` discipline)

`@opusfinder/storage/env`'s `getR2Config()` reads `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`, and the endpoint (explicit `S3_ENDPOINT_URL`, or derived from `R2_ACCOUNT_ID`) from
`packages/storage/.env` (never committed). Imported only by scripts — it runs `loadPackageEnv`, so it
must never enter a Worker bundle.

## Round-trip check

`pnpm --filter @opusfinder/storage test:r2` does a real put/get/delete against the configured bucket
(verifies the checksum config). Requires `packages/storage/.env`.
