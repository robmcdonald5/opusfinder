-- opusfinder control plane, slice 1 (control-surface architecture §3, §12.1).
-- Applied with `wrangler d1 migrations apply opusfinder-control` (--local for dev, --remote once by the
-- owner). One statement per `;`-terminated line-end: the test harness splits on that (no triggers here).
--
-- Times are ISO-8601 UTC strings from Date#toISOString() (or the same format from strftime in the seed),
-- so they compare and sort lexicographically.

-- Desired state. One row per target address (see packages/control/src/targets.ts). A MISSING row means
-- the registry default — fail-closed layer 1; an unrecognised value reads as off — layer 2.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

-- The approval queue. An agent's non-safe change (classify() → "propose") lands here; the owner approves
-- or rejects it on the page. Open proposals lapse 7 days after creation (expires_at; checked at read and
-- approve time, so no sweeper is needed).
CREATE TABLE proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  proposer_role TEXT NOT NULL CHECK (proposer_role IN ('owner', 'agent')),
  proposer_name TEXT NOT NULL,
  target TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
) STRICT;

CREATE INDEX proposal_open ON proposal (status, target);

-- Append-only audit trail (C3). Written in the SAME D1 batch as the state change it records. from/to are
-- the resolved desired values (NULL = no override); proposal_id links an approval to the proposer.
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'agent', 'runtime', 'seed', 'break-glass')),
  actor_name TEXT NOT NULL,
  target TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  channel TEXT NOT NULL CHECK (channel IN ('panel', 'api', 'cli', 'rpc', 'migration', 'break-glass')),
  proposal_id INTEGER REFERENCES proposal (id)
) STRICT;

CREATE INDEX change_log_target ON change_log (target, id);

-- One summary row per stage run (B1/S3), written at the end of each tick through the same channel as the
-- gate. units = JSON {unitId: number}. detail is a shape-safe one-liner: never secrets or PII.
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'partial', 'skipped')),
  gate_mode TEXT,
  units TEXT NOT NULL DEFAULT '{}',
  detail TEXT,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL
) STRICT;

CREATE INDEX ledger_stage ON ledger (stage, id);
