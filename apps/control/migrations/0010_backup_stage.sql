-- The nightly user-table backup (.github/workflows/backup.yml) and its health check, adopted at their registry
-- defaults: the stage off, as every stage added after adoption starts (the workflow doesn't read it yet), and the
-- check in shadow. Written explicitly with their own change_log rows, like 0002.

INSERT INTO state (key, value, updated_at, updated_by) VALUES
  ('backup', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:backup'),
  ('health.backup_staleness', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:backup');

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT updated_at, 'seed', 'backup', key, NULL, value,
  'nightly user-table backup adopted: the stage off (unwired), its health check in shadow', 'migration'
FROM state WHERE key IN ('backup', 'health.backup_staleness') ORDER BY rowid;
