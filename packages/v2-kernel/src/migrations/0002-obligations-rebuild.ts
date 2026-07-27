export const OBLIGATIONS_REBUILD_DDL = `CREATE TABLE obligations_new (
  id                        TEXT PRIMARY KEY NOT NULL,
  kind                      TEXT NOT NULL,
  target_kind               TEXT NOT NULL DEFAULT 'task' CHECK(target_kind IN ('task','agent')),
  target_task_id            TEXT REFERENCES tasks(id),
  target_agent_id           TEXT,
  notify_recipient_agent_id TEXT,
  target_attempt_generation INTEGER,
  root_episode_id           TEXT,
  parent_obligation_id      TEXT REFERENCES obligations_new(id),
  depth                     INTEGER NOT NULL DEFAULT 0 CHECK(depth IN (0,1)),
  episode_key               TEXT,
  last_enqueued_tier        INTEGER NOT NULL DEFAULT 0,
  suppressed_tier           INTEGER,
  last_notified_tier        INTEGER NOT NULL DEFAULT 0,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','tombstoned')),
  opened_at                 TEXT NOT NULL,
  resolved_at               TEXT,
  tombstoned_at             TEXT,
  resolution                TEXT,
  resolver_capability_id    TEXT REFERENCES capabilities(id),
  CHECK ((target_kind = 'task'  AND target_task_id IS NOT NULL AND target_agent_id IS NULL)
      OR (target_kind = 'agent' AND target_agent_id IS NOT NULL AND target_task_id IS NULL)),
  CHECK ((parent_obligation_id IS NULL AND depth = 0) OR (parent_obligation_id IS NOT NULL AND depth = 1))
);
INSERT INTO obligations_new (id, kind, target_kind, target_task_id, target_agent_id,
  notify_recipient_agent_id, target_attempt_generation, root_episode_id, parent_obligation_id,
  depth, episode_key, last_enqueued_tier, suppressed_tier, last_notified_tier,
  state, opened_at, resolved_at, tombstoned_at, resolution, resolver_capability_id)
SELECT id, kind, 'task', target_task_id, NULL,
  NULL, target_attempt_generation, root_episode_id, parent_obligation_id,
  depth, episode_key, 0, NULL, 0,
  state, opened_at, resolved_at, tombstoned_at, resolution, resolver_capability_id
FROM obligations;
DROP TRIGGER obligations_tombstone_task_terminal;
DROP TRIGGER obligations_tombstone_attempt_terminal;
DROP TABLE obligations;
ALTER TABLE obligations_new RENAME TO obligations;
CREATE UNIQUE INDEX obligations_episode_open ON obligations(episode_key) WHERE state = 'open';
CREATE TRIGGER obligations_parent_depth BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND (SELECT depth FROM obligations WHERE id = NEW.parent_obligation_id) <> 0
BEGIN SELECT RAISE(ABORT, 'obligation parent must be depth 0'); END;
CREATE TRIGGER obligations_inherit_root BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND NEW.root_episode_id IS NOT (SELECT root_episode_id FROM obligations WHERE id = NEW.parent_obligation_id)
BEGIN SELECT RAISE(ABORT, 'obligation child must inherit parent root_episode_id'); END;
CREATE TRIGGER obligations_hierarchy_immutable BEFORE UPDATE OF parent_obligation_id, depth, root_episode_id ON obligations
WHEN NEW.parent_obligation_id IS NOT OLD.parent_obligation_id
  OR NEW.depth IS NOT OLD.depth
  OR NEW.root_episode_id IS NOT OLD.root_episode_id
BEGIN SELECT RAISE(ABORT, 'obligation hierarchy fields are immutable'); END;
CREATE TRIGGER obligations_tombstone_task_terminal AFTER UPDATE OF state ON tasks
WHEN NEW.state IN ('done','canceled') AND OLD.state NOT IN ('done','canceled')
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_kind = 'task' AND target_task_id = NEW.id AND state = 'open';
END;
CREATE TRIGGER obligations_tombstone_attempt_terminal AFTER UPDATE OF desired_state ON attempts
WHEN NEW.desired_state = 'terminal' AND OLD.desired_state <> 'terminal'
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_kind = 'task' AND target_task_id = NEW.task_id
    AND target_attempt_generation = NEW.generation AND state = 'open';
END;`;
