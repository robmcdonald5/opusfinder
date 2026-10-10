-- Runs are read by when they STARTED (a row is written when its run ends): the panel's Runs list and each
-- stage's latest run (per stage), and the last-24-h counts (all stages). (stage, started_at, id) serves the
-- per-stage reads and replaces 0001's (stage, id); (started_at, id) serves the all-stage ones.
CREATE INDEX ledger_stage_started ON ledger (stage, started_at, id);
CREATE INDEX ledger_started ON ledger (started_at, id);
DROP INDEX ledger_stage;
