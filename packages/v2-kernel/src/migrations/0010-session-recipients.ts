import { MAILBOX_INDEX_FAMILY_DDL } from "./0004-mailbox-index-family.js";

/**
 * FLY-1543 ⑤: envelope addressing moves from role names to session refs.
 *
 * After this migration a mailbox recipient is either a lead (an `agents` row
 * with kind='lead') or an active session (an `activations` row whose
 * session_ref carries the `v2dag:` prefix). Runners leave the `agents` table
 * for good: their ledger identity is the activations row, occupancy checks and
 * badge return disappear, and two tasks sharing one roleId can run in
 * parallel.
 *
 * Order inside the mailbox/actions rebuilds is a hard constraint (mirrors
 * migration 0005): index names are schema-global, and a trigger created before
 * the RENAME would be dropped with the old table. Recipient/actor triggers are
 * therefore created LAST, on the final tables. They are the equivalence
 * replacement for the dropped `REFERENCES agents` foreign keys, not a new
 * defence line.
 */
export const SESSION_RECIPIENTS_DDL = `CREATE TABLE _fly1543_guard(
  ok INTEGER NOT NULL CHECK(ok = 1)
);

-- Preflight (a): the session namespace must be free in agents, or lead and
-- session recipients could collide after the cutover.
INSERT INTO _fly1543_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM agents WHERE substr(agent_id,1,6)='v2dag:'
) THEN 0 ELSE 1 END;

-- Preflight (b): an unsettled ship gate whose actor is a runner role name can
-- never be consumed by the new code (role-name actors are retired). Drain it
-- inside the stop-the-world window first.
INSERT INTO _fly1543_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM meta m
  JOIN agents a ON a.agent_id=json_extract(m.value,'$.data.actor_agent_id')
  WHERE m.key LIKE 'ship\\_gate:%' ESCAPE '\\'
    AND json_extract(m.value,'$.data.settled') IS NULL
    AND a.kind='runner'
) THEN 0 ELSE 1 END;

-- Preflight (c): every active activation must map to exactly one runner agents
-- row so the session-binding backfill below is total and unambiguous.
INSERT INTO _fly1543_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM activations act
  WHERE act.state='active'
    AND (SELECT count(*) FROM agents ag
          WHERE ag.kind='runner' AND ag.instance_id=act.session_ref) <> 1
) THEN 0 ELSE 1 END;

ALTER TABLE activations ADD COLUMN session_binding TEXT;
ALTER TABLE activations ADD COLUMN last_poll_at TEXT;

UPDATE activations SET
  session_binding=(SELECT ag.session_binding FROM agents ag
                    WHERE ag.kind='runner' AND ag.instance_id=activations.session_ref),
  last_poll_at=(SELECT ag.last_poll_at FROM agents ag
                 WHERE ag.kind='runner' AND ag.instance_id=activations.session_ref)
WHERE state='active';

-- In-flight runner processing attempts belong to the pre-cutover push channel;
-- crash-settle them so their messages reschedule under the new addressing.
UPDATE processing_attempts
SET outcome='crashed', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE outcome='running' AND activation_id IS NOT NULL;

-- Re-address pending task assignments whose activation is still active
-- (source_id of a dag_task_dispatch row IS the activation id).
UPDATE mailbox
SET to_agent=(SELECT act.session_ref FROM activations act
               WHERE act.id=mailbox.source_id AND act.state='active')
WHERE state='pending' AND source_kind='dag_task_dispatch'
  AND EXISTS(SELECT 1 FROM agents ag
              WHERE ag.agent_id=mailbox.to_agent AND ag.kind='runner')
  AND EXISTS(SELECT 1 FROM activations act
              WHERE act.id=mailbox.source_id AND act.state='active');

-- Every remaining pending runner-bound row cannot be mapped: dead-letter it
-- with one visible event per row. Silent drops are forbidden.
INSERT INTO events(event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,cutover_epoch,created_at)
SELECT 'mailbox_reroute_failed:'||m.message_uid, NULL, NULL,
       'mailbox_reroute_failed','migration','0010-session-recipients',
       json_object('message_uid',m.message_uid,'to_agent',m.to_agent,'kind',m.kind),
       m.cutover_epoch, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM mailbox m
WHERE m.state='pending'
  AND EXISTS(SELECT 1 FROM agents ag
              WHERE ag.agent_id=m.to_agent AND ag.kind='runner');

UPDATE mailbox SET state='dead'
WHERE state='pending'
  AND EXISTS(SELECT 1 FROM agents ag
              WHERE ag.agent_id=mailbox.to_agent AND ag.kind='runner');

-- Mailbox rebuild: byte-identical columns and checks, minus the
-- to_agent REFERENCES agents foreign key (a session recipient has no agents
-- row). Historical applied/dead rows keep their role-name recipients as
-- archaeology.
CREATE TABLE mailbox_v3(
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
  state           TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','dead')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  created_at      TEXT NOT NULL,
  applied_at      TEXT,
  UNIQUE(source_kind, source_id)
);

INSERT INTO mailbox_v3(
  seq,message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at,applied_at
)
SELECT
  seq,message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at,applied_at
FROM mailbox;

DROP TABLE mailbox;
ALTER TABLE mailbox_v3 RENAME TO mailbox;

${MAILBOX_INDEX_FAMILY_DDL}

DELETE FROM sqlite_sequence WHERE name IN ('mailbox','mailbox_v3');
INSERT INTO sqlite_sequence(name,seq)
SELECT 'mailbox', COALESCE(MAX(seq), 0) FROM mailbox;

-- Recipient triggers: the FK equivalence replacement. The kind='lead' bound is
-- deliberate -- it closes the "mail addressed to a tombstoned runner role name
-- becomes a permanent dead letter" hole.
CREATE TRIGGER mailbox_recipient_insert BEFORE INSERT ON mailbox
WHEN NOT (
  (substr(NEW.to_agent,1,6)='v2dag:' AND EXISTS(
     SELECT 1 FROM activations WHERE session_ref=NEW.to_agent AND state='active'))
  OR EXISTS(SELECT 1 FROM agents WHERE agent_id=NEW.to_agent AND kind='lead')
)
BEGIN SELECT RAISE(ABORT, 'mailbox recipient must be a lead or an active session'); END;
CREATE TRIGGER mailbox_recipient_update BEFORE UPDATE OF to_agent ON mailbox
WHEN NEW.to_agent <> OLD.to_agent AND NOT (
  (substr(NEW.to_agent,1,6)='v2dag:' AND EXISTS(
     SELECT 1 FROM activations WHERE session_ref=NEW.to_agent AND state='active'))
  OR EXISTS(SELECT 1 FROM agents WHERE agent_id=NEW.to_agent AND kind='lead')
)
BEGIN SELECT RAISE(ABORT, 'mailbox recipient must be a lead or an active session'); END;

-- Actions rebuild: byte-identical to 0006 minus actor_agent_id REFERENCES
-- agents. Historical runner rows (actor = role name) copy in losslessly but can
-- no longer authenticate new outcomes.
CREATE TABLE actions_v2 (
  id                   TEXT PRIMARY KEY NOT NULL,
  task_id              TEXT REFERENCES tasks(id),
  attempt_id           TEXT REFERENCES attempts(id),
  attempt_generation   INTEGER,
  activation_id        TEXT REFERENCES activations(id),
  actor_kind           TEXT NOT NULL CHECK(actor_kind IN ('lead','runner')),
  actor_agent_id       TEXT NOT NULL CHECK(length(trim(actor_agent_id)) > 0),
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

INSERT INTO actions_v2(
  id,task_id,attempt_id,attempt_generation,activation_id,actor_kind,
  actor_agent_id,actor_instance_id,actor_generation,kind,payload,payload_digest,
  authorization,authorization_digest,logical_key,effect_key,supersedes_action_id,
  retry_basis,cutover_epoch,state,result,created_at,completed_at
)
SELECT
  id,task_id,attempt_id,attempt_generation,activation_id,actor_kind,
  actor_agent_id,actor_instance_id,actor_generation,kind,payload,payload_digest,
  authorization,authorization_digest,logical_key,effect_key,supersedes_action_id,
  retry_basis,cutover_epoch,state,result,created_at,completed_at
FROM actions;

DROP TABLE actions;
ALTER TABLE actions_v2 RENAME TO actions;

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
WHEN CASE NEW.actor_kind
  WHEN 'lead' THEN NOT EXISTS (
    SELECT 1 FROM agents
     WHERE agent_id=NEW.actor_agent_id
       AND generation=NEW.actor_generation
       AND kind='lead'
  )
  ELSE NOT EXISTS (
    SELECT 1 FROM activations
     WHERE id=NEW.activation_id
       AND session_ref=NEW.actor_agent_id
       AND session_ref=NEW.actor_instance_id
       AND state='active'
  )
END
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
WHEN CASE OLD.actor_kind
  WHEN 'lead' THEN NOT EXISTS (
    SELECT 1 FROM agents
     WHERE agent_id=OLD.actor_agent_id
       AND generation=OLD.actor_generation
       AND kind='lead'
  )
  ELSE NOT EXISTS (
    SELECT 1 FROM activations
     WHERE id=OLD.activation_id
       AND session_ref=OLD.actor_agent_id
       AND session_ref=OLD.actor_instance_id
       AND generation=OLD.actor_generation
       AND state='active'
  )
END
BEGIN SELECT RAISE(ABORT, 'action actor generation is not current'); END;

CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
BEGIN SELECT RAISE(ABORT, 'actions rows are not deletable in this batch'); END;

-- Agents closes over leads. Runner rows stay as offline tombstones (never read
-- by new code); new runner-shaped or session-namespaced rows are structurally
-- refused. This is the DDL form of the recipient discriminator, not a fallback.
UPDATE agents SET state='offline' WHERE kind='runner';

CREATE TRIGGER agents_lead_only_insert BEFORE INSERT ON agents
WHEN NEW.kind='runner' OR substr(NEW.agent_id,1,6)='v2dag:'
BEGIN SELECT RAISE(ABORT, 'agents accepts lead identities only'); END;

DROP TABLE _fly1543_guard;`;
