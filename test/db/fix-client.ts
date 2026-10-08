import type { PGlite } from "@electric-sql/pglite";

import type { FixClient } from "@opusfinder/db/fixes";

/**
 * The data-fix runner's {@link FixClient} over a PGlite test database: what packages/db/scripts/apply-fixes.ts
 * does over the neon-serverless Client. A parameterless query may hold several statements (the fix itself) and
 * returns the last one's rows; RAISE NOTICE messages collect until `takeNotices()`.
 */
export function pgliteFixClient(pg: PGlite): FixClient {
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => {
    notices.push(n.message ?? "");
  };
  return {
    async query(sql, params) {
      if (params) return (await pg.query<Record<string, unknown>>(sql, params, { onNotice })).rows;
      return (await pg.exec(sql, { onNotice })).at(-1)?.rows ?? [];
    },
    takeNotices: () => notices.splice(0),
  };
}
