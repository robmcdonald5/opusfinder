/**
 * Trigger a digest run through the LOCAL Inngest dev server and report the result. Sends a
 * `digest/run.requested` event (the dev server fans it out to the per-user function), then polls the DB
 * until each targeted recipient has a NEW digest (or a timeout). Requires the dev server + the serve
 * endpoint to be running, and INNGEST_DEV=1 so the client routes to localhost:
 *
 *   Terminal A:  pnpm inngest:dev          # npx inngest-cli dev   (the local dev server)
 *   Terminal B:  pnpm inngest:serve        # the serve endpoint (INNGEST_DEV=1)
 *   Terminal C:  pnpm digest --all         # (or --user <uuid>)    (INNGEST_DEV=1)
 *
 * NEEDS: DATABASE_URL + ANTHROPIC_API_KEY (the per-user fn calls Haiku rerank + the Sonnet synthesis
 * batch), and a CV-ingested, eligible user. Real, batch-discounted Anthropic spend; runs a few minutes.
 * The SERVE process additionally needs RESEND_API_KEY / RESEND_API_KEY_FULL / EMAIL_FROM
 * (packages/email/.env) for the Phase-11 send tail — without them the digest still
 * persists, then the send step terminalizes to delivery_status='failed' (a send-only key breaks just
 * the poll: the run fails AFTER a successful send). NOTE: this CLI's verdict prints when the digest ROW lands
 * (persist); the send + bounded delivery poll run ~2–12 min longer — watch the dev dashboard.
 */
import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { getLatestDigestForUser, listDigestRecipients, type DigestView } from "@opusfinder/db/repos";
import { sleep } from "@opusfinder/shared/async";
import { runScript } from "@opusfinder/shared/script";
import type { UserId } from "@opusfinder/shared";

import { inngest } from "../src/index.ts";

const USAGE = "Usage: pnpm digest [--all | --user <uuid>] [--timeout-ms <n>] [--poll-ms <n>]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many recipients this CLI watches in --all mode. The ORCHESTRATOR keyset-sweeps the full list
 *  regardless — past this cap the CLI's report is partial, and says so. */
const WATCH_LIMIT = 100;

/** Parse a positive-integer flag (a non-numeric value would otherwise become NaN — a never-running
 *  poll loop, or `setTimeout(NaN)`→0 busy-loop). Returns null on a bad value so the caller errors. */
function positiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      all: { type: "boolean" },
      user: { type: "string" },
      "timeout-ms": { type: "string" },
      "poll-ms": { type: "string" },
    },
  });
  // Validate args up front — fail with a clear message instead of a NaN timeout or a silent no-op.
  if (values.user && values.all) {
    console.error(`Pass either --user <uuid> or --all, not both.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (!values.user && !values.all) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (values.user && !UUID_RE.test(values.user)) {
    console.error(`--user "${values.user}" is not a valid uuid.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const timeoutMs = positiveInt(values["timeout-ms"], 600_000); // 10 min default
  const pollMs = positiveInt(values["poll-ms"], 5_000);
  if (timeoutMs === null || pollMs === null) {
    console.error(`--timeout-ms and --poll-ms must be positive integers.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const db = createDb(getDatabaseUrl());
  // Resolve the recipients we'll watch (the orchestrator resolves its own from the same gate).
  const recipients: UserId[] = values.user
    ? [values.user as UserId]
    : (await listDigestRecipients(db, { limit: WATCH_LIMIT })).map((r) => r.userId);
  if (recipients.length === 0) {
    console.error("No eligible recipients (need a verified, digest-enabled user with a profile embedding).");
    process.exitCode = 1;
    return;
  }
  if (!values.user && recipients.length === WATCH_LIMIT) {
    console.warn(
      `WARNING: watching only the first ${WATCH_LIMIT} eligible recipients — the orchestrator ` +
        `dispatches to ALL of them, so this report (and its OK verdict) is partial.`,
    );
  }

  // Snapshot the current latest-digest id per recipient so we can detect the NEW one this run produces.
  const priorId = new Map<UserId, number | null>();
  for (const u of recipients) priorId.set(u, (await getLatestDigestForUser(db, u))?.id ?? null);

  // Fire the event. With INNGEST_DEV=1 the client routes to the local dev server, which invokes the
  // served functions. (A NonRetriable send failure usually means the dev server isn't running.)
  await inngest.send(
    values.user
      ? { name: "digest/run.requested", data: { trigger: "manual", userId: values.user } }
      : { name: "digest/run.requested", data: { trigger: "manual" } },
  );
  const target = values.user ? `user ${String(values.user).slice(0, 8)}…` : `all eligible (${recipients.length})`;
  console.log(`Sent digest/run.requested for ${target}. Polling up to ${timeoutMs}ms…`);

  // Poll for a NEW digest per recipient.
  const done = new Map<UserId, DigestView>();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs && done.size < recipients.length) {
    await sleep(pollMs);
    for (const u of recipients) {
      if (done.has(u)) continue;
      const d = await getLatestDigestForUser(db, u);
      // Only freeze a CONSISTENT snapshot: the header and its items land as two separate writes, so
      // a poll can catch a header-only gap — keep polling instead of freezing a false INCOMPLETE
      // (the report gate below re-checks the same equality as defense in depth).
      if (d && d.id !== priorId.get(u) && d.items.length === d.itemCount) done.set(u, d);
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  // Report.
  let ok = true;
  for (const u of recipients) {
    const d = done.get(u);
    const short = String(u).slice(0, 8);
    if (!d) {
      console.log(`user ${short}…: NO new digest within timeout`);
      ok = false;
      continue;
    }
    const read = d.counts.rerankCacheReadTokens ?? 0;
    const create = d.counts.rerankCacheCreationTokens ?? 0;
    console.log(
      `user ${short}…: digest #${d.id} (run ${d.digestRunId}) — ${d.itemCount} item(s); rerank cache read=${read} create=${create}`,
    );
    for (const it of d.items.slice(0, 5)) {
      console.log(`   #${it.rank} job ${it.jobId} (score ${it.score.toFixed(2)}): ${it.reason.slice(0, 100)}`);
    }
    // items.length must equal the header's itemCount: the header and the items land as two separate
    // (non-transactional) writes, so a poll can catch the gap — a header-only snapshot must not pass
    // the gate via a vacuously-true every().
    const reasonsOk =
      d.itemCount > 0 &&
      d.items.length === d.itemCount &&
      d.items.every((it) => it.reason.trim().length > 0);
    if (!reasonsOk) ok = false;
  }
  console.log(`\nDIGEST ${ok ? "OK" : "INCOMPLETE"}`);
  if (!ok) process.exitCode = 1;
}

await runScript("digest", main);
