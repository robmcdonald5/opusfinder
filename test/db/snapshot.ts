import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// The REAL packages/db/drizzle migration set, resolved relative to THIS file (repo-root test/db/), so a new
// migration is picked up automatically — the fixture is never a hand-maintained schema copy. Same path the
// legacy per-file migrate used; the snapshot below is just a faster way to reach the identical end state.
const MIGRATIONS = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));

// Built snapshot lives in the OS temp dir — outside the repo (no gitignore/lint/Worker-guard concerns),
// OS-reaped, and shared by the globalSetup writer (main process) + every createTestDb reader (worker
// processes) via a fixed path. A filesystem file is the cross-process channel: env vars set in globalSetup
// don't reach workers, and inject() is test-only, but every process shares this path + cwd.
const CACHE_DIR = join(tmpdir(), "opusfinder-vitest-pglite");

/**
 * Fingerprint the migration SET — every `*.sql` body AND `meta/_journal.json` — so a snapshot is reused only
 * when the migrations are byte-identical. An added, edited, renamed, or removed migration changes the hash,
 * so a stale snapshot can never be loaded: the new hash points at a file that doesn't exist yet → rebuild.
 */
function migrationsHash(): string {
  const h = createHash("sha256");
  h.update(readFileSync(join(MIGRATIONS, "meta", "_journal.json")));
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    h.update(f); // filename: catches a rename that keeps identical SQL
    h.update(readFileSync(join(MIGRATIONS, f)));
  }
  return h.digest("hex").slice(0, 16);
}

/** Absolute path of the snapshot for the CURRENT migration set (hash-keyed → never stale). */
export function snapshotPath(): string {
  return join(CACHE_DIR, `schema-${migrationsHash()}.tar`);
}

/**
 * Migrate a fresh PGlite ONCE and dump an uncompressed datadir snapshot to {@link snapshotPath}. Called from
 * the integration project's vitest globalSetup (main process), before any worker starts. Idempotent: reuses
 * an existing current-hash snapshot across runs (migrations unchanged → skip the ~1.3s migrate entirely) and
 * prunes stale-hash siblings so the temp dir holds at most one snapshot. Uncompressed ("none") because it
 * both dumps (~60ms vs ~500ms gzip) and — the part that matters ×N files — loads fastest (~240ms vs ~400ms).
 */
export async function buildSnapshot(): Promise<string> {
  const path = snapshotPath();
  mkdirSync(CACHE_DIR, { recursive: true });
  pruneCache(path);
  if (existsSync(path)) return path;

  const client = new PGlite({ extensions: { vector } });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    const blob = await client.dumpDataDir("none");
    // Write to a unique temp file, then atomically rename into place. A crash/ENOSPC mid-write leaves only
    // an orphan `.tmp` (swept later by mtime) — NEVER a truncated `schema-<hash>.tar` that the existence-only
    // gates below would trust forever and load as complete, bricking every subsequent run. Both files share
    // CACHE_DIR (one filesystem), so the rename is atomic; a reader sees the whole file or nothing.
    const tmp = join(CACHE_DIR, `schema-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, Buffer.from(await blob.arrayBuffer()));
      await rename(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      // A concurrent same-hash build won the race and already placed the (byte-equivalent) snapshot — use it.
      if (existsSync(path)) return path;
      throw err;
    }
  } finally {
    await client.close();
  }
  return path;
}

/**
 * Best-effort cleanup of the cache dir: drop stale-hash snapshots (a superseded migration set) and orphan
 * `.tmp` files left by an interrupted write. Every removal is guarded — a concurrent run may hold a file
 * (Windows EPERM) — so cleanup never fails the build. `.tmp` files are pruned only when clearly dead (mtime
 * > 1h) so a concurrent run's in-flight temp is never yanked out from under its rename.
 */
function pruneCache(keep: string): void {
  const now = Date.now();
  for (const f of readdirSync(CACHE_DIR)) {
    const p = join(CACHE_DIR, f);
    try {
      if (f.startsWith("schema-") && f.endsWith(".tar")) {
        if (p !== keep) rmSync(p, { force: true });
      } else if (f.endsWith(".tmp") && now - statSync(p).mtimeMs > 3_600_000) {
        rmSync(p, { force: true });
      }
    } catch {
      // ignore — a concurrent run holds it, or it vanished between readdir and rm
    }
  }
}

/**
 * Return a ready PGlite client carrying the full migrated schema. Fast path: load the globalSetup-built
 * snapshot (~5.5× faster than replaying 24 migrations, byte-identical result — same tables, pgvector
 * extension, both HNSW indexes, `<=>` behavior, drizzle journal). Fallback: migrate a fresh instance when no
 * snapshot exists — a direct `vitest run <file>` still triggers the integration globalSetup, so this only
 * fires for a non-vitest import (e.g. a one-off script) where correctness, not speed, is the point.
 */
export async function openMigratedClient(): Promise<PGlite> {
  const path = snapshotPath();
  if (existsSync(path)) {
    try {
      const client = new PGlite({ loadDataDir: new Blob([await readFile(path)]), extensions: { vector } });
      await client.waitReady;
      return client;
    } catch {
      // The snapshot vanished mid-load (a concurrent different-hash run pruned it in the existsSync→readFile
      // window) or failed to open — drop it and fall through to a fresh migrate. Fail-OPEN: a bad/absent
      // cache entry degrades to the slow-but-correct path, never bricks the run.
      rmSync(path, { force: true });
    }
  }
  const client = new PGlite({ extensions: { vector } });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  return client;
}
