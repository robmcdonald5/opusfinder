-- stale_sweep moves to enforce together with the scrapers Worker's STALE_SWEEP var (apps/scrapers/wrangler.toml),
-- after a clean shadow read on 2026-10-18. Only a row still in shadow moves, and only that move is logged, so
-- a row the owner already flipped on the panel keeps its own change_log entry.

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed', 'stale-sweep-enforce', key, value, 'enforce',
  'stale sweep on with the scrapers Worker STALE_SWEEP var, after a clean shadow read (2026-10-18)', 'migration'
FROM state WHERE key = 'stale_sweep' AND value = 'shadow';

UPDATE state SET value = 'enforce', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'seed:stale-sweep-enforce'
WHERE key = 'stale_sweep' AND value = 'shadow';
