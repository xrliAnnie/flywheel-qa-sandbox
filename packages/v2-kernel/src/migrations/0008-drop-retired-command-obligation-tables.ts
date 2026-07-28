export const RETIRED_TABLES_DDL = `-- FLY-1518: commands, command_dependencies, and obligations are retired.
-- actions replaces the command outbox; the obligation family is removed from v2.
-- Record discarded row counts before DROP so a populated pre-launch database is
-- auditable even though this migration deliberately does not preserve those rows.
INSERT INTO events (
  event_uid, task_id, attempt_id, kind, source_kind, source_id,
  payload, cutover_epoch, created_at
)
VALUES (
  'migration:0008:retired-rows-discarded', NULL, NULL,
  'migration.retired_rows_discarded', 'migration',
  '0008-drop-retired-command-obligation-tables',
  json_object(
    'commands',             (SELECT count(*) FROM commands),
    'command_dependencies', (SELECT count(*) FROM command_dependencies),
    'obligations',          (SELECT count(*) FROM obligations)
  ),
  CAST(COALESCE(
    (SELECT value FROM meta WHERE key='cutover_epoch'),
    '0'
  ) AS INTEGER),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- These triggers are attached to retained tables, so dropping obligations would
-- not remove them automatically.
DROP TRIGGER obligations_tombstone_task_terminal;
DROP TRIGGER obligations_tombstone_attempt_terminal;

-- Drop the child table before its two command foreign-key parents.
DROP TABLE command_dependencies;
DROP TABLE commands;
DROP TABLE obligations;`;
