import { MAILBOX_INDEX_FAMILY_DDL } from "./0004-mailbox-index-family.js";

export const AGENTS_CONFIG_MAILBOX_REBUILD_DDL = `CREATE TABLE agents(
  agent_id     TEXT PRIMARY KEY NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('lead','runner')),
  generation   INTEGER NOT NULL CHECK(generation >= 0),
  last_poll_at TEXT,
  state        TEXT NOT NULL CHECK(state IN ('online','offline'))
);

CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents
BEGIN SELECT RAISE(ABORT, 'agents rows cannot be deleted'); END;
CREATE TRIGGER agents_agent_id_immutable BEFORE UPDATE OF agent_id ON agents
WHEN NEW.agent_id <> OLD.agent_id
BEGIN SELECT RAISE(ABORT, 'agents.agent_id is immutable'); END;
CREATE TRIGGER agents_kind_immutable BEFORE UPDATE OF kind ON agents
WHEN NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'agents.kind is immutable'); END;
CREATE TRIGGER agents_generation_no_rollback BEFORE UPDATE OF generation ON agents
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'agents.generation cannot decrease'); END;

CREATE TABLE config(
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE _agents_cutover_guard(
  ok INTEGER NOT NULL CHECK(ok = 1)
);

INSERT INTO _agents_cutover_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM meta
  WHERE key LIKE 'consumer_registry:%'
    AND (
      substr(key, length('consumer_registry:') + 1) = ''
      OR NOT json_valid(value)
      OR json_extract(value, '$.kind') NOT IN ('lead','runner')
      OR json_type(value, '$.generation') <> 'integer'
      OR json_extract(value, '$.generation') < 1
      OR (
        json_extract(value, '$.kind') = 'lead'
        AND json_extract(value, '$.leadId')
            <> substr(key, length('consumer_registry:') + 1)
      )
      OR (
        json_extract(value, '$.kind') = 'runner'
        AND json_extract(value, '$.agentId')
            <> substr(key, length('consumer_registry:') + 1)
      )
    )
) THEN 0 ELSE 1 END;

INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
SELECT
  substr(key, length('consumer_registry:') + 1),
  json_extract(value, '$.kind'),
  json_extract(value, '$.generation'),
  NULL,
  'online'
FROM meta
WHERE key LIKE 'consumer_registry:%';

INSERT INTO _agents_cutover_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1
  FROM mailbox m
  LEFT JOIN agents a ON a.agent_id = m.to_agent
  WHERE a.agent_id IS NULL
) THEN 0 ELSE 1 END;

INSERT INTO _agents_cutover_guard(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM mailbox WHERE state = 'tombstoned'
) THEN 0 ELSE 1 END;

CREATE TABLE mailbox_v2(
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uid     TEXT NOT NULL UNIQUE,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  to_agent        TEXT NOT NULL REFERENCES agents(agent_id),
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

INSERT INTO mailbox_v2(
  seq,message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at,applied_at
)
SELECT
  seq,message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at,applied_at
FROM mailbox;

DROP TABLE mailbox;
ALTER TABLE mailbox_v2 RENAME TO mailbox;

${MAILBOX_INDEX_FAMILY_DDL}

DELETE FROM sqlite_sequence WHERE name IN ('mailbox','mailbox_v2');
INSERT INTO sqlite_sequence(name,seq)
SELECT 'mailbox', COALESCE(MAX(seq), 0) FROM mailbox;

DELETE FROM meta WHERE key LIKE 'consumer_registry:%';
DROP TABLE _agents_cutover_guard;`;
