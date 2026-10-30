-- prune moves to enforce together with the scrapers Worker's PRUNE var (apps/scrapers/wrangler.toml), after a
-- clean shadow run on 2026-10-25. Only a row still in shadow moves, and only that move is logged, so a row the
-- owner already flipped on the panel keeps its own change_log entry.

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed', 'prune-enforce', key, value, 'enforce',
  'weekly prune on with the scrapers Worker PRUNE var, after a clean shadow run (2026-10-25)', 'migration'
FROM state WHERE key = 'prune' AND value = 'shadow';

UPDATE state SET value = 'enforce', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'seed:prune-enforce'
WHERE key = 'prune' AND value = 'shadow';
