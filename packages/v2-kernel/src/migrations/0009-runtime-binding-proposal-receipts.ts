export const RUNTIME_BINDING_PROPOSAL_RECEIPTS_DDL = `
CREATE TABLE schema_guard_0009(x INTEGER NOT NULL CHECK (x = 0));
INSERT INTO schema_guard_0009(x)
  SELECT count(*) FROM agents WHERE generation >= 1;
DROP TABLE schema_guard_0009;
ALTER TABLE agents ADD COLUMN instance_id TEXT NULL;
ALTER TABLE agents ADD COLUMN session_binding TEXT NULL;
CREATE TRIGGER agents_binding_insert_guard BEFORE INSERT ON agents
WHEN (NEW.instance_id IS NULL) <> (NEW.session_binding IS NULL)
  OR (NEW.generation = 0 AND NEW.instance_id IS NOT NULL)
  OR (NEW.generation >= 1 AND NEW.instance_id IS NULL)
  OR (NEW.session_binding IS NOT NULL AND NOT (
        json_valid(NEW.session_binding)
    AND (SELECT count(*) FROM json_each(NEW.session_binding)) = 5
    AND json_type(NEW.session_binding,'$.v') = 'integer'
    AND json_extract(NEW.session_binding,'$.v') = 1
    AND json_type(NEW.session_binding,'$.host_epoch') = 'text'
    AND length(json_extract(NEW.session_binding,'$.host_epoch')) > 0
    AND json_type(NEW.session_binding,'$.session_id') = 'text'
    AND length(json_extract(NEW.session_binding,'$.session_id')) > 0
    AND json_type(NEW.session_binding,'$.pid') = 'integer'
    AND json_extract(NEW.session_binding,'$.pid') > 0
    AND json_type(NEW.session_binding,'$.pid_start') = 'text'
    AND length(json_extract(NEW.session_binding,'$.pid_start')) > 0))
BEGIN SELECT RAISE(ABORT,'agents binding invariant violated'); END;
CREATE TRIGGER agents_binding_update_guard BEFORE UPDATE ON agents
WHEN (NEW.instance_id IS NULL) <> (NEW.session_binding IS NULL)
  OR NEW.generation NOT IN (OLD.generation, OLD.generation + 1)
  OR (NEW.generation = OLD.generation AND (
        NEW.instance_id IS NOT OLD.instance_id
     OR NEW.session_binding IS NOT OLD.session_binding))
  OR (NEW.generation = OLD.generation + 1 AND (
        NEW.instance_id IS NULL OR NEW.session_binding IS NULL
     OR (NEW.instance_id IS OLD.instance_id
         AND NEW.session_binding IS OLD.session_binding)))
  OR (NEW.session_binding IS NOT NULL AND NOT (
        json_valid(NEW.session_binding)
    AND (SELECT count(*) FROM json_each(NEW.session_binding)) = 5
    AND json_type(NEW.session_binding,'$.v') = 'integer'
    AND json_extract(NEW.session_binding,'$.v') = 1
    AND json_type(NEW.session_binding,'$.host_epoch') = 'text'
    AND length(json_extract(NEW.session_binding,'$.host_epoch')) > 0
    AND json_type(NEW.session_binding,'$.session_id') = 'text'
    AND length(json_extract(NEW.session_binding,'$.session_id')) > 0
    AND json_type(NEW.session_binding,'$.pid') = 'integer'
    AND json_extract(NEW.session_binding,'$.pid') > 0
    AND json_type(NEW.session_binding,'$.pid_start') = 'text'
    AND length(json_extract(NEW.session_binding,'$.pid_start')) > 0))
BEGIN SELECT RAISE(ABORT,'agents binding transition violated'); END;
ALTER TABLE processing_attempts ADD COLUMN proposal_digest TEXT NULL;
CREATE TRIGGER pa_receipt_insert_guard BEFORE INSERT ON processing_attempts
WHEN NEW.outcome <> 'running'
  OR NEW.settled_at IS NOT NULL
  OR NEW.proposal_digest IS NOT NULL
BEGIN SELECT RAISE(ABORT,'processing_attempt must start running without receipt'); END;
CREATE TRIGGER pa_digest_transition_guard BEFORE UPDATE ON processing_attempts
WHEN (OLD.outcome <> 'running')
  OR (NEW.outcome = 'running' AND (
        NEW.proposal_digest IS NOT NULL OR NEW.settled_at IS NOT NULL))
  OR (NEW.outcome = 'succeeded' AND (
        NEW.settled_at IS NULL OR NEW.proposal_digest IS NULL))
  OR (NEW.outcome IN ('failed','crashed') AND (
        NEW.settled_at IS NULL OR NEW.proposal_digest IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'processing_attempt receipt immutability violated'); END;
`;
