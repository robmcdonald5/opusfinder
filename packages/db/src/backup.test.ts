import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  BACKUP_TABLES,
  backupObjectKey,
  backupRunSql,
  databaseEndpoint,
  directUrl,
  libpqEnv,
  NOT_BACKED_UP,
  pgDumpArgs,
  RESTORE_EMPTIES,
  RESTORE_NEEDS,
  restoreList,
  serverMajorVersion,
  toolMajorVersion,
  truncateSql,
  utcDay,
} from "./backup";
import * as schema from "./schema";

// Pure-unit suite for the backup's table list and builders. What the role can read and write is
// backup.integration.test.ts; the tools themselves (pg_dump, pg_restore, psql) run in the backup workflow and
// the restore drill.

const names = (tables: readonly PgTable[]) => tables.map((t) => getTableName(t));
const ALL_TABLES = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable =>
  is(v, PgTable),
);
const BACKED_UP = names(BACKUP_TABLES);

describe("the backup's table list", () => {
  it("classifies every table in schema.ts: backed up, or not backed up with a reason", () => {
    const unclassified = names(ALL_TABLES).filter(
      (name) => !BACKED_UP.includes(name) && !(name in NOT_BACKED_UP),
    );
    // A new table fails here until it joins BACKUP_TABLES (user-owned data) or NOT_BACKED_UP.
    expect(unclassified).toEqual([]);
    expect(BACKED_UP.filter((name) => name in NOT_BACKED_UP)).toEqual([]);
    expect(Object.keys(NOT_BACKED_UP).filter((name) => !names(ALL_TABLES).includes(name))).toEqual(
      [],
    );
  });

  it("backs up every table with a user_id column except the short-lived token tables", () => {
    const withUserId = ALL_TABLES.filter((t) =>
      getTableConfig(t).columns.some((c) => c.name === "user_id"),
    );
    expect(names(withUserId).filter((name) => !BACKED_UP.includes(name))).toEqual(["session"]);
  });

  it("lists parents before children, and its only foreign keys out of the dump are RESTORE_NEEDS", () => {
    const outside = new Set<string>();
    BACKUP_TABLES.forEach((table, i) => {
      for (const fk of getTableConfig(table).foreignKeys) {
        const target = getTableName(fk.reference().foreignTable);
        const at = BACKED_UP.indexOf(target);
        if (at === -1) outside.add(target);
        else expect(at, `${getTableName(table)} → ${target}`).toBeLessThan(i);
      }
    });
    expect([...outside]).toEqual(names(RESTORE_NEEDS));
  });

  it("names every table outside the dump that points into it, so a restore empties exactly those", () => {
    const pointing = ALL_TABLES.filter(
      (t) =>
        !BACKED_UP.includes(getTableName(t)) &&
        getTableConfig(t).foreignKeys.some((fk) =>
          BACKED_UP.includes(getTableName(fk.reference().foreignTable)),
        ),
    );
    // A new one fails here: back it up, or list it in RESTORE_EMPTIES (its rows go with every restore).
    expect(names(pointing)).toEqual(names(RESTORE_EMPTIES));
    expect(truncateSql()).toBe(
      'TRUNCATE public."user", public."account", public."user_cv_files", public."user_profiles", ' +
        'public."user_preferences", public."digest_runs", public."digests", public."digest_items", public."session";',
    );
  });

  it("dumps exactly those tables, quoted, failing on a missing one", () => {
    expect(pgDumpArgs("/tmp/b.dump")).toEqual([
      "--format=custom",
      "--strict-names",
      "--no-password",
      '--table=public."user"',
      '--table=public."account"',
      '--table=public."user_cv_files"',
      '--table=public."user_profiles"',
      '--table=public."user_preferences"',
      '--table=public."digest_runs"',
      '--table=public."digests"',
      '--table=public."digest_items"',
      "--file=/tmp/b.dump",
    ]);
  });
});

describe("backupObjectKey / utcDay", () => {
  it("names the dump by its UTC date", () => {
    expect(backupObjectKey(new Date("2026-10-27T23:30:00-05:00"))).toBe(
      "user-tables/2026-10-28.dump",
    );
  });

  it("reads a --date as its UTC day and refuses one Date would roll into another", () => {
    expect(backupObjectKey(utcDay("2026-02-28"))).toBe("user-tables/2026-02-28.dump");
    expect(() => utcDay("2026-02-30")).toThrow("2026-02-30 is not a real date");
    expect(() => utcDay("2026-13-01")).toThrow(/not a real date/);
  });
});

const NEON =
  "postgresql://user_backup:p%40ss%2Fw0rd@ep-x-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("libpqEnv", () => {
  it("splits a Neon connection string into libpq variables, decoding the password", () => {
    expect(libpqEnv(NEON)).toEqual({
      PGHOST: "ep-x-123-pooler.us-east-1.aws.neon.tech",
      PGPORT: "5432",
      PGUSER: "user_backup",
      PGPASSWORD: "p@ss/w0rd",
      PGDATABASE: "neondb",
      PGSSLMODE: "require",
      PGCHANNELBINDING: "require",
    });
  });

  it("requires SSL unless the string says otherwise", () => {
    expect(libpqEnv("postgresql://u:p@localhost:6543/db").PGSSLMODE).toBe("require");
    expect(libpqEnv("postgresql://u:p@localhost/db?sslmode=disable").PGSSLMODE).toBe("disable");
  });

  it("throws on a parameter it doesn't know, naming the parameter but not its value", () => {
    const run = () => libpqEnv("postgresql://u:p@h/db?password=s3cret");
    expect(run).toThrow('unsupported connection string parameter "password"');
    expect(run).not.toThrow(/s3cret/);
  });
});

describe("directUrl / databaseEndpoint", () => {
  it("swaps a Neon pooler host for its direct endpoint and keeps the rest", () => {
    expect(directUrl(NEON)).toBe(NEON.replace("-pooler.", "."));
    expect(directUrl("postgresql://u:p@localhost:5432/db")).toBe(
      "postgresql://u:p@localhost:5432/db",
    );
  });

  it("calls the pooler and the direct host one database, and a branch's endpoint another", () => {
    const direct = "postgresql://owner:x@ep-x-123.us-east-1.aws.neon.tech/neondb?sslmode=require";
    expect(databaseEndpoint(NEON)).toBe(databaseEndpoint(direct));
    expect(databaseEndpoint(direct)).not.toBe(
      databaseEndpoint(direct.replace("ep-x-123", "ep-y-456")),
    );
    expect(databaseEndpoint(direct)).not.toBe(
      databaseEndpoint(direct.replace("/neondb", "/drill")),
    );
  });
});

describe("version parsing", () => {
  it("reads the major version from a tool and from the server", () => {
    expect(toolMajorVersion("pg_dump (PostgreSQL) 18.6\n")).toBe(18);
    expect(toolMajorVersion("pg_restore (PostgreSQL) 17.2 (Ubuntu 17.2-1.pgdg24.04+1)")).toBe(17);
    expect(serverMajorVersion("180006\n")).toBe(18);
    expect(() => toolMajorVersion("psql 18")).toThrow(/unrecognised version output/);
    expect(() => serverMajorVersion("18.6")).toThrow(/unrecognised server_version_num/);
  });
});

// A pg_restore --list of a real dump (PostgreSQL 18.6, the migrated schema), trimmed: data comes in name
// order, so `account` sits before the `user` row it points at.
const TOC = `;
; Archive created at 2026-10-26 20:57:06 CDT
;     dbname: prod
;     Dumped from database version: 18.6
;
; Selected TOC Entries:
;
230; 1259 16831 TABLE public account postgres
3824; 0 0 ACL public TABLE account postgres
236; 1259 16959 SEQUENCE public digest_items_id_seq postgres
3808; 0 16831 TABLE DATA public account postgres
3813; 0 16960 TABLE DATA public digest_items postgres
3815; 0 16978 TABLE DATA public digest_runs postgres
3817; 0 16995 TABLE DATA public digests postgres
3809; 0 16863 TABLE DATA public user postgres
3805; 0 16789 TABLE DATA public user_cv_files postgres
3811; 0 16881 TABLE DATA public user_preferences postgres
3807; 0 16808 TABLE DATA public user_profiles postgres
3844; 0 0 SEQUENCE SET public digest_items_id_seq postgres
3849; 0 0 SEQUENCE SET public user_profiles_id_seq postgres
3650; 2606 16926 FK CONSTRAINT public account account_user_id_user_id_fk postgres
`;

describe("restoreList", () => {
  it("lists each table's data parents first, then the sequence positions, and nothing else", () => {
    expect(restoreList(TOC).trimEnd().split("\n")).toEqual([
      "3809; 0 16863 TABLE DATA public user postgres",
      "3808; 0 16831 TABLE DATA public account postgres",
      "3805; 0 16789 TABLE DATA public user_cv_files postgres",
      "3807; 0 16808 TABLE DATA public user_profiles postgres",
      "3811; 0 16881 TABLE DATA public user_preferences postgres",
      "3815; 0 16978 TABLE DATA public digest_runs postgres",
      "3817; 0 16995 TABLE DATA public digests postgres",
      "3813; 0 16960 TABLE DATA public digest_items postgres",
      "3844; 0 0 SEQUENCE SET public digest_items_id_seq postgres",
      "3849; 0 0 SEQUENCE SET public user_profiles_id_seq postgres",
    ]);
  });

  it("throws when the archive is missing a table's data", () => {
    const partial = TOC.replace(/^.*TABLE DATA public digests postgres\n/m, "");
    expect(() => restoreList(partial)).toThrow("the archive has no data for digests");
  });

  it("throws on data for a table the list doesn't know", () => {
    const extra = `${TOC}3900; 0 17100 TABLE DATA public jobs postgres\n`;
    expect(() => restoreList(extra)).toThrow(/table jobs, which isn't in BACKUP_TABLES/);
  });
});

describe("backupRunSql", () => {
  it("inserts one ok backup row with the start time and counts", () => {
    expect(backupRunSql(new Date("2026-10-27T04:05:00Z"), { tables: 8, bytes: 30180 })).toBe(
      "INSERT INTO public.source_runs (pipeline, status, started_at, finished_at, counts) " +
        "VALUES ('backup', 'ok', '2026-10-27T04:05:00.000Z', now(), '{\"tables\":8,\"bytes\":30180}'::jsonb);",
    );
  });

  it("refuses a count that isn't a finite number under a plain key", () => {
    expect(() => backupRunSql(new Date(), { bytes: Number.NaN })).toThrow("bad backup count bytes");
    expect(() => backupRunSql(new Date(), { "x'y": 1 })).toThrow(/bad backup count/);
  });
});
