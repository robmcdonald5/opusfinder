/**
 * A snapshot's local folder: data/snapshots/<id>/ holds the committed manifest.json, the objects/
 * a rebuild downloads (the same paths as in the bucket) and work/ for an embedding run in progress.
 * objects/ and work/ are gitignored: job text stays out of git.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { PKG_ROOT } from "../runner";
import { decodeJsonl, SnapshotJobSchema, type SnapshotJob, type SnapshotSlice } from "./format";

export const SNAPSHOTS_DIR = join(PKG_ROOT, "data", "snapshots");

export interface SnapshotPaths {
  root: string;
  manifest: string;
  objects: string;
  work: string;
}

export function snapshotPaths(id: string, snapshotsDir = SNAPSHOTS_DIR): SnapshotPaths {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id))
    throw new Error(`snapshot id must be a date (YYYY-MM-DD): ${id}`);
  const root = join(snapshotsDir, id);
  return {
    root,
    manifest: join(root, "manifest.json"),
    objects: join(root, "objects"),
    work: join(root, "work"),
  };
}

/** Every object path under `objectsDir` (forward-slashed, sorted), or [] when it doesn't exist. */
export function listObjects(objectsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // A crashed write leaves its .tmp file behind; it is not an object.
      else if (!entry.name.endsWith(".tmp"))
        out.push(relative(objectsDir, full).split(sep).join("/"));
    }
  };
  try {
    walk(objectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return out.sort();
}

export function readObject(objectsDir: string, path: string): Uint8Array {
  return readFileSync(join(objectsDir, path));
}

/** The object's size, or null when it isn't there. */
export function objectSize(objectsDir: string, path: string): number | null {
  try {
    return statSync(join(objectsDir, path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write an object whole or not at all: a temp file, then a rename. */
export function writeObject(objectsDir: string, path: string, bytes: Uint8Array): void {
  const target = join(objectsDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.tmp`, bytes);
  renameSync(`${target}.tmp`, target);
}

/** A slice's jobs parts, in part order. */
export function listJobsParts(objectsDir: string, slice: SnapshotSlice): string[] {
  return listObjects(objectsDir).filter((p) => p.startsWith(`jobs/${slice}-`));
}

export function readJobsPart(objectsDir: string, path: string): SnapshotJob[] {
  return decodeJsonl(readObject(objectsDir, path), SnapshotJobSchema, path);
}
