-- Location resolving on the scrapers Worker's own cron, adopted at its registry default: off, as every stage
-- added after adoption starts. The Worker's LOCATIONS var is what it obeys; this row moves with it. Written
-- explicitly with its own change_log row, like 0002.

INSERT INTO state (key, value, updated_at, updated_by)
VALUES ('locations', 'off', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed:locations');

INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel)
SELECT updated_at, 'seed', 'locations', key, NULL, value,
  'location resolving adopted off: the scrapers Worker runs it on its own cron once its LOCATIONS var says so',
  'migration'
FROM state WHERE key = 'locations';
