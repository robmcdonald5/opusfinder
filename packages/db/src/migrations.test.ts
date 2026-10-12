import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";

import * as schema from "./schema";

const DRIZZLE = fileURLToPath(new URL("../drizzle", import.meta.url));

const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshotPath = (tag: string) => join(DRIZZLE, "meta", `${tag.slice(0, 4)}_snapshot.json`);

describe("drizzle migration set", () => {
  it("numbers the journal entries 0..n-1, each tag prefixed with its index and backed by a snapshot", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.slice(0, 5)).toBe(`${String(i).padStart(4, "0")}_`);
      expect(existsSync(snapshotPath(entry.tag)), entry.tag).toBe(true);
    });
  });

  // The migrator applies an entry only when its `when` is later than the newest one the database recorded,
  // so an out-of-order entry (say, renumbered after a merge but keeping its old timestamp) is skipped in prod
  // while every test, which migrates an empty database, still applies it.
  it("orders the journal by strictly increasing `when`", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when, journal.entries[i]!.tag).toBeGreaterThan(
        journal.entries[i - 1]!.when,
      );
    }
  });

  // The migrators read only the files the journal names; a .sql file without an entry never runs anywhere.
  it("has a journal entry for every .sql file", () => {
    const files = readdirSync(DRIZZLE)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -".sql".length));
    expect(files.sort()).toEqual(journal.entries.map((e) => e.tag).sort());
  });

  // Tests and prod both build the schema from the migrations, so a schema.ts change made without
  // `pnpm --filter @opusfinder/db generate` would otherwise go unnoticed.
  it("matches schema.ts, so `drizzle-kit generate` has nothing to add", async () => {
    const latest = JSON.parse(readFileSync(snapshotPath(journal.entries.at(-1)!.tag), "utf8"));
    expect(await generateMigration(latest, generateDrizzleJson(schema, latest.id))).toEqual([]);
  });
});
