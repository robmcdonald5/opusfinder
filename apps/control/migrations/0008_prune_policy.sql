-- The weekly job prune's switch (the scrapers Worker's PRUNE var), adopted as today's reality: shadow, which
-- counts what it would delete and deletes nothing. Written explicitly with its own change_log row, like 0002.

INSERT INTO state (key, value, updated_at, updated_by)
VALUES ('prune', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:prune');

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT updated_at, 'seed', 'prune', key, NULL, value,
  'weekly job prune adopted in shadow: it counts what it would delete', 'migration'
FROM state WHERE key = 'prune';
