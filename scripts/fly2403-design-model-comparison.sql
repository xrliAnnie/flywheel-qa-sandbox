-- FLY-2403: read-only Astra/Fable design-outcome comparison.
-- Rule fly2403-v1: odd issue = A/Astra; even issue = B/Fable.
--
-- Edit report_parameters to change the experiment cohort or arm definitions.
-- The immutable workflow_execution_runtime row is arm authority. A matching
-- dispatch_vendor_resolved event is corroborating audit evidence: zero events
-- are reported but do not discard sanctioned rework; contradictory or duplicate
-- events remain fail-closed attribution contamination.
--
-- Review rounds use each lane's durable round ledger, but both lanes must also
-- have the same append-only design completion event after the lane evidence.
-- Astra requires a done APPROVED review job; Fable requires its current
-- manifest to be delivered. Request-looking evidence alone is not counted as
-- approval. Every workflow event kind read here (dispatch_vendor_resolved,
-- node_completed, loop_iteration, loop_limit_escalated, and
-- founder_feedback_kickback) is outside both workflow_run_event cleanup
-- allowlists. workflow_run_node/runtime are protected current/reference tables,
-- and both review ledgers are protected authority tables. Terminal session stage
-- rows, by contrast, are archived after seven days.
--
-- Design duration is completed eng_design node wall time, not model-only latency.

WITH
report_parameters AS (
	SELECT CAST(NULL AS TEXT) AS cohort_started_at,
	       CAST(NULL AS TEXT) AS cohort_ended_before,
	       'eng_design' AS design_node_id,
	       'qa' AS qa_node_id,
	       'founder_gate' AS founder_node_id,
	       'gpt-6-astra' AS astra_model,
	       'claude-fable-*' AS fable_model_glob,
	       'dispatch_vendor_resolved' AS dispatch_event_kind,
	       'design' AS design_review_type,
	       'done' AS completed_state,
	       'APPROVED' AS approved_verdict,
	       'CHANGES_REQUESTED' AS changes_requested_verdict,
	       'node_completed' AS design_completion_kind,
	       'qa_retry' AS qa_retry_edge_id,
	       'loop_iteration' AS loop_iteration_kind,
	       'loop_limit_escalated' AS loop_escalated_kind,
	       'founder_feedback_kickback' AS founder_kickback_kind
),
design_execution_universe AS (
	SELECT DISTINCT node.run_id,
	       node.node_id,
	       node.execution_id,
	       runtime.model,
	       CASE
	         WHEN runtime.model = parameters.astra_model THEN 'astra'
	         WHEN runtime.model GLOB parameters.fable_model_glob THEN 'fable'
	       END AS arm
	  FROM workflow_run_node AS node
	  JOIN workflow_run AS run ON run.run_id = node.run_id
	  LEFT JOIN workflow_execution_runtime AS runtime
	    ON runtime.run_id = node.run_id
	   AND runtime.node_id = node.node_id
	   AND runtime.execution_id = node.execution_id
	 CROSS JOIN report_parameters AS parameters
	 WHERE node.node_id = parameters.design_node_id
	   AND (parameters.cohort_started_at IS NULL
	        OR julianday(run.created_at) >= julianday(parameters.cohort_started_at))
	   AND (parameters.cohort_ended_before IS NULL
	        OR julianday(run.created_at) < julianday(parameters.cohort_ended_before))
	UNION ALL
	SELECT runtime.run_id,
	       runtime.node_id,
	       runtime.execution_id,
	       runtime.model,
	       CASE
	         WHEN runtime.model = parameters.astra_model THEN 'astra'
	         WHEN runtime.model GLOB parameters.fable_model_glob THEN 'fable'
	       END AS arm
	  FROM workflow_execution_runtime AS runtime
	  JOIN workflow_run AS run ON run.run_id = runtime.run_id
	 CROSS JOIN report_parameters AS parameters
	 WHERE runtime.node_id = parameters.design_node_id
	   AND (parameters.cohort_started_at IS NULL
	        OR julianday(run.created_at) >= julianday(parameters.cohort_started_at))
	   AND (parameters.cohort_ended_before IS NULL
	        OR julianday(run.created_at) < julianday(parameters.cohort_ended_before))
	   AND NOT EXISTS (
	     SELECT 1
	       FROM workflow_run_node AS node
	      WHERE node.run_id = runtime.run_id
	        AND node.node_id = runtime.node_id
	        AND node.execution_id = runtime.execution_id
	   )
),
design_execution_audit_counts AS (
	SELECT design.*,
	       (
	         SELECT COUNT(*)
	           FROM workflow_run_event AS receipt
	          WHERE receipt.run_id = design.run_id
	            AND receipt.node_id = design.node_id
	            AND receipt.execution_id = design.execution_id
	            AND receipt.kind = parameters.dispatch_event_kind
	       ) AS dispatch_event_n,
	       (
	         SELECT COUNT(*)
	           FROM workflow_run_event AS receipt
	          WHERE receipt.run_id = design.run_id
	            AND receipt.node_id = design.node_id
	            AND receipt.execution_id = design.execution_id
	            AND receipt.kind = parameters.dispatch_event_kind
	            AND CASE WHEN json_valid(receipt.payload)
	                     THEN json_extract(receipt.payload, '$.dispatch.model')
	                END = design.model
	       ) AS matching_event_n
	  FROM design_execution_universe AS design
	 CROSS JOIN report_parameters AS parameters
),
design_execution_attribution AS (
	SELECT counted.*,
	       CASE WHEN counted.dispatch_event_n = 0
	                  OR (counted.dispatch_event_n = 1
	                      AND counted.matching_event_n = 1)
	            THEN 1 ELSE 0 END AS attribution_ok,
	       CASE WHEN counted.dispatch_event_n = 0 THEN 1 ELSE 0 END
	         AS dispatch_audit_missing
	  FROM design_execution_audit_counts AS counted
),
run_attribution AS (
	SELECT run_id,
	       MIN(arm) AS arm,
	       COUNT(*) AS execution_n,
	       SUM(CASE WHEN arm IS NOT NULL THEN 1 ELSE 0 END) AS arm_execution_n,
	       SUM(attribution_ok) AS attribution_valid_n,
	       SUM(dispatch_audit_missing) AS dispatch_audit_missing_n,
	       COUNT(DISTINCT arm) AS arm_n
	  FROM design_execution_attribution
	 GROUP BY run_id
	HAVING SUM(CASE WHEN arm IS NOT NULL THEN 1 ELSE 0 END) > 0
),
eligible_runs AS (
	SELECT run_id, arm
	  FROM run_attribution
	 WHERE arm_execution_n = execution_n
	   AND attribution_valid_n = execution_n
	   AND arm_n = 1
),
validated_design_executions AS (
	SELECT design.run_id,
	       design.node_id,
	       design.execution_id,
	       eligible.arm,
	       design.dispatch_audit_missing
	  FROM design_execution_attribution AS design
	  JOIN eligible_runs AS eligible ON eligible.run_id = design.run_id
	 WHERE design.arm = eligible.arm
	   AND design.attribution_ok = 1
),
completed_design_executions AS (
	SELECT DISTINCT design.run_id, design.execution_id, design.arm
	  FROM validated_design_executions AS design
	  JOIN workflow_run_node AS node
	    ON node.run_id = design.run_id
	   AND node.node_id = design.node_id
	   AND node.execution_id = design.execution_id
	 CROSS JOIN report_parameters AS parameters
	 WHERE node.state = parameters.completed_state
),
qa_windows AS (
	SELECT attribution.run_id
	  FROM run_attribution AS attribution
	 CROSS JOIN report_parameters AS parameters
	 WHERE EXISTS (
	   SELECT 1
	     FROM workflow_run_node AS node
	    WHERE node.run_id = attribution.run_id
	      AND node.node_id = parameters.qa_node_id
	      AND node.state = parameters.completed_state
	 )
),
founder_windows AS (
	SELECT attribution.run_id
	  FROM run_attribution AS attribution
	 CROSS JOIN report_parameters AS parameters
	 WHERE EXISTS (
	   SELECT 1
	     FROM workflow_run_node AS node
	    WHERE node.run_id = attribution.run_id
	      AND node.node_id = parameters.founder_node_id
	      AND node.state = parameters.completed_state
	 )
),
experiment_design_windows AS (
	SELECT DISTINCT attribution.run_id
	  FROM run_attribution AS attribution
	  JOIN workflow_run_node AS node ON node.run_id = attribution.run_id
	 CROSS JOIN report_parameters AS parameters
	 WHERE node.node_id = parameters.design_node_id
	   AND node.state = parameters.completed_state
),
astra_review_by_execution AS (
	SELECT design.run_id,
	       design.arm,
	       design.execution_id,
	       (
	         SELECT CASE
	                  WHEN job.verdict = parameters.approved_verdict
	                   AND EXISTS (
	                     SELECT 1
	                       FROM workflow_run_event AS completion
	                      WHERE completion.run_id = design.run_id
	                        AND completion.node_id = parameters.design_node_id
	                        AND completion.execution_id = design.execution_id
	                        AND completion.kind = parameters.design_completion_kind
	                        AND julianday(completion.at) >= julianday(job.updated_at)
	                   )
	                  THEN job.round
	                END
	           FROM codex_review_job AS job
	          WHERE job.execution_id = design.execution_id
	            AND job.review_type = parameters.design_review_type
	            AND job.status = parameters.completed_state
	            AND job.verdict IN (
	              parameters.approved_verdict,
	              parameters.changes_requested_verdict
	            )
	          ORDER BY job.round DESC, job.updated_at DESC, job.request_id DESC
	          LIMIT 1
	       ) AS final_round
	  FROM completed_design_executions AS design
	 CROSS JOIN report_parameters AS parameters
	 WHERE design.arm = 'astra'
),
fable_review_by_execution AS (
	SELECT design.run_id,
	       design.arm,
	       design.execution_id,
	       (
	         SELECT MAX(manifest.revision)
	           FROM design_review_manifest AS manifest
	          WHERE manifest.execution_id = design.execution_id
	            AND manifest.is_current = 1
	            AND manifest.delivered_at IS NOT NULL
	            AND EXISTS (
	              SELECT 1
	                FROM workflow_run_event AS completion
	               WHERE completion.run_id = design.run_id
	                 AND completion.node_id = parameters.design_node_id
	                 AND completion.execution_id = design.execution_id
	                 AND completion.kind = parameters.design_completion_kind
	                 AND julianday(completion.at) >= julianday(manifest.delivered_at)
	            )
	       ) AS final_round
	  FROM completed_design_executions AS design
	 CROSS JOIN report_parameters AS parameters
	 WHERE design.arm = 'fable'
),
review_by_execution AS (
	SELECT * FROM astra_review_by_execution
	UNION ALL
	SELECT * FROM fable_review_by_execution
),
review_by_run AS (
	SELECT run_id,
	       arm,
	       COUNT(*) AS completed_execution_n,
	       COUNT(final_round) AS evidence_execution_n,
	       SUM(final_round) AS value
	  FROM review_by_execution
	 GROUP BY run_id, arm
),
qa_by_run AS (
	SELECT eligible.run_id,
	       eligible.arm,
	       CASE WHEN EXISTS (
	         SELECT 1
	           FROM workflow_run_event AS legacy
	          WHERE legacy.run_id = eligible.run_id
	            AND legacy.kind IN (
	              parameters.loop_iteration_kind,
	              parameters.loop_escalated_kind
	            )
	            AND (legacy.edge_id IS NULL OR trim(legacy.edge_id) = '')
	       ) THEN 1 ELSE 0 END AS unknown,
	       (
	         SELECT COUNT(DISTINCT kickback.event_uid)
	           FROM workflow_run_event AS kickback
	          WHERE kickback.run_id = eligible.run_id
	            AND kickback.edge_id = parameters.qa_retry_edge_id
	            AND kickback.kind IN (
	              parameters.loop_iteration_kind,
	              parameters.loop_escalated_kind
	            )
	       ) AS value
	  FROM eligible_runs AS eligible
	  JOIN qa_windows AS window ON window.run_id = eligible.run_id
	 CROSS JOIN report_parameters AS parameters
),
founder_by_run AS (
	SELECT eligible.run_id,
	       eligible.arm,
	       (
	         SELECT COUNT(DISTINCT kickback.event_uid)
	           FROM workflow_run_event AS kickback
	          WHERE kickback.run_id = eligible.run_id
	            AND kickback.kind = parameters.founder_kickback_kind
	       ) AS value
	  FROM eligible_runs AS eligible
	  JOIN founder_windows AS window ON window.run_id = eligible.run_id
	 CROSS JOIN report_parameters AS parameters
),
duration_by_run AS (
	SELECT design.run_id,
	       design.arm,
	       SUM(CASE
	             WHEN node.started_at IS NULL
	               OR node.ended_at IS NULL
	               OR julianday(node.started_at) IS NULL
	               OR julianday(node.ended_at) IS NULL
	               OR julianday(node.ended_at) < julianday(node.started_at)
	             THEN 1 ELSE 0
	           END) AS invalid_n,
	       SUM(CASE
	             WHEN node.started_at IS NOT NULL
	              AND node.ended_at IS NOT NULL
	              AND julianday(node.started_at) IS NOT NULL
	              AND julianday(node.ended_at) IS NOT NULL
	              AND julianday(node.ended_at) >= julianday(node.started_at)
	             THEN round(
	               (julianday(node.ended_at) - julianday(node.started_at)) * 24.0,
	               6
	             )
	           END) AS value
	  FROM validated_design_executions AS design
	  JOIN workflow_run_node AS node
	    ON node.run_id = design.run_id
	   AND node.node_id = design.node_id
	   AND node.execution_id = design.execution_id
	 CROSS JOIN report_parameters AS parameters
	 WHERE node.state = parameters.completed_state
	 GROUP BY design.run_id, design.arm
),
observations(metric, run_id, arm, value) AS (
	SELECT 'design_review_approval_rounds', run_id, arm, value
	  FROM review_by_run
	 WHERE evidence_execution_n = completed_execution_n
	UNION ALL
	SELECT 'qa_kickbacks', run_id, arm, value
	  FROM qa_by_run WHERE unknown = 0
	UNION ALL
	SELECT 'founder_kickbacks', run_id, arm, value
	  FROM founder_by_run
	UNION ALL
	SELECT 'design_duration_hours', run_id, arm, value
	  FROM duration_by_run WHERE invalid_n = 0
),
metric_windows(metric, run_id) AS (
	SELECT 'design_review_approval_rounds', run_id FROM experiment_design_windows
	UNION ALL
	SELECT 'qa_kickbacks', run_id FROM qa_windows
	UNION ALL
	SELECT 'founder_kickbacks', run_id FROM founder_windows
	UNION ALL
	SELECT 'design_duration_hours', run_id FROM experiment_design_windows
),
arm_metric_windows AS (
	SELECT DISTINCT window.metric, window.run_id, eligible.arm
	  FROM metric_windows AS window
	  JOIN eligible_runs AS eligible ON eligible.run_id = window.run_id
),
metric_arm_window_counts AS (
	SELECT metric,
	       COUNT(CASE WHEN arm = 'astra' THEN 1 END) AS astra_window_n,
	       COUNT(CASE WHEN arm = 'fable' THEN 1 END) AS fable_window_n
	  FROM arm_metric_windows
	 GROUP BY metric
),
attribution_exclusions AS (
	SELECT window.metric, COUNT(*) AS excluded_n
	  FROM metric_windows AS window
	  JOIN run_attribution AS attribution ON attribution.run_id = window.run_id
	 WHERE attribution.arm_execution_n <> attribution.execution_n
	    OR attribution.attribution_valid_n <> attribution.execution_n
	    OR attribution.arm_n <> 1
	 GROUP BY window.metric
),
dispatch_audit_missing AS (
	SELECT window.metric, COUNT(*) AS missing_n
	  FROM metric_windows AS window
	  JOIN run_attribution AS attribution ON attribution.run_id = window.run_id
	  JOIN eligible_runs AS eligible ON eligible.run_id = window.run_id
	 WHERE attribution.dispatch_audit_missing_n > 0
	 GROUP BY window.metric
),
review_evidence_exclusion(excluded_n) AS (
	SELECT COUNT(*)
	  FROM review_by_run
	 WHERE evidence_execution_n <> completed_execution_n
),
qa_ambiguous_exclusion(excluded_n) AS (
	SELECT COUNT(*) FROM qa_by_run WHERE unknown = 1
),
duration_invalid_exclusion(excluded_n) AS (
	SELECT COUNT(*) FROM duration_by_run WHERE invalid_n > 0
),
metric_order(metric, ordinal, data_source) AS (
	VALUES (
	         'design_review_approval_rounds',
	         1,
	         'codex_review_job / design_review_manifest + workflow_run_event(node_completed)'
	       ),
	       (
	         'qa_kickbacks',
	         2,
	         'workflow_run_event(qa_retry) + workflow_run_node(qa done)'
	       ),
	       (
	         'founder_kickbacks',
	         3,
	         'workflow_run_event(founder_feedback_kickback) + workflow_run_node(founder_gate done)'
	       ),
	       (
	         'design_duration_hours',
	         4,
	         'workflow_run_node(eng_design started_at/ended_at)'
	       )
)
SELECT metrics.metric,
	   round(AVG(CASE WHEN observation.arm = 'astra' THEN observation.value END), 6)
	     AS astra_avg,
	   SUM(CASE WHEN observation.arm = 'astra' THEN observation.value END)
	     AS astra_total,
	   COUNT(CASE WHEN observation.arm = 'astra' THEN 1 END) AS astra_n,
	   round(AVG(CASE WHEN observation.arm = 'fable' THEN observation.value END), 6)
	     AS fable_avg,
	   SUM(CASE WHEN observation.arm = 'fable' THEN observation.value END)
	     AS fable_total,
	   COUNT(CASE WHEN observation.arm = 'fable' THEN 1 END) AS fable_n,
	   COALESCE((
	     SELECT exclusion.excluded_n
	       FROM attribution_exclusions AS exclusion
	      WHERE exclusion.metric = metrics.metric
	   ), 0) AS attribution_excluded_n,
	   COALESCE((
	     SELECT missing.missing_n
	       FROM dispatch_audit_missing AS missing
	      WHERE missing.metric = metrics.metric
	   ), 0) AS dispatch_audit_missing_n,
	   CASE WHEN metrics.metric = 'design_review_approval_rounds'
	        THEN (SELECT excluded_n FROM review_evidence_exclusion)
	        ELSE 0
	    END AS review_evidence_excluded_n,
	   CASE WHEN metrics.metric = 'qa_kickbacks'
	        THEN (SELECT excluded_n FROM qa_ambiguous_exclusion)
	        ELSE 0
	    END AS qa_ambiguous_excluded_n,
	   CASE WHEN metrics.metric = 'design_duration_hours'
	        THEN (SELECT excluded_n FROM duration_invalid_exclusion)
	        ELSE 0
	    END AS duration_invalid_excluded_n,
	   metrics.data_source,
	   COALESCE(windows.astra_window_n, 0) AS astra_window_n,
	   COALESCE(windows.fable_window_n, 0) AS fable_window_n,
	   CASE WHEN COUNT(CASE WHEN observation.arm = 'astra' THEN 1 END) = 0
	        THEN '0 样本 · 不可结论'
	        ELSE printf(
	          '%d/%d 样本',
	          COUNT(CASE WHEN observation.arm = 'astra' THEN 1 END),
	          COALESCE(windows.astra_window_n, 0)
	        )
	    END AS astra_coverage,
	   CASE WHEN COUNT(CASE WHEN observation.arm = 'fable' THEN 1 END) = 0
	        THEN '0 样本 · 不可结论'
	        ELSE printf(
	          '%d/%d 样本',
	          COUNT(CASE WHEN observation.arm = 'fable' THEN 1 END),
	          COALESCE(windows.fable_window_n, 0)
	        )
	    END AS fable_coverage
  FROM metric_order AS metrics
  LEFT JOIN observations AS observation ON observation.metric = metrics.metric
  LEFT JOIN metric_arm_window_counts AS windows ON windows.metric = metrics.metric
 GROUP BY metrics.metric, metrics.ordinal, metrics.data_source,
          windows.astra_window_n, windows.fable_window_n
 ORDER BY metrics.ordinal;
