import { parseArgs } from "node:util";

import { eq, isNotNull } from "drizzle-orm";

import { createDb, type Db } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import {
  alreadyShownJobIds,
  alreadyShownSignatures,
  cosineRankIgnoringLocation,
  explainJob,
  getPlaces,
  getPreferences,
  getProfileForDigest,
  retrieveCandidatesForProfile,
  type ExplainedJob,
  type LocationFilter,
} from "@opusfinder/db/repos";
import { user, userPreferences } from "@opusfinder/db/schema";
import type { UserId } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

/**
 * Why a job is or isn't local for a user, from the location rule's own SQL (the builder retrieval uses).
 *
 *   pnpm locations:explain -- --email <email> --job <job id>
 *       each of the job's strings: stored places, confidence, reason, prompt version, miles from home;
 *       the rule case and verdict; the job's cosine rank with location ignored
 *   pnpm locations:explain -- --email <email>   the user's top candidates after the location filter
 *   pnpm locations:explain -- --all             the same preview for every approved user
 *   [--limit 15] [--recency-days N]             preview size; override the user's recency window
 */
const USAGE =
  "Usage: pnpm locations:explain -- (--email <email> [--job <id>] | --all) [--limit 15] [--recency-days N]";

await runScript("locations:explain", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      job: { type: "string" },
      all: { type: "boolean" },
      limit: { type: "string" },
      "recency-days": { type: "string" },
    },
  });
  const limit = values.limit && /^\d+$/.test(values.limit) ? Number(values.limit) : 15;
  const recencyOverride =
    values["recency-days"] && /^\d+$/.test(values["recency-days"])
      ? Number(values["recency-days"])
      : undefined;
  if (Boolean(values.email) === Boolean(values.all) || (values.job && !/^\d+$/.test(values.job))) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const db = createDb(getDatabaseUrl());

  const userIds = values.all
    ? (
        await db
          .select({ id: userPreferences.userId })
          .from(userPreferences)
          .where(isNotNull(userPreferences.digestApprovedAt))
          .orderBy(userPreferences.userId)
      ).map((r) => r.id)
    : (await db.select({ id: user.id }).from(user).where(eq(user.email, values.email!.trim()))).map(
        (r) => r.id,
      );
  if (userIds.length === 0) {
    console.error(values.all ? "No approved users." : "No user with that email.");
    process.exitCode = 1;
    return;
  }

  for (const userId of userIds) {
    await explainUser(db, userId, {
      jobId: values.job ? Number(values.job) : undefined,
      limit,
      recencyOverride,
    });
  }
});

async function explainUser(
  db: Db,
  userId: UserId,
  opts: { jobId?: number; limit: number; recencyOverride?: number },
): Promise<void> {
  const prefs = await getPreferences(db, userId);
  if (!prefs) {
    console.log(`user ${userId.slice(0, 8)}…: no preferences row\n`);
    return;
  }
  const filter: LocationFilter = {
    mode: prefs.locationMode,
    home:
      prefs.homePlaceId === null
        ? null
        : { placeId: prefs.homePlaceId, radiusMiles: prefs.radiusMiles },
  };
  const [home] = prefs.homePlaceId === null ? [] : await getPlaces(db, [prefs.homePlaceId]);
  const recencyDays = opts.recencyOverride ?? prefs.recencyDays;
  console.log(
    `user ${userId.slice(0, 8)}… · mode ${prefs.locationMode} · home ` +
      (home
        ? `${[home.name, home.regionName, home.countryCode].filter(Boolean).join(", ")} (${home.lat}, ${home.lng}) within ${prefs.radiusMiles} mi`
        : "none (location mode only)") +
      ` · recency ${recencyDays} d`,
  );

  const profile = await getProfileForDigest(db, userId);
  if (opts.jobId !== undefined) {
    const job = await explainJob(db, opts.jobId, filter);
    if (!job) {
      console.log(`  no job ${opts.jobId}\n`);
      return;
    }
    printJob(job);
    const rank = profile?.embedding
      ? await cosineRankIgnoringLocation(db, profile.embedding, job.id, recencyDays)
      : null;
    console.log(
      `  cosine rank with location ignored: ${rank ?? (profile?.embedding ? "not a candidate (closed, unembedded or too old)" : "no profile embedding")}\n`,
    );
    return;
  }

  if (!profile?.embedding) {
    console.log("  no profile embedding, so no candidates\n");
    return;
  }
  const [excludeJobIds, excludeSignatures] = await Promise.all([
    alreadyShownJobIds(db, userId),
    alreadyShownSignatures(db, userId),
  ]);
  const candidates = await retrieveCandidatesForProfile(db, profile.embedding, {
    limit: opts.limit,
    location: filter,
    recencyDays,
    exclusions: [...prefs.exclusions, ...prefs.dealbreakers],
    excludeJobIds,
    excludeSignatures,
  });
  console.log(`  top ${candidates.length} candidate(s) after the location filter:`);
  for (const [i, c] of candidates.entries()) {
    const job = await explainJob(db, c.id, filter);
    if (!job) continue;
    const where = job.strings
      .flatMap((s) => s.places.map((p) => `${p.name}${p.miles === null ? "" : ` ${p.miles} mi`}`))
      .join("; ");
    console.log(
      `  ${String(i + 1).padStart(3)}. job ${job.id} · ${job.companySlug} · ${JSON.stringify(job.title)} · ` +
        `distance ${c.distance.toFixed(3)} · ${where || "no place"} · ${job.verdict}`,
    );
  }
  console.log("");
}

function printJob(job: ExplainedJob): void {
  console.log(
    `  job ${job.id} · ${job.companySlug} · ${JSON.stringify(job.title)} · ${job.remote ? "remote" : "on-site"}`,
  );
  console.log(`  verdict: ${job.passes ? "LOCAL" : "NOT LOCAL"} — ${job.verdict}`);
  for (const s of job.strings) {
    if (!s.stored) {
      console.log(`  ${JSON.stringify(s.raw)} → not resolved yet (no row)`);
      continue;
    }
    const places = s.places.map(
      (p) =>
        `${[p.name, p.kind === "city" ? p.regionName : null, p.countryCode].filter(Boolean).join(", ")} ` +
        `(${p.kind}${p.miles === null ? "" : `, ${p.miles} mi`})`,
    );
    const remote = s.remoteCountries.length > 0 ? ` · remote: ${s.remoteCountries.join(", ")}` : "";
    const failed =
      s.unmatched.length > 0
        ? ` · failed check: ${s.unmatched.map((u) => u.city ?? u.region ?? u.country).join(", ")}`
        : "";
    console.log(
      `  ${JSON.stringify(s.raw)} → ${places.join("; ") || "no place"}${remote}${failed} · ` +
        `${s.confidence ?? "no answer"} · v${s.promptVersion} · ${s.reason ?? ""}`,
    );
  }
}
