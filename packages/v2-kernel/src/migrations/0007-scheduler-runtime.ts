export const SCHEDULER_RUNTIME_DDL = `CREATE TABLE scheduler_runs(
  run_id      TEXT PRIMARY KEY NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT NOT NULL CHECK(result IN (
                'running','succeeded','partial','failed','lease_busy','timed_out','probe'
              )),
  host        TEXT NOT NULL,
  backend     TEXT NOT NULL,
  detail      TEXT
);

CREATE TABLE scheduler_leases(
  lease_key        TEXT PRIMARY KEY NOT NULL,
  owner_run_id     TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE scheduler_repair_leases(
  agent_id         TEXT NOT NULL,
  generation       INTEGER NOT NULL CHECK(generation > 0),
  owner_run_id     TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  next_attempt_at  TEXT,
  failure_count    INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  last_result      TEXT CHECK(last_result IN (
                     'succeeded','failed','held','memory_limited'
                   )),
  updated_at       TEXT NOT NULL,
  PRIMARY KEY(agent_id,generation)
);
CREATE INDEX scheduler_repair_due
  ON scheduler_repair_leases(next_attempt_at,lease_expires_at);
`;
