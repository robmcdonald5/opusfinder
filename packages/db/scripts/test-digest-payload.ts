import { parseArgs } from "node:util";

import { desc, eq } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { getDigestEmailPayload } from "../src/repos/digests";
import { digests } from "../src/schema";

/**
 * Smoke check for `getDigestEmailPayload` (Phase 11b) against a REAL Phase-10 digest row: the joined
 * read must return the header + every ACTIVE ranked item with the render fields populated. (G1b filters
 * items to `lifecycle_state='active'` app-side, so the payload may carry FEWER than `item_count` — even
 * zero, if all jobs closed after persist; the count check is `<=`, not `===`.) Echoes counts and lengths
 * only — never an address, a title, or a reason (scraped content + PII stay out of logs).
 *
 *   pnpm --filter @opusfinder/db test:digest-payload [--digest <id>]   (default: newest digest)
 */
await runScript("test-digest-payload", async () => {
  const db = createDb(getDatabaseUrl());

  const { values } = parseArgs({
    options: { digest: { type: "string" } },
  });

  let digestId: number;
  if (values.digest !== undefined) {
    digestId = Number(values.digest);
    if (!Number.isInteger(digestId) || digestId <= 0) {
      throw new Error(`--digest expects a positive integer, got "${values.digest}"`);
    }
  } else {
    const rows = await db
      .select({ id: digests.id, itemCount: digests.itemCount })
      .from(digests)
      .orderBy(desc(digests.id))
      .limit(1);
    const newest = rows[0];
    if (!newest) throw new Error("no digests rows yet — run the Phase-10 pipeline first.");
    digestId = newest.id;
  }

  const payload = await getDigestEmailPayload(db, digestId);
  assert(payload !== null, `payload is null for digest ${digestId}`);

  const header = await db
    .select({ itemCount: digests.itemCount })
    .from(digests)
    .where(eq(digests.id, digestId))
    .limit(1);
  const expected = header[0]?.itemCount;
  // G1b: the render filters items to active, so the payload count is ≤ item_count (a job closed after
  // persist drops out; all-closed → 0). In the common case (no post-persist close) it still equals it.
  assert(
    typeof expected === "number" && payload.items.length <= expected,
    `items.length ${payload.items.length} > header item_count ${String(expected)}`,
  );
  assert(payload.recipient.email.length > 0, "recipient email is empty");
  assert(payload.recipient.name.length > 0, "recipient name is empty");
  assert(payload.createdAt instanceof Date, "createdAt is not a Date");

  for (const it of payload.items) {
    assert(it.rank > 0, `item rank ${it.rank} is not positive`);
    assert(it.title.length > 0, `rank ${it.rank}: empty title`);
    assert(it.companySlug.length > 0, `rank ${it.rank}: empty companySlug`);
    assert(it.reason.length > 0, `rank ${it.rank}: empty reason`);
    assert(it.applyUrl.length > 0, `rank ${it.rank}: empty applyUrl`);
    assert(Array.isArray(it.locations), `rank ${it.rank}: locations is not an array`);
  }
  const ranks = payload.items.map((it) => it.rank);
  assert(
    ranks.every((r, i) => i === 0 || r > (ranks[i - 1] as number)),
    `ranks are not strictly ascending: [${ranks.join(", ")}]`,
  );

  console.log(
    `digest ${digestId}: ${payload.items.length} item(s); recipient email len ${payload.recipient.email.length}; ` +
      `createdAt=${payload.createdAt.toISOString()}; titles len [${payload.items.map((i) => i.title.length).join(", ")}]`,
  );
  console.log("test-digest-payload OK");
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
