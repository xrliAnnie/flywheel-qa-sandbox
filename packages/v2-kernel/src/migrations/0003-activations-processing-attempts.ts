export const ACTIVATIONS_PROCESSING_ATTEMPTS_DDL = `CREATE TABLE activations(
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','terminal'))
);
CREATE UNIQUE INDEX activations_one_per_attempt ON activations(attempt_id) WHERE state='active';
CREATE UNIQUE INDEX activations_one_per_session ON activations(session_ref) WHERE state='active';

CREATE TABLE processing_attempts(
  attempt_uid TEXT PRIMARY KEY NOT NULL,
  message_uid TEXT NOT NULL REFERENCES mailbox(message_uid),
  attempt_no  INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  activation_id TEXT,
  started_at  TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','succeeded','failed','crashed')),
  settled_at  TEXT,
  UNIQUE(message_uid, attempt_no)
);
CREATE UNIQUE INDEX pa_one_running ON processing_attempts(message_uid) WHERE outcome='running';`;
