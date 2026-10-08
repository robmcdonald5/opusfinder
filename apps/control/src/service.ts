import {
  DIMENSIONS,
  INHERIT,
  PROPOSAL_TTL_MS,
  RUN_OUTCOMES,
  TRIP_REASONS,
  classify,
  desiredValue,
  formatTarget,
  gateView,
  isStageId,
  normalizeReason,
  parseTarget,
  parseValue,
  stageDef,
  stateViews,
  type Classification,
  type DimKey,
  type GateAnswer,
  type StateMap,
  type Target,
} from "@opusfinder/control";

import type { Caller } from "./auth";
import {
  actorLabel,
  applyChange,
  closeProposal,
  fileProposal,
  getProposal,
  insertRun,
  listProposals,
  readGate,
  readState,
  readStatus,
  type ChangeRow,
  type Channel,
  type LedgerRow,
  type ProposalRow,
} from "./store";

/**
 * The control plane's operations — shared by the JSON API, the page's forms and the RPC entrypoint, so
 * every surface enforces the same rules. Callers arrive already identified (auth.ts / the RPC entrypoint);
 * route-level role lists in index.ts are the first gate, the checks here are the second, and classify()
 * decides every desired-state change.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const RECENT_CHANGES = 30;
const DETAIL_MAX = 500;
/** A trip or a ledger write must not be lost to a concurrent change: re-read and retry this many times. */
const TRIP_ATTEMPTS = 3;
/** The longest run a ledger row may describe. Longer = a unit bug (e.g. seconds sent as ms·1000). */
const MAX_RUN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function requireRole(caller: Caller, ...roles: Caller["role"][]): void {
  if (!roles.includes(caller.role)) {
    throw new ApiError(403, "forbidden", `the ${caller.role} role can't do this`);
  }
}

/** One field of a request body (undefined when the body isn't an object). Shared with index.ts. */
export function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function parsedTarget(raw: unknown): Target {
  if (typeof raw !== "string") throw new ApiError(400, "invalid_target", "target is required");
  const t = parseTarget(raw);
  if (!t.ok) throw new ApiError(400, "invalid_target", t.error);
  return t.value;
}

function parsedValue(target: Target, raw: unknown): string | null {
  // Numbers are accepted for knobs as a convenience for JSON callers.
  const s = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof s !== "string") throw new ApiError(400, "invalid_value", "value is required");
  const v = parseValue(target, s);
  if (!v.ok) throw new ApiError(400, "invalid_value", v.error);
  return v.value;
}

function parsedReason(raw: unknown): string {
  const r = normalizeReason(raw);
  if (!r.ok) throw new ApiError(400, "invalid_reason", r.error);
  return r.value;
}

/** First line only, capped — the same shape-safety rule as the scrapers Worker's /fail ping. */
function oneLine(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ApiError(400, "invalid_detail", "detail must be a string");
  const line = (raw.split(/\r?\n/)[0] ?? "").trim().slice(0, max);
  return line.length > 0 ? line : null;
}

// ---------- reads ----------

export type ProposalView = Omit<ProposalRow, "status"> & {
  /** "expired" = still 'open' in the table but past expires_at (computed at read time; no sweeper). */
  status: ProposalRow["status"] | "expired";
  proposer: string;
};

/** An open proposal as the status read shows it: plus whether approving it now would be refused. */
export type OpenProposalView = ProposalView & {
  /** The target's desired value right now (null = no override). */
  current: string | null;
  /** True when `current` is no longer the value the proposal was made from: approve will refuse it. */
  stale: boolean;
};

function proposalView(row: ProposalRow, now: string): ProposalView {
  const expired = row.status === "open" && row.expires_at <= now;
  return {
    ...row,
    status: expired ? "expired" : row.status,
    proposer: `${row.proposer_role}:${row.proposer_name}`,
  };
}

function ledgerView(row: LedgerRow) {
  let units: unknown;
  try {
    units = JSON.parse(row.units);
  } catch {
    units = {};
  }
  return { ...row, units };
}

/** The target's desired value now, or undefined when the address no longer parses (registry changed). */
function currentValue(state: StateMap, address: string): string | null | undefined {
  const t = parseTarget(address);
  return t.ok ? desiredValue(state, t.value) : undefined;
}

export async function status(db: D1Database, caller: Caller, now: string) {
  const s = await readStatus(db, now, RECENT_CHANGES);
  const views = stateViews(s.state);
  const lastRun = new Map(s.lastRuns.map((r) => [r.stage, ledgerView(r)]));
  return {
    generatedAt: now,
    caller,
    global: views.global,
    stages: views.stages.map((v) => ({ ...v, lastRun: lastRun.get(v.id) ?? null })),
    policies: views.policies,
    openProposals: s.proposals.map((p): OpenProposalView => {
      const current = currentValue(s.state, p.target);
      return {
        ...proposalView(p, now),
        current: current ?? null,
        stale: current === undefined || current !== p.from_value,
      };
    }),
    closedProposals: s.closedProposals.map((p) => proposalView(p, now)),
    recentChanges: s.changes,
  };
}

export type StatusView = Awaited<ReturnType<typeof status>>;

// Every dimension the registry declares is a gate parameter: adding one to DIMENSIONS is enough.
const DIM_PARAMS = Object.keys(DIMENSIONS) as DimKey[];

export async function gate(
  db: D1Database,
  stage: string,
  dims: Partial<Record<string, string>>,
): Promise<GateAnswer> {
  if (!isStageId(stage)) throw new ApiError(404, "unknown_stage", `unknown stage "${stage}"`);
  const narrowed: Partial<Record<DimKey, string>> = {};
  for (const d of DIM_PARAMS) {
    const v = dims[d];
    if (typeof v === "string" && v.length > 0) narrowed[d] = v;
  }
  const { state, last } = await readGate(db, stage);
  return {
    ...gateView(state, stage, narrowed),
    since: last?.at ?? null,
    by: last ? `${last.actor_role}:${last.actor_name}` : null,
    because: last?.reason ?? null,
  };
}

// ---------- changes ----------

export type ChangeOutcome =
  | {
      result: "applied";
      target: string;
      from: string | null;
      to: string | null;
      changeId: number;
      decision: Classification;
    }
  | { result: "noop"; target: string; value: string | null }
  | {
      result: "dry_run";
      target: string;
      from: string | null;
      to: string | null;
      decision: Classification;
    }
  | { result: "proposed"; proposal: ProposalView; duplicate: boolean; decision: Classification };

/**
 * Apply a desired-state change if classify() lets this caller's role apply it; otherwise refuse with a
 * pointer to the proposal route — or, with `proposeIfNeeded`, file the proposal in the same call (the
 * one-shot form an unattended agent wants: one request, one deterministic outcome).
 */
export async function requestChange(
  db: D1Database,
  caller: Caller,
  body: unknown,
  channel: Channel,
  now: string,
): Promise<ChangeOutcome> {
  const target = parsedTarget(field(body, "target"));
  const to = parsedValue(target, field(body, "value"));
  const reason = parsedReason(field(body, "reason"));
  const address = formatTarget(target);

  const state = await readState(db);
  const expected = state.get(address) ?? null;
  const from = desiredValue(state, target);
  // Nothing to write when the store already says this (or holds no row and the default already is it).
  if (to === expected || (expected === null && to === from))
    return { result: "noop", target: address, value: to };

  const decision = classify({ kind: "set", target, from, to }, caller.role);
  if (field(body, "dryRun") === true)
    return { result: "dry_run", target: address, from, to, decision };

  if (decision.outcome === "deny")
    throw new ApiError(403, "forbidden", decision.rule, { decision });
  if (decision.outcome === "propose") {
    if (field(body, "proposeIfNeeded") === true) {
      const filed = await fileProposal(db, {
        proposer: caller,
        target: address,
        from,
        to,
        reason,
        now,
        expiresAt: new Date(Date.parse(now) + PROPOSAL_TTL_MS).toISOString(),
      });
      return {
        result: "proposed",
        proposal: proposalView(filed.proposal, now),
        duplicate: filed.duplicate,
        decision,
      };
    }
    throw new ApiError(403, "needs_approval", `${decision.rule}; file a proposal for the owner`, {
      decision,
      propose: {
        method: "POST",
        path: "/v1/proposals",
        body: { target: address, value: to ?? INHERIT, reason },
      },
    });
  }

  const res = await applyChange(db, {
    target: address,
    expected,
    from,
    to,
    actor: caller,
    channel,
    reason,
    now,
  });
  if (!res.applied) {
    throw new ApiError(
      409,
      "conflict",
      `${address} changed while this request was in flight; re-read and retry`,
    );
  }
  return { result: "applied", target: address, from, to, changeId: res.changeId, decision };
}

// ---------- proposals ----------

export async function propose(db: D1Database, caller: Caller, body: unknown, now: string) {
  requireRole(caller, "owner", "agent");
  const target = parsedTarget(field(body, "target"));
  const to = parsedValue(target, field(body, "value"));
  const reason = parsedReason(field(body, "reason"));
  const address = formatTarget(target);
  const state = await readState(db);
  const from = desiredValue(state, target);
  if (to === from) {
    throw new ApiError(
      409,
      "no_change",
      `${address} is already ${to ?? INHERIT}; nothing to propose`,
    );
  }
  const filed = await fileProposal(db, {
    proposer: caller,
    target: address,
    from,
    to,
    reason,
    now,
    expiresAt: new Date(Date.parse(now) + PROPOSAL_TTL_MS).toISOString(),
  });
  return { proposal: proposalView(filed.proposal, now), duplicate: filed.duplicate };
}

export async function proposals(db: D1Database, which: string | null, now: string) {
  if (which !== null && which !== "open" && which !== "all") {
    throw new ApiError(400, "invalid_status", 'status must be "open" or "all"');
  }
  return (await listProposals(db, which === "all" ? "all" : "open", now)).map((p) =>
    proposalView(p, now),
  );
}

export async function proposal(db: D1Database, id: number, now: string): Promise<ProposalView> {
  const row = await getProposal(db, id);
  if (!row) throw new ApiError(404, "not_found", `no proposal #${id}`);
  return proposalView(row, now);
}

async function openProposal(db: D1Database, id: number, now: string): Promise<ProposalRow> {
  const view = await proposal(db, id, now);
  if (view.status === "expired")
    throw new ApiError(409, "expired", `proposal #${id} expired at ${view.expires_at}`);
  if (view.status !== "open")
    throw new ApiError(409, "not_open", `proposal #${id} is already ${view.status}`);
  return { ...view, status: "open" };
}

/**
 * Owner approval: apply the proposed change and close the proposal in ONE batch (store.applyChange).
 *
 * Refused as STALE when the target has moved off the value the proposal was made from — the owner would
 * be approving "off → on" against a store that now says "shadow" (or already says "on"). The proposal is
 * closed as 'stale' with the reason, nothing is applied or logged as a change, and the proposer can file
 * a fresh one against the current value.
 */
export async function approve(
  db: D1Database,
  caller: Caller,
  id: number,
  note: string | null,
  channel: Channel,
  now: string,
) {
  requireRole(caller, "owner");
  const p = await openProposal(db, id, now);
  // Re-validate against TODAY's registry: a deploy since filing may have removed the target or the value.
  const t = parseTarget(p.target);
  if (!t.ok)
    throw new ApiError(
      409,
      "invalid_now",
      `proposal #${id} no longer names a valid target: ${t.error}`,
    );
  const v = parseValue(t.value, p.to_value ?? INHERIT);
  if (!v.ok)
    throw new ApiError(
      409,
      "invalid_now",
      `proposal #${id} no longer holds a valid value: ${v.error}`,
    );

  const state = await readState(db);
  const expected = state.get(p.target) ?? null;
  const from = desiredValue(state, t.value);
  const decidedBy = actorLabel(caller);
  if (from !== p.from_value || v.value === from) {
    const why =
      `stale: ${p.target} is now ${from ?? INHERIT}, proposed from ${p.from_value ?? INHERIT}; ` +
      `nothing applied`;
    if (!(await closeProposal(db, id, "stale", decidedBy, why, now))) {
      throw new ApiError(
        409,
        "conflict",
        `proposal #${id} changed while approving; re-read and retry`,
      );
    }
    throw new ApiError(409, "stale_proposal", `proposal #${id} is ${why}`, {
      proposal: await proposal(db, id, now),
    });
  }
  const res = await applyChange(db, {
    target: p.target,
    expected,
    from,
    to: v.value,
    actor: caller,
    channel,
    reason: p.reason,
    now,
    proposal: { id, decidedBy, note },
  });
  if (!res.applied) {
    throw new ApiError(
      409,
      "conflict",
      `proposal #${id} or ${p.target} changed while approving; re-read and retry`,
    );
  }
  return {
    result: "applied" as const,
    changeId: res.changeId,
    from,
    to: v.value,
    proposal: await proposal(db, id, now),
  };
}

export async function reject(
  db: D1Database,
  caller: Caller,
  id: number,
  note: string | null,
  now: string,
) {
  requireRole(caller, "owner");
  await openProposal(db, id, now);
  if (!(await closeProposal(db, id, "rejected", actorLabel(caller), note, now))) {
    throw new ApiError(
      409,
      "conflict",
      `proposal #${id} changed while rejecting; re-read and retry`,
    );
  }
  return proposal(db, id, now);
}

/** A proposer takes back its own proposal. Only the identity that filed it may (same role + name). */
export async function withdraw(db: D1Database, caller: Caller, id: number, now: string) {
  requireRole(caller, "owner", "agent");
  const p = await openProposal(db, id, now);
  if (p.proposer_role !== caller.role || p.proposer_name !== caller.name) {
    throw new ApiError(
      403,
      "not_proposer",
      `only ${p.proposer_role}:${p.proposer_name} can withdraw proposal #${id}`,
    );
  }
  if (!(await closeProposal(db, id, "withdrawn", actorLabel(caller), null, now))) {
    throw new ApiError(
      409,
      "conflict",
      `proposal #${id} changed while withdrawing; re-read and retry`,
    );
  }
  return proposal(db, id, now);
}

export function proposalNote(raw: unknown): string | null {
  return oneLine(raw, 300);
}

// ---------- runtime: ledger + trip ----------

function isoTime(raw: unknown, name: string, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw new ApiError(400, "invalid_run", `${name} is required (ISO-8601)`);
    return null;
  }
  const ms = typeof raw === "string" && raw.length <= 40 ? Date.parse(raw) : Number.NaN;
  // Years 2000–9999: Date#toISOString() of anything outside a 4-digit year isn't the sortable shape
  // every other timestamp in the store has.
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms >= Date.UTC(10000, 0, 1))
    throw new ApiError(400, "invalid_run", `${name} must be an ISO-8601 time`);
  return new Date(ms).toISOString();
}

/** One ledger row per run (B1). Runtime-only. Units must be ones the stage declares (registry). */
export async function recordRun(db: D1Database, caller: Caller, body: unknown, now: string) {
  requireRole(caller, "runtime");
  const stage = field(body, "stage");
  if (typeof stage !== "string" || !isStageId(stage)) {
    throw new ApiError(400, "invalid_run", "stage must be a registry stage id");
  }
  const outcome = field(body, "outcome");
  if (typeof outcome !== "string" || !(RUN_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new ApiError(400, "invalid_run", `outcome must be one of: ${RUN_OUTCOMES.join(", ")}`);
  }
  const gateMode = field(body, "gateMode") ?? null;
  if (gateMode !== null && !(stageDef(stage).modes as readonly unknown[]).includes(gateMode)) {
    throw new ApiError(
      400,
      "invalid_run",
      `gateMode must be one of: ${stageDef(stage).modes.join(", ")}`,
    );
  }
  // Bounded so a unit bug is a 400 the runtime sees, never a 500 from the INTEGER column.
  const durationRaw = field(body, "durationMs") ?? null;
  if (
    durationRaw !== null &&
    !(
      Number.isInteger(durationRaw) &&
      (durationRaw as number) >= 0 &&
      (durationRaw as number) <= MAX_RUN_DURATION_MS
    )
  ) {
    throw new ApiError(
      400,
      "invalid_run",
      `durationMs must be a whole number from 0 to ${MAX_RUN_DURATION_MS} (7 days)`,
    );
  }
  const unitsRaw = field(body, "units") ?? {};
  if (typeof unitsRaw !== "object" || unitsRaw === null || Array.isArray(unitsRaw)) {
    throw new ApiError(400, "invalid_run", "units must be an object of unit → number");
  }
  const allowed: readonly string[] = stageDef(stage).units;
  const units: Record<string, number> = {};
  for (const [unit, n] of Object.entries(unitsRaw)) {
    if (!allowed.includes(unit)) {
      throw new ApiError(
        400,
        "invalid_run",
        `${stage} doesn't record "${unit}" (records: ${allowed.join(", ")})`,
      );
    }
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      throw new ApiError(
        400,
        "invalid_run",
        `units.${unit} must be a number from 0 to ${Number.MAX_SAFE_INTEGER}`,
      );
    }
    units[unit] = n;
  }
  const startedAt = isoTime(field(body, "startedAt"), "startedAt", true) as string;
  const finishedAt = isoTime(field(body, "finishedAt"), "finishedAt", false);
  if (finishedAt !== null && finishedAt < startedAt) {
    throw new ApiError(400, "invalid_run", "finishedAt is before startedAt");
  }
  const id = await insertRun(db, {
    stage,
    startedAt,
    finishedAt,
    durationMs: durationRaw as number | null,
    outcome,
    gateMode: gateMode as string | null,
    units,
    detail: oneLine(field(body, "detail"), DETAIL_MAX),
    recordedAt: now,
    recordedBy: actorLabel(caller),
  });
  return { id };
}

/**
 * The runtime's one write (§7.3): turn its stage OFF on a runaway or an error storm. It can only ever set
 * off (classify enforces that), so a leaked runtime credential's worst case is an outage, never spend.
 * Retries a lost compare-and-set race: a guard firing must not be dropped because something else wrote.
 */
export async function trip(
  db: D1Database,
  caller: Caller,
  body: unknown,
  channel: Channel,
  now: string,
) {
  requireRole(caller, "runtime");
  const stage = field(body, "stage");
  if (typeof stage !== "string" || !isStageId(stage))
    throw new ApiError(400, "invalid_trip", "stage must be a registry stage id");
  const why = field(body, "reason");
  if (typeof why !== "string" || !(TRIP_REASONS as readonly string[]).includes(why)) {
    throw new ApiError(400, "invalid_trip", `reason must be one of: ${TRIP_REASONS.join(", ")}`);
  }
  const detail = oneLine(field(body, "detail"), 200);
  const reason = parsedReason(`trip: ${why}${detail ? ` — ${detail}` : ""}`);
  const target: Target = { kind: "mode", entry: { type: "stage", id: stage } };

  for (let attempt = 1; attempt <= TRIP_ATTEMPTS; attempt++) {
    const state = await readState(db);
    const expected = state.get(stage) ?? null;
    const from = desiredValue(state, target);
    if (expected === "off" || (expected === null && from === "off"))
      return { result: "noop" as const, stage, mode: "off" };
    const decision = classify({ kind: "set", target, from, to: "off" }, caller.role);
    if (decision.outcome !== "apply")
      throw new ApiError(403, "forbidden", decision.rule, { decision });
    const res = await applyChange(db, {
      target: stage,
      expected,
      from,
      to: "off",
      actor: caller,
      channel,
      reason,
      now,
    });
    if (res.applied) return { result: "tripped" as const, stage, from, changeId: res.changeId };
  }
  throw new ApiError(
    409,
    "conflict",
    `${stage} kept changing; trip not recorded after ${TRIP_ATTEMPTS} attempts`,
  );
}

export type { ChangeRow };
