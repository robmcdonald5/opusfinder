# @opusfinder/profiles

The CV → semantic-profile pipeline (Phase 9). A PDF becomes a `user_profiles` row — structured
`{ summary, skills, targetRoles }` JSON plus a Voyage query embedding — with the original PDF and the
cached transcript living in R2.

## Pipeline

`ingestCv(db, opts)` runs the three layers:

1. **Transcribe** (`transcribe`, Layer 1) — PDF bytes → clean text (vision).
2. **Structure** (`structure`, Layer 2) — text → `StructuredProfile` (raw extraction). The pipeline
   then runs `scrubProfilePii` before persisting + embedding.
3. **Embed** (`embed`) — `composeProfileText(structured)` → a Voyage `query` vector → `upsertUserProfile`.

The cv_file row is inserted first with a provisional `failed` status; it flips to `extracted` once the
transcript is cached. A transcript shorter than 50 chars (corrupt / encrypted / image-only PDF) is a
clean failure (no profile). A failure after the transcript is cached leaves the file `extracted` and
re-throws — the cached text stands, only the profile write failed.

## Re-run seam (the layered cache)

- `restructureProfile(db, { structure, embed, storage }, userId)` — re-structure from the cached R2
  transcript (skips the expensive transcribe). For a structuring prompt/schema change. Re-running a
  whole pipeline (e.g. for an embedding-model swap) is done by re-running `ingest-cv` on the original
  PDF until the corpus is large enough to warrant a dedicated re-embed path.

## Seams (and why)

`ingestCv` takes `transcribe` / `structure` / `embed` / `storage` as INJECTED parameters rather than
importing the concrete libraries. That keeps `src/` **Worker-portable**: it never pulls
`@opusfinder/llm` (whose env module loads `node:`/dotenv), `@opusfinder/embeddings`, or the
`@opusfinder/storage` S3 client (which pulls `@aws-sdk`) into its import graph. The Node `scripts/`
wire the real impls; a Phase-12 Worker route would wire Worker-compatible ones.

The `structure` seam returns **raw** extraction; the pipeline itself runs `scrubProfilePii`
(`@opusfinder/shared`, node-free) before persisting + embedding, so PII redaction is a **structural
guarantee**, not a seam contract — `src/` stays free of `@opusfinder/llm`.

## Scripts

- `pnpm ingest-cv <cv.pdf> <email>` — ingest a local PDF (mints the user id from the email).
- `pnpm profiles:restructure <email>` — re-structure a profile from its cached transcript.
- `pnpm --filter @opusfinder/profiles test:ingest` — smoke-test `ingestCv` with stub seams + an
  in-memory store (no LLM / Voyage / R2 spend); writes a few rows under a fixed test user.

## Known gaps

- **R2 object lifecycle.** Each ingest mints a fresh `uploadId`, and a pre-extraction failure stores
  the original PDF before failing — so old/failed R2 objects accumulate (cv_file rows are append-only
  history; the current profile only references the latest upload). `deleteObject` exists but no
  sweeper reclaims orphans yet. Fine at Phase-9 scale (a script, low volume); a cleanup job is
  deferred to a later phase.
