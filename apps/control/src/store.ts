import type { StateMap } from "@opusfinder/control";

import type { Caller } from "./auth";
import { vendorKey } from "./statements";

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
  /** Null when the owner changed it without one. */
  reason: string | null;
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

export interface RunCount {
  stage: string;
  outcome: string;
  n: number;
}

/** Everything /v1/status needs, in one round trip (one batch = one consistent snapshot). */
export async function readStatus(
  db: D1Database,
  now: string,
  changeLimit: number,
  runsSince: string,
  /** The stages to report a last run for (the registry's ids). */
  stageIds: readonly string[],
): Promise<{
  state: StateMap;
  changes: ChangeRow[];
  proposals: ProposalRow[];
  /** The latest proposals that are no longer open (decided, stale or lapsed), newest first. */
  closedProposals: ProposalRow[];
  /** Each stage's latest run by START (a row is written when its run ends). */
  lastRuns: LedgerRow[];
  /** Runs started at or after `runsSince`, counted per stage and outcome. */
  runCounts: RunCount[];
  /** When the master switch and each stage were last turned back on from off: target → ISO time. */
  resumedAt: Map<string, string>;
}> {
  const [state, changes, proposals, closed, runs, counts, resumed] = await db.batch([
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
    // One index seek per stage on (stage, started_at, id), instead of scanning the whole ledger.
    db
      .prepare(
        `SELECT * FROM ledger WHERE id IN (
           SELECT (SELECT id FROM ledger WHERE stage = j.value ORDER BY started_at DESC, id DESC LIMIT 1)
           FROM json_each(?) AS j)`,
      )
      .bind(JSON.stringify(stageIds)),
    db
      .prepare(
        "SELECT stage, outcome, COUNT(*) AS n FROM ledger WHERE started_at >= ? GROUP BY stage, outcome",
      )
      .bind(runsSince),
    db
      .prepare(
        `SELECT target, MAX(at) AS at FROM change_log
         WHERE target IN (SELECT value FROM json_each(?)) AND from_value = 'off' AND to_value <> 'off'
         GROUP BY target`,
      )
      .bind(JSON.stringify(["global", ...stageIds])),
  ]);
  const rows = (state?.results ?? []) as { key: string; value: string }[];
  return {
    state: new Map(rows.map((r) => [r.key, r.value])),
    changes: (changes?.results ?? []) as ChangeRow[],
    proposals: (proposals?.results ?? []) as ProposalRow[],
    closedProposals: (closed?.results ?? []) as ProposalRow[],
    lastRuns: (runs?.results ?? []) as LedgerRow[],
    runCounts: (counts?.results ?? []) as RunCount[],
    resumedAt: new Map(
      ((resumed?.results ?? []) as { target: string; at: string }[]).map((r) => [r.target, r.at]),
    ),
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
  reason: string | null;
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

export interface ClosedProposalFilter extends TimeRange {
  stage?: string | undefined;
  /** A stored status, or "expired" (still 'open' in the table but past expires_at). */
  outcome?: string | undefined;
  beforeId?: number | undefined;
  limit: number;
}

export async function listClosedProposals(
  db: D1Database,
  now: string,
  f: ClosedProposalFilter,
): Promise<ProposalRow[]> {
  // substr, not LIKE: stage ids contain "_", a LIKE wildcard.
  const { results } = await db
    .prepare(
      `SELECT * FROM proposal
       WHERE (status <> 'open' OR expires_at <= ?1)
         AND (?2 IS NULL OR target = ?2 OR substr(target, 1, length(?2) + 1) IN (?2 || '.', ?2 || '@'))
         AND (?3 IS NULL OR (?3 = 'expired' AND status = 'open') OR (?3 <> 'expired' AND status = ?3))
         AND (?4 IS NULL OR id < ?4)
         AND (?6 IS NULL OR COALESCE(decided_at, expires_at) >= ?6)
         AND (?7 IS NULL OR COALESCE(decided_at, expires_at) < ?7)
       ORDER BY id DESC LIMIT ?5`,
    )
    .bind(
      now,
      f.stage ?? null,
      f.outcome ?? null,
      f.beforeId ?? null,
      f.limit,
      f.since ?? null,
      f.until ?? null,
    )
    .all<ProposalRow>();
  return results;
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

/** A half-open time range as ISO strings: rows at or after `since`, before `until`. */
export interface TimeRange {
  since?: string;
  until?: string;
}

export interface RunFilter extends TimeRange {
  stage?: string;
  outcome?: string;
  /** Only rows that sort after this row (paging: pass the last id of the previous page). */
  beforeId?: number;
  limit: number;
}

/**
 * Ledger rows, newest START first (a row is written when its run ends, so id order would put a short run
 * that started later above a long one still going). Paging is by the last row of the previous page:
 * everything that sorts after it on (started_at, id). Every filter is a bound parameter (NULL = no filter).
 */
export async function listRuns(db: D1Database, f: RunFilter): Promise<LedgerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM ledger
       WHERE (?1 IS NULL OR stage = ?1) AND (?2 IS NULL OR outcome = ?2)
         AND (?3 IS NULL OR (started_at, id) < (SELECT started_at, id FROM ledger WHERE id = ?3))
         AND (?5 IS NULL OR started_at >= ?5) AND (?6 IS NULL OR started_at < ?6)
       ORDER BY started_at DESC, id DESC LIMIT ?4`,
    )
    .bind(
      f.stage ?? null,
      f.outcome ?? null,
      f.beforeId ?? null,
      f.limit,
      f.since ?? null,
      f.until ?? null,
    )
    .all<LedgerRow>();
  return results;
}

export interface ChangeFilter extends TimeRange {
  /** A stage's own targets: the stage itself, its knobs (`<stage>.<knob>`) and overrides (`<stage>@…`). */
  stage?: string;
  beforeId?: number;
  limit: number;
}

/** Change-log rows, newest first. */
export async function listChanges(db: D1Database, f: ChangeFilter): Promise<ChangeRow[]> {
  // substr, not LIKE: stage ids contain "_", a LIKE wildcard.
  const { results } = await db
    .prepare(
      `${CHANGE_SELECT}
       WHERE (?1 IS NULL OR c.target = ?1 OR substr(c.target, 1, length(?1) + 1) IN (?1 || '.', ?1 || '@'))
         AND (?2 IS NULL OR c.id < ?2)
         AND (?4 IS NULL OR c.at >= ?4) AND (?5 IS NULL OR c.at < ?5)
       ORDER BY c.id DESC LIMIT ?3`,
    )
    .bind(f.stage ?? null, f.beforeId ?? null, f.limit, f.since ?? null, f.until ?? null)
    .all<ChangeRow>();
  return results;
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

// ---- Statements (the Cost page: what each vendor actually charged) ----

export interface StatementRow {
  id: number;
  received_at: string;
  source: "email" | "manual";
  message_id: string | null;
  sender: string | null;
  subject: string | null;
  vendor: string | null;
  kind: string;
  amount_cents: number | null;
  currency: string | null;
  charged_on: string | null;
  period_start: string | null;
  month: string | null;
  reference: string | null;
  status: "recorded" | "review" | "duplicate" | "ignored" | "excluded";
  note: string | null;
  /** The receiving server's sender-authentication verdicts, domains only (shadow evidence; email only). */
  auth: string | null;
  updated_at: string;
  updated_by: string;
}

export type NewStatement = Omit<StatementRow, "id">;

/** True when an email with this Message-ID was already received (a redelivery or a second forward). */
export async function statementExists(db: D1Database, messageId: string): Promise<boolean> {
  return (
    (await db.prepare("SELECT 1 FROM statement WHERE message_id = ?").bind(messageId).first()) !==
    null
  );
}

/**
 * Emails received since `since`, split into the owner's forwards and Gmail confirmations (stored with
 * `confirmationSender` as their sender): each has its own daily cap, so junk confirmations can't use up the
 * owner's quota.
 */
export async function mailCountsSince(
  db: D1Database,
  since: string,
  confirmationSender: string,
): Promise<{ forwards: number; confirmations: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(sender IS NOT ?2), 0) AS forwards, COALESCE(SUM(sender IS ?2), 0) AS confirmations
       FROM statement WHERE source = 'email' AND received_at >= ?1`,
    )
    .bind(since, confirmationSender)
    .first<{ forwards: number; confirmations: number }>();
  return row ?? { forwards: 0, confirmations: 0 };
}

/**
 * The recorded statement this one repeats, if any: the same vendor (compared by vendorKey, so "Neon, LLC"
 * and "Neon" match) and invoice number, or — when either side has no number — the same vendor and amount
 * charged within 3 days. Two invoices with different numbers are two charges, however alike (two domain
 * renewals on one day); the reader asks the model for the invoice number over a receipt number, so a
 * Stripe invoice and its receipt carry the same one.
 */
export async function findSameCharge(
  db: D1Database,
  s: {
    vendor: string | null;
    reference: string | null;
    amount_cents: number | null;
    charged_on: string | null;
  },
): Promise<number | null> {
  const key = vendorKey(s.vendor);
  if (!key) return null;
  const { results } = await db
    .prepare(
      `SELECT id, vendor FROM statement
       WHERE status = 'recorded'
         AND ((?1 IS NOT NULL AND reference = ?1)
           OR ((?1 IS NULL OR reference IS NULL) AND ?2 IS NOT NULL AND amount_cents = ?2
               AND ?3 IS NOT NULL AND abs(julianday(charged_on) - julianday(?3)) <= 3))
       ORDER BY id`,
    )
    .bind(s.reference, s.amount_cents, s.charged_on)
    .all<{ id: number; vendor: string | null }>();
  return results.find((r) => vendorKey(r.vendor) === key)?.id ?? null;
}

/** Insert one statement; a Message-ID seen before is ignored (returns null). */
export async function insertStatement(db: D1Database, s: NewStatement): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO statement (received_at, source, message_id, sender, subject, vendor, kind, amount_cents,
         currency, charged_on, period_start, month, reference, status, note, auth, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    )
    .bind(
      s.received_at,
      s.source,
      s.message_id,
      s.sender,
      s.subject,
      s.vendor,
      s.kind,
      s.amount_cents,
      s.currency,
      s.charged_on,
      s.period_start,
      s.month,
      s.reference,
      s.status,
      s.note,
      s.auth,
      s.updated_at,
      s.updated_by,
    )
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function getStatement(db: D1Database, id: number): Promise<StatementRow | null> {
  return db.prepare("SELECT * FROM statement WHERE id = ?").bind(id).first<StatementRow>();
}

/** The owner's correction: the fields they confirmed, and whether it counts. */
export async function updateStatement(
  db: D1Database,
  id: number,
  s: Pick<
    StatementRow,
    | "vendor"
    | "kind"
    | "amount_cents"
    | "currency"
    | "charged_on"
    | "period_start"
    | "month"
    | "status"
    | "note"
    | "updated_at"
    | "updated_by"
  >,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE statement SET vendor = ?2, kind = ?3, amount_cents = ?4, currency = ?5, charged_on = ?6,
         period_start = ?7, month = ?8, status = ?9, note = ?10, updated_at = ?11, updated_by = ?12
       WHERE id = ?1`,
    )
    .bind(
      id,
      s.vendor,
      s.kind,
      s.amount_cents,
      s.currency,
      s.charged_on,
      s.period_start,
      s.month,
      s.status,
      s.note,
      s.updated_at,
      s.updated_by,
    )
    .run();
  return res.meta.changes === 1;
}

export interface MonthVendorTotal {
  month: string;
  vendor: string;
  cents: number;
  n: number;
}

/** Everything the Cost page needs, in one batch: totals per month and vendor, one month's rows, the queue. */
export async function readCost(
  db: D1Database,
  fromMonth: string,
  toMonth: string,
): Promise<{
  totals: MonthVendorTotal[];
  rows: StatementRow[];
  review: StatementRow[];
  reviewCount: number;
  notCounted: StatementRow[];
}> {
  const [totals, rows, review, reviewCount, notCounted] = await db.batch([
    db.prepare(
      `SELECT month, vendor, SUM(amount_cents) AS cents, COUNT(*) AS n FROM statement
       WHERE status = 'recorded' AND month IS NOT NULL GROUP BY month, vendor ORDER BY month DESC, cents DESC`,
    ),
    db
      .prepare(
        "SELECT * FROM statement WHERE month BETWEEN ? AND ? AND status = 'recorded' ORDER BY month DESC, charged_on DESC, id DESC",
      )
      .bind(fromMonth, toMonth),
    db.prepare("SELECT * FROM statement WHERE status = 'review' ORDER BY id DESC LIMIT 50"),
    db.prepare("SELECT COUNT(*) AS n FROM statement WHERE status = 'review'"),
    db.prepare(
      "SELECT * FROM statement WHERE status IN ('duplicate', 'ignored', 'excluded') ORDER BY id DESC LIMIT 20",
    ),
  ]);
  return {
    totals: (totals?.results ?? []) as MonthVendorTotal[],
    rows: (rows?.results ?? []) as StatementRow[],
    review: (review?.results ?? []) as StatementRow[],
    reviewCount: ((reviewCount?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
    notCounted: (notCounted?.results ?? []) as StatementRow[],
  };
}

/** The home page's Cost card, without the page's lists: one month's recorded total, the review count. */
export async function readCostSummary(
  db: D1Database,
  month: string,
): Promise<{ cents: number; recorded: number; reviewCount: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(amount_cents), 0) FROM statement WHERE status = 'recorded' AND month = ?1) AS cents,
         (SELECT COUNT(*) FROM statement WHERE status = 'recorded') AS recorded,
         (SELECT COUNT(*) FROM statement WHERE status = 'review') AS reviewCount`,
    )
    .bind(month)
    .first<{ cents: number; recorded: number; reviewCount: number }>();
  return row ?? { cents: 0, recorded: 0, reviewCount: 0 };
}
