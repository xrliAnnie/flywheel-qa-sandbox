-- FLY-2921 rollback: restore the pre-FLY-2921 eight-state rework delivery table.
--
-- Run ONLY against a STOPPED Bridge, immediately before starting a build that
-- predates FLY-2921 (the old code's migration keys on state literals and would
-- otherwise rebuild over rows it cannot hold):
--
--   sqlite3 -bail "$STATE_DB" < scripts/fly-2921-rollback.sql
--
-- Mapping (inverse of migrateWorkflowReworkDeliveryTwoState):
--   returned_to_lead + last_error 'migrated:held:<e>'                → held (last_error <e>)
--   returned_to_lead (anything else)                                  → needs_lead
--   turn_granted with wake_sent_at                                    → awaiting_receipt
--   pending + last_error 'migrated:replacement_pending:<e>'           → replacement_pending (<e>)
--   everything else                                                   → unchanged
--
-- Limits: the coordinator clears last_error on every claim, so the
-- `migrated:` markers only survive until the new Bridge first touches a row.
-- A rolled-back `needs_lead` row on an ACTIVE run has no door in the old code
-- (its founder /rework requires a held run): the first query below lists those
-- rows; handle each with terminate or a founder /rework after holding the run.

.bail on
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

SELECT 'operator_action_required' AS note, d.request_id, q.run_id,
       run.status AS run_status, d.route_revision, d.last_error
  FROM workflow_rework_delivery d
  JOIN workflow_rework_request q ON q.request_id = d.request_id
  JOIN workflow_run run ON run.run_id = q.run_id
 WHERE d.state = 'returned_to_lead'
   AND run.status = 'active'
   AND COALESCE(d.last_error, '') NOT LIKE 'migrated:held:%'
 ORDER BY q.run_id, d.request_id;

DROP TABLE IF EXISTS workflow_rework_delivery_legacy;
CREATE TABLE workflow_rework_delivery_legacy (
	request_id TEXT PRIMARY KEY,
	owner_id TEXT,
	generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
	lease_expires_at TEXT,
	route_revision INTEGER NOT NULL CHECK (route_revision > 0),
	state TEXT NOT NULL CHECK (state IN
	 ('pending','turn_granted','awaiting_receipt','wake_delivered','replacement_pending','completed','held','needs_lead')),
	hold_count INTEGER NOT NULL DEFAULT 0 CHECK (hold_count >= 0),
	next_retry_at TEXT,
	grant_started_at TEXT,
	last_error TEXT,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (request_id, route_revision)
		REFERENCES workflow_rework_route_revision(request_id, revision)
);

INSERT INTO workflow_rework_delivery_legacy
	(request_id, owner_id, generation, lease_expires_at, route_revision,
	 state, hold_count, next_retry_at, grant_started_at, last_error, updated_at)
SELECT request_id, owner_id, generation, lease_expires_at, route_revision,
       CASE
         WHEN state = 'returned_to_lead'
          AND COALESCE(last_error, '') LIKE 'migrated:held:%' THEN 'held'
         WHEN state = 'returned_to_lead' THEN 'needs_lead'
         WHEN state = 'turn_granted' AND wake_sent_at IS NOT NULL
           THEN 'awaiting_receipt'
         WHEN state = 'pending'
          AND COALESCE(last_error, '') LIKE 'migrated:replacement_pending:%'
           THEN 'replacement_pending'
         ELSE state END,
       hold_count, next_retry_at, grant_started_at,
       CASE
         WHEN state = 'returned_to_lead'
          AND COALESCE(last_error, '') LIKE 'migrated:held:%'
           THEN NULLIF(substr(last_error, length('migrated:held:') + 1), '')
         WHEN state = 'pending'
          AND COALESCE(last_error, '') LIKE 'migrated:replacement_pending:%'
           THEN NULLIF(
             substr(last_error, length('migrated:replacement_pending:') + 1), '')
         ELSE last_error END,
       updated_at
  FROM workflow_rework_delivery;

DROP TABLE workflow_rework_delivery;
ALTER TABLE workflow_rework_delivery_legacy RENAME TO workflow_rework_delivery;

COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
