export const BASE_SCHEMA_DDL = `-- tasks(v1 §1.1-1 + R2-6 rework_of/lineage_root_id)
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY NOT NULL,
  project_id        TEXT NOT NULL,
  external_issue_id TEXT,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('draft','ready','running','blocked','review','done','canceled')),
  state_version     INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER,
  payload           TEXT,
  rework_of         TEXT REFERENCES tasks(id),
  lineage_root_id   TEXT NOT NULL REFERENCES tasks(id),
  created_at        TEXT NOT NULL,
  terminal_at       TEXT
);
CREATE TRIGGER tasks_no_self_rework_ins BEFORE INSERT ON tasks
WHEN NEW.rework_of IS NOT NULL AND NEW.rework_of = NEW.id
BEGIN SELECT RAISE(ABORT, 'tasks.rework_of self-reference'); END;
CREATE TRIGGER tasks_no_self_rework_upd BEFORE UPDATE OF rework_of ON tasks
WHEN NEW.rework_of IS NOT NULL AND NEW.rework_of = NEW.id
BEGIN SELECT RAISE(ABORT, 'tasks.rework_of self-reference'); END;

-- task_dependencies(v1 §1.1-2)
CREATE TABLE task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  blocked_by_task_id TEXT NOT NULL REFERENCES tasks(id),
  condition          TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (task_id, blocked_by_task_id),
  CHECK (task_id <> blocked_by_task_id)
);

-- attempts(v1 §1.1-3 + R2-6 terminal_reason)
CREATE TABLE attempts (
  id                 TEXT PRIMARY KEY NOT NULL,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  generation         INTEGER NOT NULL,
  vendor             TEXT,
  model              TEXT,
  worktree_id        TEXT,
  host_epoch         TEXT,
  desired_state      TEXT NOT NULL CHECK(desired_state IN ('planned','dispatched','started','terminal')),
  observed_state     TEXT NOT NULL DEFAULT 'unknown' CHECK(observed_state IN ('present','absent','unknown')),
  observation_kind   TEXT,
  observed_at        TEXT,
  transcript_cursor  TEXT,
  terminal_reason    TEXT CHECK(terminal_reason IN ('completed','failed','canceled','superseded')),
  started_at         TEXT,
  terminal_at        TEXT,
  UNIQUE (task_id, generation),
  CHECK ((desired_state = 'terminal') = (terminal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX attempts_one_active_per_task ON attempts(task_id) WHERE desired_state <> 'terminal';

-- events(v1 §1.1-4 + R1-9 cutover_epoch)
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid     TEXT NOT NULL UNIQUE,
  task_id       TEXT REFERENCES tasks(id),
  attempt_id    TEXT REFERENCES attempts(id),
  kind          TEXT NOT NULL,
  source_kind   TEXT,
  source_id     TEXT,
  payload       TEXT,
  cutover_epoch INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- commands(v1 §1.1-5 + R1-2/R2-6)
CREATE TABLE commands (
  id               TEXT PRIMARY KEY NOT NULL,
  task_id          TEXT REFERENCES tasks(id),
  attempt_id       TEXT REFERENCES attempts(id),
  generation       INTEGER,
  kind             TEXT NOT NULL,
  payload          TEXT,
  payload_digest   TEXT,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending','claimed','accepted','executing','succeeded','failed','rejected','canceled')),
  result_code      TEXT CHECK(result_code IN ('stale','policy_denied','noop','retryable_failure','effect_unknown','succeeded')),
  claim_owner      TEXT,
  claim_generation INTEGER,
  lease_expires_at TEXT,
  effect_key       TEXT UNIQUE,
  cutover_epoch    INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  accepted_at      TEXT,
  completed_at     TEXT,
  result           TEXT
);

-- command_dependencies(R2-7/R3-4)
CREATE TABLE command_dependencies (
  command_id            TEXT NOT NULL REFERENCES commands(id),
  depends_on_command_id TEXT NOT NULL REFERENCES commands(id),
  kind                  TEXT NOT NULL CHECK(kind IN ('notify_before')),
  PRIMARY KEY (command_id, depends_on_command_id),
  CHECK (command_id <> depends_on_command_id)
);
CREATE TRIGGER command_dependencies_no_cycle BEFORE INSERT ON command_dependencies
WHEN EXISTS (
  WITH RECURSIVE reach(id) AS (
    SELECT NEW.depends_on_command_id
    UNION
    SELECT cd.depends_on_command_id FROM command_dependencies cd JOIN reach r ON cd.command_id = r.id
  )
  SELECT 1 FROM reach WHERE id = NEW.command_id
)
BEGIN SELECT RAISE(ABORT, 'command_dependencies cycle'); END;
CREATE TRIGGER command_dependencies_immutable BEFORE UPDATE ON command_dependencies
BEGIN SELECT RAISE(ABORT, 'command_dependencies rows are immutable; delete and re-insert'); END;

-- gates(v1 §1.1-6)
CREATE TABLE gates (
  id                     TEXT PRIMARY KEY NOT NULL,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  attempt_generation     INTEGER,
  kind                   TEXT NOT NULL,
  subject_digest         TEXT,
  state                  TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','approved','rejected','expired')),
  opened_at              TEXT NOT NULL,
  resolved_at            TEXT,
  resolver_capability_id TEXT REFERENCES capabilities(id)
);

-- capabilities(v1 §1.1-7)
CREATE TABLE capabilities (
  id                   TEXT PRIMARY KEY NOT NULL,
  token_hash           TEXT NOT NULL UNIQUE,
  issuer               TEXT NOT NULL,
  audience             TEXT NOT NULL,
  action               TEXT NOT NULL,
  task_id              TEXT REFERENCES tasks(id),
  attempt_generation   INTEGER,
  subject_digest       TEXT,
  issued_at            TEXT NOT NULL,
  expires_at           TEXT,
  absolute_deadline_at TEXT,
  consumed_at          TEXT,
  revoked_at           TEXT
);

-- obligations R5 old shape
CREATE TABLE obligations (
  id                        TEXT PRIMARY KEY NOT NULL,
  kind                      TEXT NOT NULL,
  target_task_id            TEXT NOT NULL REFERENCES tasks(id),
  target_attempt_generation INTEGER,
  root_episode_id           TEXT,
  parent_obligation_id      TEXT REFERENCES obligations(id),
  depth                     INTEGER NOT NULL DEFAULT 0 CHECK(depth IN (0,1)),
  episode_key               TEXT,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','tombstoned')),
  opened_at                 TEXT NOT NULL,
  resolved_at               TEXT,
  tombstoned_at             TEXT,
  resolution                TEXT,
  resolver_capability_id    TEXT REFERENCES capabilities(id),
  CHECK ((parent_obligation_id IS NULL AND depth = 0) OR (parent_obligation_id IS NOT NULL AND depth = 1))
);
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
  WHERE target_task_id = NEW.id AND state = 'open';
END;
CREATE TRIGGER obligations_tombstone_attempt_terminal AFTER UPDATE OF desired_state ON attempts
WHEN NEW.desired_state = 'terminal' AND OLD.desired_state <> 'terminal'
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_task_id = NEW.task_id AND target_attempt_generation = NEW.generation AND state = 'open';
END;

-- source_receipts(v1 §1.1-8)
CREATE TABLE source_receipts (
  source_kind    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  cursor         TEXT,
  applied_at     TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);

-- mailbox(design-v6 §1.2)
CREATE TABLE mailbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uid     TEXT NOT NULL UNIQUE,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK(retention_class IN ('notice','business','dlq')),
  cutover_epoch   INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','tombstoned','dead')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  created_at      TEXT NOT NULL,
  applied_at      TEXT,
  UNIQUE (source_kind, source_id)
);

-- thread_bindings(design-final §1.1)
CREATE TABLE thread_bindings (
  lineage_root_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  thread_id       TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK(state IN ('active','archived'))
);
CREATE UNIQUE INDEX thread_bindings_one_active ON thread_bindings(lineage_root_id) WHERE state = 'active';

-- archive_manifest(v2 §1.1 R1-8)
CREATE TABLE archive_manifest (
  seq_lo     INTEGER NOT NULL,
  seq_hi     INTEGER NOT NULL,
  sha256     TEXT NOT NULL UNIQUE,
  row_count  INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (seq_lo, seq_hi),
  CHECK (seq_lo <= seq_hi)
);

-- meta(FINAL §1.0)
CREATE TABLE meta (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
