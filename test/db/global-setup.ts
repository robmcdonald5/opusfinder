import { buildSnapshot } from "./snapshot";

/**
 * Vitest globalSetup for the `integration` project ONLY (wired per-project in vitest.config.ts, so `unit`
 * and `live` runs never pay for it). Runs ONCE in the main process, before any worker starts, and builds the
 * PGlite schema snapshot that every integration file's `createTestDb()` loads instead of replaying the 24
 * drizzle migrations (~1.3s → ~0.24s per file). The snapshot goes to a fixed OS-temp path; workers read it
 * by that path (a filesystem file is the cross-process channel — env vars set here don't reach workers).
 *
 * No teardown: the hash-keyed snapshot is intentionally LEFT for reuse across runs (migrations unchanged →
 * the next run's build is a no-op). buildSnapshot() prunes stale-hash siblings, so the temp dir never grows.
 */
export default async function setup(): Promise<void> {
  await buildSnapshot();
}
