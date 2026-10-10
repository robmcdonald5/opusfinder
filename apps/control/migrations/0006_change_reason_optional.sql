-- The owner's own changes no longer need a reason; an agent's still do (the service enforces that).
-- SQLite can't relax a CHECK in place, so change_log is rebuilt with the same columns and rows.

CREATE TABLE change_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'agent', 'runtime', 'seed', 'break-glass')),
  actor_name TEXT NOT NULL,
  target TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  channel TEXT NOT NULL CHECK (channel IN ('panel', 'api', 'cli', 'rpc', 'migration', 'break-glass')),
  proposal_id INTEGER REFERENCES proposal (id)
) STRICT;

INSERT INTO change_log_new (id, at, actor_role, actor_name, target, from_value, to_value, reason, channel, proposal_id)
  SELECT id, at, actor_role, actor_name, target, from_value, to_value, reason, channel, proposal_id FROM change_log;

DROP TABLE change_log;

ALTER TABLE change_log_new RENAME TO change_log;

CREATE INDEX change_log_target ON change_log (target, id);
