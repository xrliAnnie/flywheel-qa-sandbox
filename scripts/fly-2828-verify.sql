.mode column
.headers on
-- (0) Confirm the frozen cohort was imported.
SELECT count(*) AS cohort_rows FROM cohort;
-- (1) Every unsettled cohort member must have a current, fully matching wake
-- identity and a durable question. Missing binding, wake, question, or an
-- identity mismatch is returned as a row. This query must return zero rows.
SELECT c.request_id, d.state
  FROM cohort c
  JOIN s.workflow_rework_delivery d ON d.request_id = c.request_id
 WHERE d.state IN ('pending','turn_granted','awaiting_receipt')
   AND NOT EXISTS (
     SELECT 1
       FROM s.workflow_rework_request r
       JOIN s.workflow_rework_route_revision rr ON rr.request_id = d.request_id AND rr.revision = d.route_revision
       JOIN s.workflow_execution_binding b
         ON b.rework_request_id = d.request_id AND b.run_id = r.run_id AND b.mode = 'wake'
        AND b.execution_id = rr.preferred_actor_execution_id
        AND b.node_id = rr.target_node_id AND b.attempt = rr.target_attempt
       JOIN s.workflow_activation_turn t ON t.activation_id = b.activation_id AND t.execution_id = b.execution_id
       JOIN s.workflow_run ru ON ru.run_id = r.run_id
       JOIN main.turn_wake_outbox w
         ON w.activation_id = b.activation_id AND w.execution_id = b.execution_id
        AND w.epoch = t.epoch AND w.issue_id = ru.issue_id AND w.purpose = 'workflow_rework'
      WHERE r.request_id = d.request_id
        AND COALESCE(w.projection_alert_question_id, w.alert_question_id) IS NOT NULL);
-- (2) CommDB itself: no backlog below the quarantine threshold, and every
-- quarantined row has a question. Both counts must be zero.
SELECT count(*) AS below_threshold_backlog FROM main.turn_wake_outbox
 WHERE state='acked' AND receipt_projected_at IS NULL AND projection_attempts < 20;
SELECT count(*) AS quarantined_without_question FROM main.turn_wake_outbox
 WHERE state='acked' AND receipt_projected_at IS NULL AND projection_attempts >= 20 AND projection_alert_question_id IS NULL;
-- (3) An active or held run may not retain a pending verification path after
-- delivery completed, except for the founder-authorized FLY-2803 B settlement.
-- This query must return zero rows.
SELECT p.request_id
  FROM s.workflow_rework_verification_path p
  JOIN s.workflow_rework_delivery d ON d.request_id = p.request_id
  JOIN s.workflow_run ru ON ru.run_id = p.run_id
 WHERE ru.project_name = 'flywheel' AND ru.status IN ('active','held')
   AND p.state = 'pending' AND d.state = 'completed'
   AND p.request_id NOT IN ('rework:977c3d6ee8dbaeeab2787312407580b1c81d40627c4ffa3659d84356238c37b1');
