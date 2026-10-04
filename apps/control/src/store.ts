import type { StateMap } from "@opusfinder/control";

import type { Caller } from "./auth";

/**
 * D1 access — the ONLY module that writes SQL. Every desired-state write goes through {@link applyChange},
 * which puts the `state` write and its `change_log` row in ONE `db.batch()` (a single D1 transaction:
 * all statements commit or none do — C3: no unlogged change, no log row for a change that didn't land).
 *
 * Both statements are also CONDITIONAL on the state row still holding the value the caller classified
 * against (compare-and-set). Without it, a race could turn a "safe" agent move into an unsafe one: an
 * agent classifies embed on→shadow (down, allowed) while a runtime trips embed to off; if the agent's
 * write landed second it would move embed off→shadow — UP — with no approval. With the predicate, the
 * late write matches nothing, both statements no-op together, and the caller gets a conflict to retry.
 */

export type Channel = "panel" | "api" | "cli" | "rpc";

export interface ChangeRow {
  id: number;
  at: string;
  actor_role: string;
  actor_name: string;
  target: string;
  from_value: string | null;
  to_value: string | null;
  reason: string;
  channel: string;
  proposal_id: number | null;
  /** From the proposal, when the change came from an approval: "<role>:<name>". */
  proposed_by: string | null;
}

export interface ProposalRow {
  id: number;
  created_at: string;
  expires_at: string;
  proposer_role: string;
  proposer_name: string;
  target: string;
  from_value: string | null;
  to_value: string | null;
  reason: string;
  /** "stale": closed unapplied because the target moved off the value it was proposed from. */
  status: "open" | "approved" | "rejected" | "withdrawn" | "stale";
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

export interface LedgerRow {
  id: number;
  stage: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  outcome: string;
  gate_mode: string | null;
  units: string;
  detail: string | null;
  recorded_at: string;
  recorded_by: string;
}

const CHANGE_SELECT = `SELECT c.id, c.at, c.actor_role, c.actor_name, c.target, c.from_value, c.to_value,
  c.reason, c.channel, c.proposal_id,
  CASE WHEN p.id IS NULL THEN NULL ELSE p.proposer_role || ':' || p.proposer_name END AS proposed_by
  FROM change_log c LEFT JOIN proposal p ON p.id = c.proposal_id`;

export function actorLabel(caller: Caller): string {
  return `${caller.role}:${caller.name}`;
}

export async function readState(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT key, value FROM state")
    .all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

/** Everything /v1/status needs, in one round trip (one batch = one consistent snapshot). */
export async function readStatus(
  db: D1Database,
  now: string,
  changeLimit: number,
): Promise<{
  state: StateMap;
  changes: ChangeRow[];
  proposals: ProposalRow[];
  /** The latest proposals that are no longer open (decided, stale or lapsed), newest first. */
  closedProposals: ProposalRow[];
  lastRuns: LedgerRow[];
}> {
  const [state, changes, proposals, closed, runs] = await db.batch([
    db.prepare("SELECT key, value FROM state"),
    db.prepare(`${CHANGE_SELECT} ORDER BY c.id DESC LIMIT ?`).bind(changeLimit),
    db
      .prepare(
        "SELECT * FROM proposal WHERE status = 'open' AND expires_at > ? ORDER BY id DESC LIMIT 100",
      )
      .bind(now),
    db
      .prepare(
        "SELECT * FROM proposal WHERE status <> 'open' OR expires_at <= ? ORDER BY id DESC LIMIT 10",
      )
      .bind(now),
    db.prepare("SELECT * FROM ledger WHERE id IN (SELECT MAX(id) FROM ledger GROUP BY stage)"),
  ]);
  const rows = (state?.results ?? []) as { key: string; value: string }[];
  return {
    state: new Map(rows.map((r) => [r.key, r.value])),
    changes: (changes?.results ?? []) as ChangeRow[],
    proposals: (proposals?.results ?? []) as ProposalRow[],
    closedProposals: (closed?.results ?? []) as ProposalRow[],
    lastRuns: (runs?.results ?? []) as LedgerRow[],
  };
}

/**
 * What a gate answer needs — all state rows plus the latest change to the stage (S4's "since …, by …,
 * because …") — in ONE batch: one subrequest, and the two reads come from the same snapshot.
 */
export async function readGate(
  db: D1Database,
  stage: string,
): Promise<{ state: StateMap; last: ChangeRow | null }> {
  const [state, last] = await db.batch([
    db.prepare("SELECT key, value FROM state"),
    db.prepare(`${CHANGE_SELECT} WHERE c.target = ? ORDER BY c.id DESC LIMIT 1`).bind(stage),
  ]);
  const rows = (state?.results ?? []) as { key: string; value: string }[];
  return {
    state: new Map(rows.map((r) => [r.key, r.value])),
    last: ((last?.results ?? [])[0] as ChangeRow | undefined) ?? null,
  };
}

export interface ApplyInput {
  /** Canonical target address (the `state` key). */
  target: string;
  /** The RAW stored value the caller classified against (null = no row). The compare-and-set predicate. */
  expected: string | null;
  /** The resolved desired value before the change — what the change log shows as "from". */
  from: string | null;
  /** The new stored value; null deletes the row (clears a dimension override). */
  to: string | null;
  actor: Caller;
  channel: Channel;
  reason: string;
  now: string;
  /** Set when an owner approves a proposal: the batch also flips that proposal to 'approved', and the
   *  whole batch is additionally conditional on it still being open and unexpired. */
  proposal?: { id: number; decidedBy: string; note: string | null };
}

export type ApplyResult = { applied: true; changeId: number } | { applied: false };

export async function applyChange(db: D1Database, input: ApplyInput): Promise<ApplyResult> {
  const p = input.proposal;
  // The shared guard: the state still holds what was classified, and (approvals) the proposal is live.
  const guard = p
    ? `(SELECT value FROM state WHERE key = ?1) IS ?2 AND EXISTS (SELECT 1 FROM proposal WHERE id = ?3 AND status = 'open' AND expires_at > ?4)`
    : `(SELECT value FROM state WHERE key = ?1) IS ?2`;
  const guardArgs = p
    ? [input.target, input.expected, p.id, input.now]
    : [input.target, input.expected];
  const n = guardArgs.length; // next free positional parameter is ?(n+1)

  const statements: D1PreparedStatement[] = [
    // 1. The audit row — first, so it is evaluated against the PRE-change state.
    db
      .prepare(
        `INSERT INTO change_log (target, at, actor_role, actor_name, from_value, to_value, reason, channel, proposal_id)
         SELECT ?1, ?${n + 1}, ?${n + 2}, ?${n + 3}, ?${n + 4}, ?${n + 5}, ?${n + 6}, ?${n + 7}, ?${n + 8}
         WHERE ${guard}`,
      )
      .bind(
        ...guardArgs,
        input.now,
        input.actor.role,
        input.actor.name,
        input.from,
        input.to,
        input.reason,
        input.channel,
        p ? p.id : null,
      ),
    // 2. The state write, under the same guard (statement 1 doesn't touch state or proposal, so the guard
    //    reads the same pre-change values here: both statements fire, or neither does).
    input.to === null
      ? db.prepare(`DELETE FROM state WHERE key = ?1 AND ${guard}`).bind(...guardArgs)
      : db
          .prepare(
            `INSERT INTO state (key, value, updated_at, updated_by)
             SELECT ?1, ?${n + 1}, ?${n + 2}, ?${n + 3}
             WHERE ${guard}
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
               updated_by = excluded.updated_by`,
          )
          .bind(...guardArgs, input.to, input.now, actorLabel(input.actor)),
  ];
  if (p) {
    // 3. Close the proposal — only if THIS batch logged its change (the log row exists only when the
    //    guard held, and a proposal can be approved once: status is still 'open' here).
    statements.push(
      db
        .prepare(
          `UPDATE proposal SET status = 'approved', decided_at = ?2, decided_by = ?3, decision_note = ?4
           WHERE id = ?1 AND status = 'open' AND EXISTS (SELECT 1 FROM change_log WHERE proposal_id = ?1)`,
        )
        .bind(p.id, input.now, p.decidedBy, p.note),
    );
  }
  const results = await db.batch(statements);
  const logged = results[0]?.meta.changes === 1;
  if (!logged) return { applied: false };
  return { applied: true, changeId: Number(results[0]?.meta.last_row_id) };
}

// ---- Proposals ----

export interface NewProposal {
  proposer: Caller;
  target: string;
  from: string | null;
  to: string | null;
  reason: string;
  now: string;
  expiresAt: string;
}

/**
 * File a proposal, or return the identical one that is already open (same target, same from AND to value).
 * Idempotent by construction — an unattended observer re-filing the same ask every run gets the same id
 * back instead of stacking duplicates for the owner. `from` is part of identity: if the target moved since
 * the old proposal was filed, that one is stale (approve refuses it) and a fresh, approvable one is filed.
 * The insert is conditional in ONE statement, so two concurrent filings can't both pass a separate
 * existence check.
 */
export async function fileProposal(
  db: D1Database,
  input: NewProposal,
): Promise<{ proposal: ProposalRow; duplicate: boolean }> {
  const live = `target = ?1 AND to_value IS ?2 AND from_value IS ?7 AND status = 'open' AND expires_at > ?3`;
  const inserted = await db
    .prepare(
      `INSERT INTO proposal (target, to_value, created_at, expires_at, proposer_role, proposer_name, from_value, reason, status)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open'
       WHERE NOT EXISTS (SELECT 1 FROM proposal WHERE ${live})
       RETURNING *`,
    )
    .bind(
      input.target,
      input.to,
      input.now,
      input.expiresAt,
      input.proposer.role,
      input.proposer.name,
      input.from,
      input.reason,
    )
    .first<ProposalRow>();
  if (inserted) return { proposal: inserted, duplicate: false };
  const existing = await db
    .prepare(
      `SELECT * FROM proposal WHERE target = ?1 AND to_value IS ?2 AND from_value IS ?4 AND status = 'open' AND expires_at > ?3 ORDER BY id DESC LIMIT 1`,
    )
    .bind(input.target, input.to, input.now, input.from)
    .first<ProposalRow>();
  if (!existing) throw new Error("proposal insert matched an open duplicate that then vanished");
  return { proposal: existing, duplicate: true };
}

export async function getProposal(db: D1Database, id: number): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposal WHERE id = ?").bind(id).first<ProposalRow>();
}

export async function listProposals(
  db: D1Database,
  which: "open" | "all",
  now: string,
  limit = 100,
): Promise<ProposalRow[]> {
  const stmt =
    which === "open"
      ? db
          .prepare(
            "SELECT * FROM proposal WHERE status = 'open' AND expires_at > ? ORDER BY id DESC LIMIT ?",
          )
          .bind(now, limit)
      : db.prepare("SELECT * FROM proposal ORDER BY id DESC LIMIT ?").bind(limit);
  return (await stmt.all<ProposalRow>()).results;
}

/** Close an open, unexpired proposal without applying it (reject / withdraw / stale). */
export async function closeProposal(
  db: D1Database,
  id: number,
  status: "rejected" | "withdrawn" | "stale",
  decidedBy: string,
  note: string | null,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE proposal SET status = ?2, decided_at = ?3, decided_by = ?4, decision_note = ?5
       WHERE id = ?1 AND status = 'open' AND expires_at > ?3`,
    )
    .bind(id, status, now, decidedBy, note)
    .run();
  return res.meta.changes === 1;
}

// ---- Ledger ----

export interface NewRun {
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string;
  gateMode: string | null;
  units: Record<string, number>;
  detail: string | null;
  recordedAt: string;
  recordedBy: string;
}

export async function insertRun(db: D1Database, run: NewRun): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO ledger (stage, started_at, finished_at, duration_ms, outcome, gate_mode, units, detail, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      run.stage,
      run.startedAt,
      run.finishedAt,
      run.durationMs,
      run.outcome,
      run.gateMode,
      JSON.stringify(run.units),
      run.detail,
      run.recordedAt,
      run.recordedBy,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("ledger insert returned no row");
  return row.id;
}
