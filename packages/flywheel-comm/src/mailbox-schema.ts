import type Database from "better-sqlite3";

export const MAILBOX_SCHEMA_GENERATION = "mailbox_v1" as const;

export function installMailboxRelayInvariantTriggers(
	db: Database.Database,
): void {
	db.exec(`
CREATE TRIGGER IF NOT EXISTS mailbox_non_question_relay_insert_guard
BEFORE INSERT ON mailbox
WHEN NEW.type != 'question' AND NEW.relay_state != 'terminal_disposed'
BEGIN
  SELECT RAISE(ABORT, 'only questions may have an active relay state');
END;

CREATE TRIGGER IF NOT EXISTS mailbox_non_question_relay_update_guard
BEFORE UPDATE OF relay_state, type ON mailbox
WHEN (NEW.relay_state IS NOT OLD.relay_state OR NEW.type IS NOT OLD.type)
  AND NEW.type != 'question'
  AND NEW.relay_state != 'terminal_disposed'
BEGIN
  SELECT RAISE(ABORT, 'only questions may have an active relay state');
END;
`);
}

export function dropReceiptLedgerSchema(db: Database.Database): void {
	db.exec(`
DROP TRIGGER IF EXISTS mailbox_receipt_root_lineage_insert;
DROP TRIGGER IF EXISTS receipt_root_lineage_no_update;
DROP TRIGGER IF EXISTS receipt_root_lineage_no_delete;
DROP TABLE IF EXISTS receipt_root_lineage;
DROP TABLE IF EXISTS receipt_handle_requests;
DROP TABLE IF EXISTS receipt_activation_episodes;
DROP TABLE IF EXISTS receipt_resend_deliveries;
DROP TABLE IF EXISTS receipt_exemption_audit;
DROP INDEX IF EXISTS mailbox_log_settlement_slot;
`);
}

export const MAILBOX_MESSAGE_PROJECTION_VERSION =
	"mailbox_projection_delivered_on_ack_v2" as const;

export const MAILBOX_MESSAGE_PROJECTION_SELECT = `
SELECT
	seq AS rowid,
  id,
  from_agent,
  to_agent,
  type,
  content,
  ref_id AS parent_id,
  CASE WHEN state = 'ACKED' THEN acked_at END AS read_at,
  created_at,
  expires_at,
  deadline_at,
  relay_state,
  resolved_via,
  source_ref AS logical_event_id,
  superseded_at,
  superseded_by,
  json_extract(sender_ref, '$.lease_key') AS sender_lease_key,
  json_extract(sender_ref, '$.generation') AS sender_generation,
  json_extract(sender_ref, '$.holder_pid') AS sender_holder_pid,
  json_extract(sender_ref, '$.holder_start') AS sender_holder_start,
  json_extract(sender_ref, '$.writer_pid') AS writer_pid,
  json_extract(sender_ref, '$.writer_start') AS writer_start,
  checkpoint,
  content_ref,
  COALESCE(content_type, 'text') AS content_type,
  resolved_at,
  /* ${MAILBOX_MESSAGE_PROJECTION_VERSION} */
  CASE WHEN state = 'ACKED' THEN acked_at END AS delivered_at,
  NULL AS attachments,
  kind
FROM mailbox`;

export const MAILBOX_CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  delivery_id TEXT NOT NULL UNIQUE,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('lead','runner','bridge')),
  source_kind TEXT,
  source_ref TEXT,
  type TEXT NOT NULL,
  msg_class TEXT NOT NULL DEFAULT 'model' CHECK(msg_class IN ('protocol','model')),
  content TEXT NOT NULL,
  delivery_content TEXT,
  content_ref TEXT,
  content_type TEXT,
  ref_id TEXT,
  kind TEXT,
  checkpoint TEXT,
  deadline_at TEXT,
  expires_at TEXT,
  relay_state TEXT NOT NULL DEFAULT 'open'
    CHECK(relay_state IN ('open','protected','terminal_disposed')),
  resolved_at TEXT,
  resolved_via TEXT,
  superseded_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK(state IN ('QUEUED','LEASED','ACKED','DEAD')),
  claimed_by TEXT,
  claim_expires_at TEXT,
  delivered_at TEXT,
  notified_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  lease_retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  acked_at TEXT,
  dead_at TEXT,
  dead_reason TEXT,
  carrier TEXT NOT NULL DEFAULT 'inbox' CHECK(carrier IN ('inbox','external')),
  sender_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK(priority BETWEEN 0 AND 3),
  batch_id TEXT,
  collapse_key TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_live
  ON mailbox(to_agent, seq) WHERE state IN ('QUEUED','LEASED');
CREATE INDEX IF NOT EXISTS mailbox_claim
  ON mailbox(to_agent, msg_class, priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'lead';
CREATE INDEX IF NOT EXISTS mailbox_lead_reclaim
  ON mailbox(to_agent, msg_class, priority, seq)
  WHERE carrier = 'inbox' AND state = 'LEASED'
    AND recipient_kind = 'lead' AND batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_lease_expiry
  ON mailbox(claim_expires_at)
  WHERE state = 'LEASED' AND carrier = 'inbox';
CREATE INDEX IF NOT EXISTS mailbox_batch_lookup
  ON mailbox(batch_id, priority, seq)
  WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_lease_expiry_order
  ON mailbox(priority, seq, claim_expires_at)
  WHERE state = 'LEASED' AND carrier = 'inbox' AND batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_claim_runner
  ON mailbox(priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'runner';
CREATE INDEX IF NOT EXISTS mailbox_claim_bridge
  ON mailbox(from_agent, priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'bridge';
CREATE INDEX IF NOT EXISTS mailbox_bridge_reclaim
  ON mailbox(from_agent, priority, seq)
  WHERE carrier = 'inbox' AND state = 'LEASED' AND recipient_kind = 'bridge';
CREATE INDEX IF NOT EXISTS mailbox_legacy_adopt
  ON mailbox(to_agent)
  WHERE carrier = 'inbox' AND type = 'instruction' AND batch_id IS NULL
    AND recipient_kind <> 'lead';
CREATE INDEX IF NOT EXISTS mailbox_questions_by_recipient
  ON mailbox(to_agent, created_at) WHERE type = 'question';
CREATE INDEX IF NOT EXISTS mailbox_questions_by_sender
  ON mailbox(from_agent, created_at) WHERE type = 'question';
CREATE INDEX IF NOT EXISTS mailbox_deliverable_by_agent
  ON mailbox(to_agent) WHERE carrier = 'inbox' AND state = 'QUEUED';
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_unique_response
  ON mailbox(ref_id) WHERE type = 'response';
CREATE INDEX IF NOT EXISTS mailbox_ref_lookup
  ON mailbox(ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_superseded_by_lookup
  ON mailbox(superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_archive_acked
  ON mailbox(acked_at) WHERE state = 'ACKED';
CREATE INDEX IF NOT EXISTS mailbox_archive_dead
  ON mailbox(dead_at) WHERE state = 'DEAD';
CREATE INDEX IF NOT EXISTS mailbox_dead_scan
  ON mailbox(recipient_kind, to_agent, seq)
  WHERE state = 'DEAD' AND carrier = 'inbox';
CREATE INDEX IF NOT EXISTS mailbox_dead_notice_lookup
  ON mailbox(source_ref, seq)
  WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter';

-- Internal read-only compatibility projection while CommDB keeps its public
-- Message shape. The legacy object names remain poisoned below.
CREATE VIEW IF NOT EXISTS mailbox_message_projection AS
${MAILBOX_MESSAGE_PROJECTION_SELECT};

CREATE TABLE IF NOT EXISTS mailbox_identity (
  id TEXT NOT NULL UNIQUE,
  delivery_id TEXT NOT NULL UNIQUE,
  insert_projection_hash TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(id, delivery_id)
);
CREATE TRIGGER IF NOT EXISTS mailbox_identity_guard
BEFORE INSERT ON mailbox
BEGIN
  SELECT RAISE(ABORT, 'FLY-1572: identity not reserved or already archived')
   WHERE NOT EXISTS (
     SELECT 1 FROM mailbox_identity
      WHERE id = NEW.id AND delivery_id = NEW.delivery_id AND archived_at IS NULL
   );
END;
CREATE TRIGGER IF NOT EXISTS mailbox_identity_no_delete
BEFORE DELETE ON mailbox_identity
BEGIN SELECT RAISE(ABORT, 'mailbox_identity is permanent'); END;
CREATE TRIGGER IF NOT EXISTS mailbox_identity_update_guard
BEFORE UPDATE ON mailbox_identity
WHEN OLD.id != NEW.id
  OR OLD.delivery_id != NEW.delivery_id
  OR OLD.insert_projection_hash != NEW.insert_projection_hash
  OR OLD.archived_at IS NOT NULL
  OR NEW.archived_at IS NULL
BEGIN SELECT RAISE(ABORT, 'mailbox_identity is permanent'); END;

CREATE TABLE IF NOT EXISTS mailbox_log (
  log_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  message_id TEXT NOT NULL,
  subject_id TEXT,
  event TEXT NOT NULL CHECK(event IN
    ('migrated_history','migration_snapshot','archived','processed','disposed','progress')),
  at TEXT NOT NULL,
  source_table TEXT,
  row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_log_message ON mailbox_log(message_id);
CREATE INDEX IF NOT EXISTS mailbox_log_subject
  ON mailbox_log(subject_id) WHERE subject_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS mailbox_log_no_update
BEFORE UPDATE ON mailbox_log
BEGIN SELECT RAISE(ABORT, 'mailbox_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS mailbox_log_no_delete
BEFORE DELETE ON mailbox_log
BEGIN SELECT RAISE(ABORT, 'mailbox_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS mailbox_delete_requires_archive
BEFORE DELETE ON mailbox
WHEN NOT EXISTS (
  SELECT 1
    FROM mailbox_identity AS identity
   WHERE identity.id = OLD.id
     AND identity.delivery_id = OLD.delivery_id
     AND identity.archived_at IS NOT NULL
)
OR NOT EXISTS (
  SELECT 1
    FROM mailbox_log AS archived
   WHERE archived.message_id = OLD.id
     AND archived.event = 'archived'
     AND archived.log_seq = (
       SELECT newest.log_seq
         FROM mailbox_log AS newest
        WHERE newest.message_id = OLD.id
          AND newest.event = 'archived'
        ORDER BY newest.at DESC, newest.log_seq DESC
        LIMIT 1
     )
     AND json_valid(archived.row_json)
     AND json_extract(archived.row_json, '$.id') IS OLD.id
     AND json_extract(archived.row_json, '$.delivery_id') IS OLD.delivery_id
     AND json_extract(archived.row_json, '$.state') IS OLD.state
     AND (
       OLD.state != 'ACKED'
       OR json_extract(archived.row_json, '$.acked_at') IS OLD.acked_at
     )
     AND (
       OLD.state != 'DEAD'
       OR json_extract(archived.row_json, '$.dead_at') IS OLD.dead_at
     )
)
BEGIN
  SELECT RAISE(ABORT, 'mailbox delete requires matching archive evidence');
END;

CREATE TABLE IF NOT EXISTS content_ref_gc_outbox (
  intent_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS content_ref_gc_due
  ON content_ref_gc_outbox(next_retry_at, created_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS receipt_alert_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  canceled_at TEXT,
  cancel_reason TEXT
);
CREATE TABLE IF NOT EXISTS loop_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  owner_epoch TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  renewed_at TEXT
);
CREATE TABLE IF NOT EXISTS loop_heartbeat (
  lead_id TEXT PRIMARY KEY,
  last_started_at TEXT,
  last_success_at TEXT,
  stall_episode_at TEXT
);
CREATE TABLE IF NOT EXISTS mailbox_migration_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_generation TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  source_messages_count INTEGER,
  source_lead_inbox_count INTEGER,
  source_true_unread_count INTEGER
);
`;

export const MAILBOX_POISON_VIEWS = `
CREATE VIEW IF NOT EXISTS messages AS
  SELECT * FROM fly1572_poison_messages_use_mailbox;
CREATE VIEW IF NOT EXISTS lead_inbox AS
  SELECT * FROM fly1572_poison_lead_inbox_use_mailbox;
`;

export const MAILBOX_SCHEMA = `${MAILBOX_CORE_SCHEMA}
INSERT INTO mailbox_migration_meta (singleton, schema_generation, completed_at)
VALUES (1, '${MAILBOX_SCHEMA_GENERATION}', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(singleton) DO NOTHING;
${MAILBOX_POISON_VIEWS}`;
