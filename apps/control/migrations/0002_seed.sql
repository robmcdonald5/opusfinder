-- Slice-1 seed = today's reality at adoption (control-surface architecture §12.1): ingest + discover on;
-- embed, alerts, digest, live_integration off; cv_ingest on; close enforce, stale_sweep shadow, every
-- health check shadow. Every mode row is written explicitly, each with its own change_log row, so the
-- store (not the registry defaults) holds the adopted values and the audit trail starts at adoption.
-- Knobs and dimension overrides are NOT seeded: a missing knob row reads as the registry default, which
-- already equals today's env values (INGEST_LIMIT=150, STALE_SWEEP_TTL_DAYS=21, …), and no slice is
-- narrowed today. The control Worker's integration suite asserts these rows equal the registry's
-- `initial` values, so the two can't drift.

INSERT INTO state (key, value, updated_at, updated_by) VALUES
  ('global', 'on', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('ingest', 'on', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('discover', 'on', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('embed', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('alerts', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('digest', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('live_integration', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('cv_ingest', 'on', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('close', 'enforce', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('stale_sweep', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.ingestion_staleness', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.board_fail_ratio', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.discovery_window', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.discovery_lane_errors', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.embedding_backlog', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.digest_health', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1'),
  ('health.bounce_suppression', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:slice-1');

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT updated_at, 'seed', 'slice-1', key, NULL, value,
  'slice-1 seed: today''s reality at adoption (architecture §12.1)', 'migration'
FROM state ORDER BY rowid;
