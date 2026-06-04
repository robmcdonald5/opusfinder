# @opusfinder/profiles

The CV → semantic-profile pipeline (Phase 9). A PDF becomes a `user_profiles` row — structured
`{ summary, skills, targetRoles }` JSON plus a Voyage query embedding — with the original PDF and the
cached transcript living in R2.

## Pipeline

`ingestCv(db, opts)` runs the three layers:

1. **Transcribe** (`transcribe`, Layer 1) — PDF bytes → clean text (vision).
2. **Structure** (`structure`, Layer 2) — text → the final `StructuredProfile` (extraction **plus**
   the PII scrub; see "Seams").
3. **Embed** (`embed`) — `composeProfileText(structured)` → a Voyage `query` vector → `upsertUserProfile`.

The cv_file row is inserted first with a provisional `failed` status; it flips to `extracted` once the
transcript is cached. A transcript shorter than 50 chars (corrupt / encrypted / image-only PDF) is a
clean failure (no profile). A failure after the transcript is cached leaves the file `extracted` and
re-throws — the cached text stands, only the profile write failed.

## Re-run seams (the layered cache)

- `reembedProfile(db, embed, userId)` — re-embed from the stored `structured` JSON. No LLM, no
  storage. For an embedding-model swap.
- `restructureProfile(db, { structure, embed, storage }, userId)` — re-structure from the cached R2
  transcript (skips transcribe). For a structuring prompt/schema change.

## Seams (and why)

`ingestCv` takes `transcribe` / `structure` / `embed` / `storage` as INJECTED parameters rather than
importing the concrete libraries. That keeps `src/` **Worker-portable**: it never pulls
`@opusfinder/llm` (whose env module loads `node:`/dotenv), `@opusfinder/embeddings`, or the
`@opusfinder/storage` S3 client (which pulls `@aws-sdk`) into its import graph. The Node `scripts/`
wire the real impls; a Phase-12 Worker route would wire Worker-compatible ones.

The `structure` seam returns the **final** profile — its impl owns extraction **and** the
`scrubProfilePii` defense-in-depth scrub — so PII redaction happens in the wiring, keeping `src/` free
of `@opusfinder/llm`.

## Scripts

- `pnpm ingest-cv <cv.pdf> <email>` — ingest a local PDF (mints the user id from the email).
- `pnpm profiles:reembed <email>` / `pnpm profiles:restructure <email>` — drive the re-run seams.
