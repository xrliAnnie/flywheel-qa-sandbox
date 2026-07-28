export const ACTIONS_BLACK_BOX_DDL = `CREATE TABLE actions (
  id                   TEXT PRIMARY KEY NOT NULL,
  task_id              TEXT REFERENCES tasks(id),
  attempt_id           TEXT REFERENCES attempts(id),
  attempt_generation   INTEGER,
  activation_id        TEXT REFERENCES activations(id),
  actor_kind           TEXT NOT NULL CHECK(actor_kind IN ('lead','runner')),
  actor_agent_id       TEXT NOT NULL REFERENCES agents(agent_id),
  actor_instance_id    TEXT NOT NULL CHECK(length(trim(actor_instance_id)) > 0),
  actor_generation     INTEGER NOT NULL CHECK(actor_generation >= 0),
  kind                 TEXT NOT NULL CHECK(length(trim(kind)) > 0),
  payload              TEXT NOT NULL,
  payload_digest       TEXT NOT NULL,
  authorization        TEXT,
  authorization_digest TEXT,
  logical_key          TEXT NOT NULL CHECK(length(trim(logical_key)) > 0),
  effect_key           TEXT NOT NULL UNIQUE CHECK(length(trim(effect_key)) > 0),
  supersedes_action_id TEXT REFERENCES actions(id),
  retry_basis          TEXT,
  cutover_epoch        INTEGER NOT NULL CHECK(cutover_epoch >= 0),
  state                TEXT NOT NULL DEFAULT 'intended'
                       CHECK(state IN ('intended','succeeded','failed')),
  result               TEXT,
  created_at           TEXT NOT NULL,
  completed_at         TEXT,
  CHECK (json_valid(payload)),
  CHECK (
    (attempt_id IS NULL AND attempt_generation IS NULL AND activation_id IS NULL)
    OR
    (task_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_generation IS NOT NULL)
  ),
  CHECK (actor_kind='lead' OR activation_id IS NOT NULL),
  CHECK (
    (authorization IS NULL AND authorization_digest IS NULL)
    OR
    (authorization IS NOT NULL AND authorization_digest IS NOT NULL
      AND json_valid(authorization))
  ),
  CHECK (
    CASE WHEN supersedes_action_id IS NULL
      THEN retry_basis IS NULL
      ELSE supersedes_action_id <> id
        AND retry_basis IS NOT NULL
        AND CASE WHEN json_valid(retry_basis) = 1
          THEN coalesce(
            json_type(retry_basis,'$.evidence_ref') = 'text'
            AND json_type(retry_basis,'$.reason') = 'text'
            AND length(trim(json_extract(retry_basis,'$.evidence_ref'))) > 0
            AND length(trim(json_extract(retry_basis,'$.reason'))) > 0
            AND lower(trim(json_extract(retry_basis,'$.reason'))) NOT IN ('retry','重试')
            AND retry_basis = json_object(
              'evidence_ref', json_extract(retry_basis,'$.evidence_ref'),
              'reason', json_extract(retry_basis,'$.reason')
            ),
            0
          )
          ELSE 0
        END
    END
  ),
  CHECK (
    (state='intended' AND result IS NULL AND completed_at IS NULL) OR
    (state IN ('succeeded','failed') AND result IS NOT NULL
      AND json_valid(result) AND completed_at IS NOT NULL)
  )
);

CREATE INDEX actions_state_created
  ON actions(state, created_at DESC, id DESC);
CREATE INDEX actions_actor_created
  ON actions(actor_agent_id, created_at DESC, id DESC);
CREATE INDEX actions_task_created
  ON actions(task_id, created_at DESC, id DESC)
  WHERE task_id IS NOT NULL;
CREATE INDEX actions_logical_created
  ON actions(logical_key, created_at DESC, id DESC);
CREATE UNIQUE INDEX actions_one_root_per_logical
  ON actions(logical_key)
  WHERE supersedes_action_id IS NULL;
CREATE UNIQUE INDEX actions_one_successor
  ON actions(supersedes_action_id)
  WHERE supersedes_action_id IS NOT NULL;

CREATE TRIGGER actions_current_actor_insert BEFORE INSERT ON actions
WHEN NOT EXISTS (
  SELECT 1 FROM agents
   WHERE agent_id=NEW.actor_agent_id
     AND generation=NEW.actor_generation
     AND kind=NEW.actor_kind
)
BEGIN SELECT RAISE(ABORT, 'action actor generation is not current'); END;

CREATE TRIGGER actions_lineage_insert BEFORE INSERT ON actions
WHEN NEW.attempt_id IS NOT NULL AND (
  NOT EXISTS (
    SELECT 1 FROM attempts
     WHERE id=NEW.attempt_id
       AND generation=NEW.attempt_generation
       AND task_id=NEW.task_id
  )
  OR (
    NEW.activation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM activations
       WHERE id=NEW.activation_id
         AND attempt_id=NEW.attempt_id
         AND generation=NEW.attempt_generation
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'action attempt/activation lineage mismatch'); END;

CREATE TRIGGER actions_supersedes_insert BEFORE INSERT ON actions
WHEN NEW.supersedes_action_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM actions prior
   WHERE prior.id=NEW.supersedes_action_id
     AND prior.state IN ('intended','failed')
     AND prior.logical_key=NEW.logical_key
     AND prior.task_id IS NEW.task_id
     AND prior.attempt_id IS NEW.attempt_id
     AND prior.attempt_generation IS NEW.attempt_generation
     AND prior.kind=NEW.kind
     AND prior.payload_digest=NEW.payload_digest
     AND prior.cutover_epoch=NEW.cutover_epoch
)
BEGIN SELECT RAISE(ABORT, 'action retry must supersede matching failed/unknown intent'); END;

CREATE TRIGGER actions_immutable_fields BEFORE UPDATE ON actions
WHEN NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.attempt_generation IS NOT OLD.attempt_generation
  OR NEW.activation_id IS NOT OLD.activation_id
  OR NEW.actor_kind IS NOT OLD.actor_kind
  OR NEW.actor_agent_id IS NOT OLD.actor_agent_id
  OR NEW.actor_instance_id IS NOT OLD.actor_instance_id
  OR NEW.actor_generation IS NOT OLD.actor_generation
  OR NEW.kind IS NOT OLD.kind
  OR NEW.payload IS NOT OLD.payload
  OR NEW.payload_digest IS NOT OLD.payload_digest
  OR NEW.authorization IS NOT OLD.authorization
  OR NEW.authorization_digest IS NOT OLD.authorization_digest
  OR NEW.logical_key IS NOT OLD.logical_key
  OR NEW.effect_key IS NOT OLD.effect_key
  OR NEW.supersedes_action_id IS NOT OLD.supersedes_action_id
  OR NEW.retry_basis IS NOT OLD.retry_basis
  OR NEW.cutover_epoch IS NOT OLD.cutover_epoch
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'action intent fields are immutable'); END;

CREATE TRIGGER actions_terminal_once BEFORE UPDATE ON actions
WHEN OLD.state <> 'intended'
  OR NEW.state NOT IN ('succeeded','failed')
  OR NEW.result IS NULL
  OR NEW.completed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'action outcome transition is invalid'); END;

CREATE TRIGGER actions_current_actor_outcome BEFORE UPDATE ON actions
WHEN NOT EXISTS (
  SELECT 1 FROM agents
   WHERE agent_id=OLD.actor_agent_id
     AND generation=OLD.actor_generation
     AND kind=OLD.actor_kind
)
BEGIN SELECT RAISE(ABORT, 'action actor generation is not current'); END;

CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
BEGIN SELECT RAISE(ABORT, 'actions rows are not deletable in this batch'); END;`;
