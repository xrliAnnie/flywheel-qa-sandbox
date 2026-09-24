.mode tabs
-- One row per cohort member: request_id, delivery_state, route_revision,
-- run_id, run_status. The first row is a portable header for .import --skip 1.
SELECT 'request_id','delivery_state','route_revision','run_id','run_status'
UNION ALL
SELECT d.request_id, d.state, d.route_revision, ru.run_id, ru.status
  FROM workflow_rework_delivery d
  JOIN workflow_rework_request r ON r.request_id = d.request_id
  JOIN workflow_run ru ON ru.run_id = r.run_id
 WHERE ru.project_name = 'flywheel' AND ru.status IN ('active','held')
   AND d.state IN ('pending','turn_granted','awaiting_receipt')
   AND d.updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes');
