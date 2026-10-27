// The stage registry — the ONE place every switch is declared (control-surface architecture §5, §13).
// The control Worker's API + page, `pnpm ctl`, the classify() policy, the runtime gates (the scrapers Worker,
// in shadow) and (a later slice) guard:schedules all DERIVE their lists from this file. The few copies a
// runtime keeps (db/health's check ids, the scrapers Worker's stage names) are pinned by sync tests.
//
// WORKER-SAFE, PURE DATA + TYPES. This package is compiled into the control Worker and the scrapers Worker
// (which checks its gate's mode against `stages`), so: no `process`, no Buffer, no node:* imports, and NO
// workspace dependency at all — never @opusfinder/db (and so never @opusfinder/db/health, the H1 landmine).
// `pnpm guard:worker` enforces it (source scan + a browser-platform bundle with an inputs allow-list) and
// the control Worker's node-types-free tsconfig fails on any Node global reached through this graph.

/** A stage's run mode. `shadow` = run, compute and log what it WOULD do, spend/change nothing irreversible. */
export type StageMode = "off" | "shadow" | "on";
/** A policy's mode (a behaviour switch read inside stages). `off` is also the fail-closed reading of an
 *  unrecognised stored value, even for a policy whose settable modes don't list it (see resolve.ts). */
export type PolicyMode = "off" | "shadow" | "enforce";
export type GlobalMode = "off" | "on";
export type Mode = StageMode | PolicyMode;

/**
 * The ratchet's total order, least → most spend/risk (§1 "Safe direction"). `on` and `enforce` share the
 * top rank: an entry uses one or the other, never both, so they are never compared with each other.
 */
export const MODE_RANK: Readonly<Record<Mode, number>> = { off: 0, shadow: 1, on: 2, enforce: 2 };
export const TOP_RANK = 2;

export type Runtime =
  | "cf:opusfinder-scrapers" // Cloudflare Worker; reads gates via a service binding (RPC)
  | "inngest:opusfinder" // Inngest functions served from apps/web on Vercel
  | "gh:live-integration.yml" // GitHub Actions workflow
  | "gh:backup.yml" // GitHub Actions workflow
  | "cli"; // run by hand (pnpm …)

/**
 * Units a run may record in the ledger (B1): exact quantities, never priced here (Cost comes from the
 * vendors' statements). `<vendor>.<metric>` is what a vendor bills or meters; `<stage>.<metric>` is a
 * stage's own work count, kept so a run's cost can be read against how much it did.
 */
export const UNIT_IDS = [
  "voyage.tokens",
  "anthropic.haiku.in",
  "anthropic.haiku.out",
  "anthropic.haiku.cache_write",
  "anthropic.haiku.cache_read",
  "anthropic.sonnet.batch.in",
  "anthropic.sonnet.batch.out",
  "resend.emails",
  "cf.wall_ms",
  "cf.subrequests",
  "neon.awake_s",
  "gh.minutes",
  "r2.bytes",
  "ingest.boards", // boards the tick got through: ok, failed or rate-limit-skipped (not the budget-stopped rest)
  "ingest.boards_failed", // boards whose final outcome was an error
  "ingest.boards_rate_limited", // boards skipped while their ATS was cooling down from a 429
  "ingest.jobs_changed", // postings inserted or updated
] as const;
export type UnitId = (typeof UNIT_IDS)[number];

/**
 * What an AGENT may do to an entry on its own (T2, §11.2). This is a per-entry rule — classify() reads it
 * generically and has no special cases:
 *   - "safe-direction": a move toward LESS (mode down the order, knob opposite its `riskier` side, a new
 *     narrowing override) applies immediately; a move toward MORE becomes a proposal for the owner.
 *   - "approval": EVERY agent move is a proposal, in either direction. Owner decisions 2026-10-04: every
 *     health check (quieter alerting — enforce→shadow, a looser threshold — is itself a risk: it is how
 *     an outage goes unnoticed), the `alerts` stage (an agent must not be able to silence all alerting)
 *     and the master switch (an agent may stop any single spending stage, but not everything at once).
 *     A knob follows its entry's rule, so e.g. alerts.cooldownH needs approval too.
 * The owner role is never restricted; the runtime role may only trip a stage off (classify.ts).
 */
export type AgentRule = "safe-direction" | "approval";

export interface Knob {
  label: string;
  default: number;
  min: number;
  max: number;
  /** Which direction means more spend or more risk. Moving the other way is agent-safe. */
  riskier: "up" | "down";
  /** Whole numbers only (counts, hours, days). */
  int?: true;
  unit?: string;
  /** Today's env var. Read as a fallback during the shadow period, then deleted (§5.3). */
  legacyEnv?: string;
}

/**
 * Dimensions a stage can be NARROWED by (§5.1). An override can only make a slice LESS on than its stage —
 * effective = the lowest of (global, stage, override) — so adding one is always a move toward less.
 * The values are mirrored from the source of truth (the `adapters` record keys in @opusfinder/sources and
 * `SEED_LANES` in @opusfinder/discovery), which this pure package may not import; the sync tests in those
 * packages fail when a new adapter or lane is added without its entry here.
 * The digest's per-USER dimension deliberately stays in Neon (`user_preferences.digest_approved_at`, set
 * by `pnpm user:approve`, already fail-closed at 3 sites) — §5.3; it is not a control-plane dimension.
 */
export const DIMENSIONS = {
  source: [
    "greenhouse",
    "lever",
    "ashby",
    "workable",
    "smartrecruiters",
    "pinpoint",
    "gem",
    "recruitee",
    "trakstar",
  ],
  lane: ["outscal", "hn"],
} as const satisfies Record<string, readonly string[]>;
export type DimKey = keyof typeof DIMENSIONS;

export interface StageDef {
  label: string;
  runtime: Runtime;
  /** Platform function/workflow id, for drift probes and the panel. */
  platformId?: string;
  trigger: { cron: string } | { event: string } | { manual: true };
  /** Modes that make sense for this stage, safest first (§5.2: shadow only where cheap and informative). */
  modes: readonly StageMode[];
  shadowMeans?: string;
  /**
   * The registry DEFAULT: what a missing `state` row resolves to (fail-closed layer 1, §3.3). For the
   * stages present at adoption this equals the slice-1 seed (migration 0002 — "today's reality", §12.1).
   * A stage ADDED LATER must ship with `initial: "off"` so it starts off until the owner turns it on.
   */
  initial: StageMode;
  /**
   * How far this stage's runtime has been wired to the control plane (§12.2), so the panel can say whether
   * flipping it changes anything yet: "unwired" = the runtime never reads its gate (its env vars, constants
   * and vendor pauses still rule); "shadow" = it reads and logs the gate, then runs exactly as before;
   * "enforced" = the gate decides. Change it in the PR that changes the runtime.
   */
  gate: "unwired" | "shadow" | "enforced";
  units: readonly UnitId[];
  dims?: readonly DimKey[];
  knobs?: Readonly<Record<string, Knob>>;
  /**
   * Advisory only (T4): the panel shows the monthly target. `runaway` is the per-day limit the stage's
   * runtime will trip on; nothing meters or trips on it yet, so the panel doesn't show it.
   */
  budget?: { targetUsdPerMonth?: number; runaway?: { unit: UnitId | "usd"; perDay: number } };
  /** S2/C6: the period cadence.ts checks for a missed tick. Every tick writes a ledger row, even when off. */
  expect?: { everyMin: number; graceMin: number };
  heartbeat?: "healthchecks:ingest";
  /** Defaults to "safe-direction". */
  agent?: AgentRule;
}

export interface PolicyDef {
  label: string;
  /** Settable modes, safest first. */
  modes: readonly PolicyMode[];
  /** Registry default for a missing row; equals the slice-1 seed for the entries present at adoption. */
  initial: PolicyMode;
  readBy: readonly StageId[];
  /** Health checks: report "skipped (stage off)" while the watched stage is off (C6). */
  watches?: StageId;
  knobs?: Readonly<Record<string, Knob>>;
  /** Defaults to "safe-direction". Applies to the policy's mode AND its knobs. */
  agent?: AgentRule;
}

export interface GlobalDef {
  label: string;
  modes: readonly GlobalMode[];
  initial: GlobalMode;
  agent: AgentRule;
}

/**
 * The "all off" master switch: every stage's and policy's effective mode is capped by it (§5.1). An agent
 * may stop any single spending stage on its own, but flipping EVERYTHING off (alerting and the watchdog
 * heartbeat's driver included) is an owner call — hence "approval", in both directions.
 * Stop by stop, an agent can still reach all-off with every health check skipped (C6), so (owner,
 * 2026-10-12) each agent stop still applies at once, keeping the brake fast, but must notify the owner.
 * Nothing notifies yet: that is built with the notification/observer slice.
 */
export const globalSwitch: GlobalDef = {
  label: "Master switch",
  modes: ["off", "on"],
  initial: "on",
  agent: "approval",
};

// Crons, platform ids and knob values here copy their runtimes, which this pure package can't import. Sync
// tests in those sources (control-registry.test.ts) pin SOME of them, so a change on one side fails there:
//   - apps/scrapers: the ingest and discover crons (through the Worker's own dispatch),
//     ingest.boardsPerTick's default, min and max, the discover knobs' defaults, and (against
//     wrangler.toml's vars) the close / stale_sweep / prune initial modes and stale_sweep.ttlDays's default;
//   - packages/inngest: each Inngest stage's platformId and the cron its served function registers;
//   - packages/db (for the health.* policies below): the check ids, threshold defaults and env var names.
// NOT pinned, so keep them in step by hand: live_integration's and backup's crons (.github/workflows/
// live-integration.yml and backup.yml), the discover knobs' min/max, every `expect` period (change it with
// its cron), embed.pagesPerRun, digest.topK and alerts.cooldownH. (embed.tokensPerRun and
// digest.maxRecipientsPerRun have no runtime counterpart yet.)
export const stages = {
  ingest: {
    label: "Ingest job boards",
    runtime: "cf:opusfinder-scrapers",
    trigger: { cron: "0 */2 * * *" },
    // Shadow not offered: a fetch-without-writing tick still costs the full Neon time (§5.2).
    modes: ["off", "on"],
    initial: "on",
    gate: "shadow",
    units: [
      "cf.wall_ms",
      "cf.subrequests",
      "neon.awake_s",
      "ingest.boards",
      "ingest.boards_failed",
      "ingest.boards_rate_limited",
      "ingest.jobs_changed",
    ],
    dims: ["source"],
    knobs: {
      // default = the Worker's fallback and wrangler.toml's INGEST_LIMIT; max = its MAX_INGEST_LIMIT clamp.
      boardsPerTick: {
        label: "Boards per tick",
        default: 250,
        min: 1,
        max: 500,
        riskier: "up",
        int: true,
        legacyEnv: "INGEST_LIMIT",
      },
    },
    budget: { targetUsdPerMonth: 10 }, // Neon compute dominates (Sep: $8.42)
    // The healthchecks.io watchdog's settings (README "Deploying a schedule change"): period 2 h, grace
    // ~1 h, which covers a tick's run time plus jitter yet flags one missed tick within ~3 h.
    expect: { everyMin: 120, graceMin: 60 },
    heartbeat: "healthchecks:ingest",
  },
  discover: {
    label: "Discover new boards",
    runtime: "cf:opusfinder-scrapers",
    trigger: { cron: "0 3 * * SUN" },
    modes: ["off", "on"],
    initial: "on",
    gate: "shadow",
    units: ["cf.wall_ms", "cf.subrequests", "neon.awake_s"],
    dims: ["lane"],
    knobs: {
      limit: {
        label: "Seed slugs per run",
        default: 400,
        min: 0,
        max: 400,
        riskier: "up",
        int: true,
      },
      reprobeLimit: {
        label: "Re-probes per run",
        default: 500,
        min: 0,
        max: 500,
        riskier: "up",
        int: true,
      },
    },
    expect: { everyMin: 7 * 24 * 60, graceMin: 6 * 60 },
  },
  embed: {
    label: "Embed new and changed jobs",
    runtime: "inngest:opusfinder",
    platformId: "embed-backlog-drain",
    trigger: { cron: "10 10 * * *" }, // 10 min after the 10:00 ingest tick, ahead of the 12:10 digest
    modes: ["off", "shadow", "on"],
    shadowMeans: "count the backlog and estimate tokens; no Voyage calls",
    initial: "off",
    gate: "unwired",
    units: ["voyage.tokens", "neon.awake_s"],
    knobs: {
      // was MAX_PAGES_PER_RUN
      pagesPerRun: {
        label: "Pages per run",
        default: 200,
        min: 0,
        max: 200,
        riskier: "up",
        int: true,
      },
      tokensPerRun: {
        label: "Tokens per run",
        default: 10_000_000,
        min: 0,
        max: 30_000_000,
        riskier: "up",
        int: true,
        unit: "tokens",
      },
    },
    budget: { targetUsdPerMonth: 15, runaway: { unit: "voyage.tokens", perDay: 12_000_000 } },
    expect: { everyMin: 24 * 60, graceMin: 120 },
  },
  alerts: {
    label: "Health alerts",
    runtime: "inngest:opusfinder",
    platformId: "health-check-alert",
    trigger: { cron: "10 */2 * * *" }, // 10 min after each ingest tick starts, while Neon is awake
    // Shadow not offered: per-check shadow already exists at the policy level (§5.2).
    modes: ["off", "on"],
    initial: "off",
    gate: "unwired",
    units: ["resend.emails", "neon.awake_s"],
    // Turning alerting off is how an outage goes unseen, so — like the health checks — every agent move
    // here, the cooldown knob included, needs the owner (decision 2026-10-04).
    agent: "approval",
    knobs: {
      // A SHORTER cooldown re-pages sooner: more emails against Resend's 100/day free quota. Riskier DOWN.
      cooldownH: {
        label: "Alert cooldown",
        default: 24,
        min: 1,
        max: 168,
        riskier: "down",
        int: true,
        unit: "h",
        legacyEnv: "HEALTH_ALERT_COOLDOWN_H",
      },
    },
    expect: { everyMin: 120, graceMin: 60 }, // the ingest tick's period and grace, which it rides
  },
  digest: {
    label: "User digests",
    runtime: "inngest:opusfinder",
    platformId: "digest-cadence", // + digest-orchestrator, digest-user (event-driven)
    trigger: { cron: "10 12 * * *" }, // 10 min after the 12:00 ingest tick (8:10am EDT)
    modes: ["off", "shadow", "on"],
    shadowMeans: "resolve eligible users and retrieve candidates; no LLM, no email",
    initial: "off",
    gate: "unwired",
    units: [
      "anthropic.haiku.in",
      "anthropic.haiku.out",
      "anthropic.haiku.cache_write",
      "anthropic.haiku.cache_read",
      "anthropic.sonnet.batch.in",
      "anthropic.sonnet.batch.out",
      "resend.emails",
      "neon.awake_s",
    ],
    knobs: {
      topK: { label: "Jobs per digest", default: 12, min: 1, max: 20, riskier: "up", int: true },
      maxRecipientsPerRun: {
        label: "Recipients per run",
        default: 10,
        min: 0,
        max: 1000,
        riskier: "up",
        int: true,
      },
    },
    budget: { targetUsdPerMonth: 15, runaway: { unit: "usd", perDay: 3 } },
    expect: { everyMin: 24 * 60, graceMin: 120 },
  },
  live_integration: {
    label: "Nightly live-integration tests",
    runtime: "gh:live-integration.yml",
    trigger: { cron: "0 7 * * *" },
    modes: ["off", "on"],
    initial: "off",
    gate: "unwired",
    units: ["gh.minutes", "voyage.tokens", "neon.awake_s"],
    expect: { everyMin: 24 * 60, graceMin: 180 }, // GitHub schedules can be delayed or dropped
  },
  backup: {
    // pg_dump of the user tables to R2 (packages/db/src/backup.ts), as the read-only user_backup role.
    label: "Nightly user-table backup",
    runtime: "gh:backup.yml",
    trigger: { cron: "5 4 * * *" },
    modes: ["off", "on"],
    initial: "off",
    gate: "unwired",
    units: ["gh.minutes", "neon.awake_s", "r2.bytes"],
    expect: { everyMin: 24 * 60, graceMin: 120 }, // health.backup_staleness's 26 h default
  },
  cv_ingest: {
    label: "CV ingestion",
    runtime: "cli",
    trigger: { manual: true },
    modes: ["off", "on"],
    initial: "on",
    gate: "unwired",
    units: ["anthropic.haiku.in", "anthropic.haiku.out", "r2.bytes"],
  },
} as const satisfies Record<string, StageDef>;
export type StageId = keyof typeof stages;

/**
 * A health-check policy. `agent: "approval"` is the owner's 2026-10-04 rule ("ANY change by an agent to
 * a health check needs owner approval, quieter or louder"), declared on the entry so classify() stays
 * generic. It covers the check's mode and its threshold knob. Threshold `riskier: "up"` = a looser
 * threshold, kept for the panel's ordering even though every agent move is a proposal here anyway.
 */
const healthCheck = (label: string, watches: StageId, threshold?: Knob): PolicyDef => ({
  label,
  modes: ["off", "shadow", "enforce"],
  initial: "shadow",
  readBy: ["alerts"],
  watches,
  agent: "approval",
  ...(threshold ? { knobs: { threshold } } : {}),
});

export const policies = {
  close: {
    // Arms A/B/C: the job left its board's feed (ingest), its board died (discover), or a digest's
    // pre-send probe got a 410.
    label: "Close removed jobs",
    modes: ["shadow", "enforce"],
    initial: "enforce",
    readBy: ["ingest", "discover", "digest"], // one row → the atomic both-runtimes flip is automatic
  },
  stale_sweep: {
    label: "Close stale jobs",
    modes: ["shadow", "enforce"],
    initial: "enforce",
    readBy: ["ingest"],
    knobs: {
      // A SHORTER TTL closes more, so riskier is DOWN.
      ttlDays: {
        label: "Close when unseen for",
        default: 21,
        min: 7,
        max: 90,
        riskier: "down",
        int: true,
        unit: "d",
        legacyEnv: "STALE_SWEEP_TTL_DAYS",
      },
    },
  },
  prune: {
    // The weekly delete of jobs closed for 30+ days that no digest showed (the scrapers Worker's PRUNE var).
    label: "Delete old closed jobs",
    modes: ["shadow", "enforce"],
    initial: "enforce",
    readBy: ["discover"],
  },
  // The 9 health checks. Ids are `health.<HealthCheckId>` (packages/db/src/health.ts); a sync test in
  // @opusfinder/db pins the two lists, each threshold default and its env var together. A later slice
  // moves HealthCheckId HERE and has db/health import it — never the reverse (the H1 landmine: db/health
  // reads `process`).
  "health.ingestion_staleness": healthCheck("Ingestion staleness", "ingest", {
    label: "Max ingestion age",
    default: 5, // 2.5× the 2-hourly cron period: one missed tick is tolerated, two fire
    min: 3, // one 2-hourly period plus a tick's run time and jitter; lower, and healthy gaps fire
    max: 24,
    riskier: "up",
    int: true,
    unit: "h",
    legacyEnv: "HEALTH_INGEST_MAX_AGE_H",
  }),
  "health.board_fail_ratio": healthCheck("Board failures", "ingest", {
    label: "Max failed-board ratio",
    default: 0.5,
    min: 0.05,
    max: 1,
    riskier: "up",
    legacyEnv: "HEALTH_FAIL_RATIO",
  }),
  // Share of postings on hydrating boards (today only SmartRecruiters) whose detail fetch failed, so their
  // stored content went stale.
  "health.hydrate_skip_ratio": healthCheck("Job detail failures", "ingest", {
    label: "Max failed-detail ratio",
    default: 0.2,
    min: 0.05,
    max: 1,
    riskier: "up",
    legacyEnv: "HEALTH_HYDRATE_SKIP_RATIO",
  }),
  "health.discovery_window": healthCheck("Discovery staleness", "discover", {
    label: "Max discovery age",
    default: 13,
    min: 7,
    max: 30,
    riskier: "up",
    int: true,
    unit: "d",
    legacyEnv: "HEALTH_DISCOVERY_MAX_AGE_D",
  }),
  "health.discovery_lane_errors": healthCheck("Discovery lane errors", "discover"),
  "health.embedding_backlog": healthCheck("Embedding backlog", "embed", {
    label: "Max unembedded jobs",
    default: 2000,
    min: 0,
    max: 200_000,
    riskier: "up",
    int: true,
    legacyEnv: "HEALTH_BACKLOG_MAX",
  }),
  "health.digest_health": healthCheck("Digest errors", "digest"),
  "health.bounce_suppression": healthCheck("Email bounces", "digest"),
  "health.backup_staleness": healthCheck("Backup staleness", "backup", {
    label: "Max backup age",
    default: 26, // the nightly period plus 2 h for a late GitHub schedule: one missed night fires
    min: 25,
    max: 168,
    riskier: "up",
    int: true,
    unit: "h",
    legacyEnv: "HEALTH_BACKUP_MAX_AGE_H",
  }),
} as const satisfies Record<string, PolicyDef>;
export type PolicyId = keyof typeof policies;

/** B3: vendor ceilings, shown in the view. Probed where a read-only credential exists, else by hand. */
export const ceilings = {
  // Owner decision 2026-10-26: 2 CU, not 8, so a runaway compute costs at most ~$5/day, not ~$20.
  neonMaxCu: { label: "Neon max compute (CU)", value: 2, where: "Neon console", probe: "manual" },
  voyageAutoRecharge: {
    label: "Voyage auto-recharge",
    value: "unknown",
    where: "Voyage dashboard",
    probe: "manual",
  },
  // Owner decision 2026-10-10: the product's LLM calls go through OpenRouter (prepaid credits).
  openrouterCredits: {
    label: "OpenRouter credit limit",
    value: "unknown",
    where: "OpenRouter > Settings > Credits (auto top-up) and per-key credit limits",
    probe: "manual",
  },
} as const;

/** Advisory, not a cap (T4). */
export const totalTargetUsdPerMonth = 50;

/** Owner decision 2026-10-04: an unapproved proposal lapses after 7 days. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The only reasons a runtime may trip a stage off (§7.3, §11.1). */
export const TRIP_REASONS = ["runaway", "error-storm"] as const;
export type TripReason = (typeof TRIP_REASONS)[number];

/** Ledger outcomes. `skipped` covers "skipped: off" and "skipped: control-unreachable" (detail says which). */
export const RUN_OUTCOMES = ["ok", "error", "partial", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

// ---- Typed accessors (the `as const` literals above are precise; these widen to the def interfaces). ----

export const STAGE_IDS = Object.keys(stages) as StageId[];
export const POLICY_IDS = Object.keys(policies) as PolicyId[];

export function isStageId(id: string): id is StageId {
  return Object.hasOwn(stages, id);
}
export function isPolicyId(id: string): id is PolicyId {
  return Object.hasOwn(policies, id);
}
export function stageDef(id: StageId): StageDef {
  return stages[id];
}
export function policyDef(id: PolicyId): PolicyDef {
  return policies[id];
}
