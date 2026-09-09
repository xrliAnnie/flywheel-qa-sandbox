-- FLY-2398 two-week shadow report. Read-only input; all working state is TEMP.
-- Parameters: :window_start and :window_end (canonical UTC milliseconds).
.bail on

CREATE TEMP TABLE shadow_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO shadow_guard
SELECT
  (SELECT COUNT(*) FROM state_store_migration
    WHERE migration_id = 'fly-2398-shadow-observation-v1') = 1
  AND length(:window_start) = 24
  AND length(:window_end) = 24
  AND :window_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND :window_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND julianday(:window_start) IS NOT NULL
  AND julianday(:window_end) IS NOT NULL
  AND strftime('%Y-%m-%dT%H:%M:%fZ', :window_start) = :window_start
  AND strftime('%Y-%m-%dT%H:%M:%fZ', :window_end) = :window_end
  AND julianday(:window_start) >= julianday((
    SELECT applied_at FROM state_store_migration
     WHERE migration_id = 'fly-2398-shadow-observation-v1'
  ))
  AND julianday(:window_start) < julianday(:window_end)
  AND abs((julianday(:window_end) - julianday(:window_start)) - 14.0) < 0.000000001
  AND julianday('now') >= julianday(:window_end);

CREATE TEMP TABLE approvals AS
SELECT
  'claim:' || c.id AS action_key,
  'approved' AS action,
  c.id AS claim_id,
  NULL AS request_id,
  NULL AS dead_key,
  c.workflow_run_id AS run_id,
  c.issued_at AS acted_at,
  json_extract(c.evidence, '$.questionId') AS evidence_question_id,
  c.authority_id,
  lower(c.subject_digest) AS claim_head,
  h.question_id AS holder_question_id,
  lower(h.head_sha) AS holder_head,
  h.attempt,
  CASE WHEN h.question_id IS NOT NULL
         AND c.authority_id = h.question_id
         AND json_extract(c.evidence, '$.questionId') = h.question_id
         AND lower(c.subject_digest) = lower(h.head_sha)
       THEN 1 ELSE 0 END AS binding_ok,
  CASE WHEN h.question_id IS NULL THEN 0 ELSE 1 END AS holder_count
FROM workflow_claims c
LEFT JOIN workflow_gate_holder h
  ON h.question_id = json_extract(c.evidence, '$.questionId')
 AND h.run_id = c.workflow_run_id
 AND h.gate_node_id = 'founder_gate'
 AND h.authority_mode = 'land'
 AND h.subject_kind = 'git_head'
WHERE c.decision_kind = 'founder_decision'
  AND c.predicate = 'founder_approved'
  AND c.issuer_kind = 'founder_challenge'
  AND c.subject_kind = 'git_head'
  AND julianday(c.issued_at) >= julianday(:window_start)
  AND julianday(c.issued_at) < julianday(:window_end);

CREATE TEMP TABLE rework_holders AS
SELECT
  r.request_id,
  COUNT(h.question_id) AS holder_count,
  MIN(h.question_id) AS only_question_id,
  MIN(lower(h.head_sha)) AS only_head
FROM workflow_rework_request r
LEFT JOIN workflow_gate_holder h
  ON h.run_id = r.run_id
 AND h.gate_node_id = r.source_node_id
 AND h.attempt = r.source_attempt
 AND h.authority_mode = 'land'
 AND h.subject_kind = 'git_head'
WHERE r.source_node_id = 'founder_gate'
  AND r.authority IN ('founder', 'lead')
  AND julianday(r.requested_at) >= julianday(:window_start)
  AND julianday(r.requested_at) < julianday(:window_end)
GROUP BY r.request_id;

CREATE TEMP TABLE reworks AS
SELECT
  'rework:' || r.request_id AS action_key,
  'rework' AS action,
  NULL AS claim_id,
  r.request_id,
  NULL AS dead_key,
  r.run_id,
  r.requested_at AS acted_at,
  NULL AS evidence_question_id,
  NULL AS authority_id,
  NULL AS claim_head,
  CASE WHEN rh.holder_count = 1 THEN rh.only_question_id END AS holder_question_id,
  CASE WHEN rh.holder_count = 1 THEN rh.only_head END AS holder_head,
  r.source_attempt AS attempt,
  CASE WHEN rh.holder_count = 1 THEN 1 ELSE 0 END AS binding_ok,
  rh.holder_count
FROM workflow_rework_request r
JOIN rework_holders rh ON rh.request_id = r.request_id;

CREATE TEMP TABLE lost AS
SELECT
  'dead:' || d.project || '|' || d.source_event_id AS action_key,
  'lost' AS action,
  NULL AS claim_id,
  NULL AS request_id,
  d.project || '|' || d.source_event_id AS dead_key,
  NULL AS run_id,
  d.at AS acted_at,
  NULL AS evidence_question_id,
  NULL AS authority_id,
  NULL AS claim_head,
  NULL AS holder_question_id,
  NULL AS holder_head,
  NULL AS attempt,
  0 AS binding_ok,
  0 AS holder_count
FROM workflow_source_deadletter d
WHERE (d.source_event_id GLOB 'founder-approval:*'
       OR d.source_event_id GLOB 'founder-feedback:*')
  AND julianday(d.at) >= julianday(:window_start)
  AND julianday(d.at) < julianday(:window_end);

CREATE TEMP TABLE cohort_all AS
SELECT * FROM approvals
UNION ALL SELECT * FROM reworks
UNION ALL SELECT * FROM lost;

CREATE TEMP TABLE verdict_match AS
SELECT
  a.action_key,
  COUNT(v.verdict_id) AS verdict_match_count,
  MIN(v.verdict_id) AS only_verdict_id
FROM cohort_all a
LEFT JOIN workflow_founder_gate_verdict v
  ON (a.action = 'approved' AND v.claim_id = a.claim_id)
  OR (a.action = 'rework' AND v.rework_request_id = a.request_id)
GROUP BY a.action_key;

CREATE TEMP TABLE current_declaration AS
SELECT d.*
FROM auto_merge_shadow_declaration d
JOIN (
  SELECT question_id, MAX(declaration_seq) AS max_seq
  FROM auto_merge_shadow_declaration
  WHERE julianday(declared_at) < julianday(:window_end)
  GROUP BY question_id
) latest
  ON latest.question_id = d.question_id
 AND latest.max_seq = d.declaration_seq;

CREATE TEMP TABLE acts_raw AS
SELECT
  a.*,
  vm.verdict_match_count,
  v.verdict_id,
  v.verdict,
  v.founder_authored,
  v.rework_request_id AS verdict_request_id,
  v.recorded_at,
  v.repo_identity AS verdict_repo_identity,
  v.pr_number AS verdict_pr_number,
  lower(v.head_sha) AS verdict_head_sha,
  v.question_id AS verdict_question_id,
  v.run_id AS verdict_run_id,
  v.author_evidence_json,
  wr.issue_id,
  o.verdict_id AS observation_verdict_id,
  o.run_id AS observation_run_id,
  o.question_id AS observation_question_id,
  o.repo_identity AS observation_repo_identity,
  o.pr_number AS observation_pr_number,
  lower(o.head_sha) AS observation_head_sha,
  o.observed_at,
  o.machine_class,
  o.machine_reason,
  o.machine_declared_max_snapshot_age_ms,
  o.machine_basis_json,
  o.s2_ran_status,
  o.s2_ran_reason,
  o.s2_record_status,
  o.s2_record_reason,
  o.s2_verdict,
  o.s2_basis_record_id,
  o.s2_row_count,
  o.s2_other_head_row_count,
  d.declared_class,
  d.run_id AS declaration_run_id,
  d.declared_at
FROM cohort_all a
JOIN verdict_match vm ON vm.action_key = a.action_key
LEFT JOIN workflow_founder_gate_verdict v
  ON vm.verdict_match_count = 1 AND v.verdict_id = vm.only_verdict_id
LEFT JOIN workflow_run wr ON wr.run_id = a.run_id
LEFT JOIN auto_merge_shadow_observation o ON o.verdict_id = v.verdict_id
LEFT JOIN current_declaration d ON d.question_id = a.holder_question_id;

CREATE TEMP TABLE acts AS
SELECT
  ar.*,
  ar.binding_ok AS action_binding_ok,
  CASE WHEN ar.verdict_match_count = 1
         AND ar.verdict = ar.action
         AND ar.verdict_run_id = ar.run_id
         AND ar.verdict_question_id = ar.holder_question_id
         AND ar.verdict_head_sha = ar.holder_head
       THEN 1 ELSE 0 END AS verdict_ok,
  CASE WHEN ar.observation_verdict_id IS NOT NULL
         AND ar.observation_run_id = ar.verdict_run_id
         AND ar.observation_question_id = ar.verdict_question_id
         AND ar.observation_repo_identity = ar.verdict_repo_identity
         AND ar.observation_pr_number = ar.verdict_pr_number
         AND ar.observation_head_sha = ar.verdict_head_sha
         AND ar.observed_at = ar.recorded_at
         AND ar.observation_question_id = ar.holder_question_id
       THEN 1 ELSE 0 END AS mirror_ok,
  CASE WHEN ar.observation_verdict_id IS NULL THEN 0
       WHEN (SELECT COUNT(*) FROM strength_two_evidence_record s
              WHERE s.run_id = ar.observation_run_id
                AND s.target_repo_identity = ar.observation_repo_identity
                AND s.head_sha = ar.observation_head_sha
                AND julianday(s.recorded_at) <= julianday(ar.observed_at)) <> ar.s2_row_count
         THEN 0
       WHEN (SELECT COUNT(*) FROM strength_two_evidence_record s
              WHERE s.run_id = ar.observation_run_id
                AND s.target_repo_identity = ar.observation_repo_identity
                AND s.head_sha <> ar.observation_head_sha
                AND julianday(s.recorded_at) <= julianday(ar.observed_at)) <> ar.s2_other_head_row_count
         THEN 0
       WHEN ar.s2_row_count = 0 THEN
         CASE WHEN ar.s2_ran_status = 'unsatisfied'
                   AND ar.s2_ran_reason = 'no_ledger_row'
                   AND ar.s2_record_status = 'unsatisfied'
                   AND ar.s2_record_reason = 'no_ledger_row'
                   AND ar.s2_verdict = 'unsatisfied'
                   AND ar.s2_basis_record_id IS NULL
              THEN 1 ELSE 0 END
       WHEN ar.s2_basis_record_id = (
              SELECT s.record_id FROM strength_two_evidence_record s
               WHERE s.run_id = ar.observation_run_id
                 AND s.target_repo_identity = ar.observation_repo_identity
                 AND s.head_sha = ar.observation_head_sha
                 AND julianday(s.recorded_at) <= julianday(ar.observed_at)
               ORDER BY (s.verdict = 'satisfied') DESC, s.recorded_at DESC, s.record_id DESC
               LIMIT 1
            )
         AND EXISTS (
              SELECT 1 FROM strength_two_evidence_record s
               WHERE s.record_id = ar.s2_basis_record_id
                 AND s.ran_status = ar.s2_ran_status
                 AND s.ran_reason = ar.s2_ran_reason
                 AND s.record_status = ar.s2_record_status
                 AND s.record_reason = ar.s2_record_reason
                 AND s.verdict = ar.s2_verdict
            )
         THEN 1 ELSE 0 END AS s2_ok,
  CASE WHEN ar.holder_question_id IS NOT NULL
            AND ar.declared_class IS NOT NULL
            AND ar.declaration_run_id = ar.run_id
       THEN 1 ELSE 0 END AS declaration_ok
FROM acts_raw ar;

CREATE TEMP TABLE docs_cards AS
SELECT * FROM acts
WHERE machine_class = 'docs_only'
  AND action_binding_ok = 1
  AND verdict_ok = 1
  AND mirror_ok = 1;

CREATE TEMP TABLE eligible_docs_cards AS
SELECT * FROM docs_cards WHERE declared_class IS NOT NULL;

CREATE TEMP TABLE docs_runs AS
SELECT DISTINCT run_id FROM docs_cards;

CREATE TEMP TABLE eligible_docs_runs AS
SELECT DISTINCT run_id FROM eligible_docs_cards;

CREATE TEMP TABLE nested_card AS
SELECT
  d.action_key,
  d.run_id,
  CASE WHEN EXISTS (
    SELECT 1
    FROM codex_review_record cr
    JOIN workflow_run_node rn ON rn.execution_id = cr.execution_id
    WHERE rn.run_id = d.run_id
      AND lower(cr.target_repo_identity) <> '__main__'
      AND julianday(cr.created_at) > julianday(d.observed_at)
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT json_extract(p.value, '$.repoIdentityKey') AS repo_identity,
                 json_extract(p.value, '$.expectedHead') AS head_sha
            FROM json_each(d.machine_basis_json, '$.prs') p
          UNION ALL
          SELECT json_extract(p.value, '$.repoIdentityKey'),
                 json_extract(p.value, '$.snapshotHead')
            FROM json_each(d.machine_basis_json, '$.prs') p
          UNION ALL
          SELECT json_extract(n.value, '$.repoIdentityKey'),
                 json_extract(n.value, '$.headSha')
            FROM json_each(d.machine_basis_json, '$.nestedReviews.entries') n
        ) frozen
        WHERE frozen.repo_identity = lower(cr.target_repo_identity)
          AND frozen.head_sha = lower(cr.target_pr_head_sha)
      )
  ) THEN 1 ELSE 0 END AS has_hit,
  CASE WHEN EXISTS (
    SELECT 1 FROM json_each(d.machine_basis_json, '$.prs') p
    WHERE json_type(p.value, '$.repoIdentityKey') = 'null'
  ) THEN 1 ELSE 0 END AS has_incomparable
FROM docs_cards d;

CREATE TEMP TABLE nested_run AS
SELECT
  run_id,
  CASE WHEN MAX(has_hit) = 1 THEN 'hit'
       WHEN MAX(has_incomparable) = 1 THEN 'incomparable'
       ELSE 'clear' END AS status
FROM nested_card
GROUP BY run_id;

CREATE TEMP TABLE report_output (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  numerator INTEGER,
  denominator INTEGER,
  detail TEXT
);

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'cohort_actions', COUNT(*), COUNT(*), 'founder action population' FROM cohort_all;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'cohort_runs', COUNT(DISTINCT run_id), COUNT(DISTINCT run_id), 'distinct non-deadletter runs' FROM cohort_all WHERE run_id IS NOT NULL;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'lost_actions', COALESCE(SUM(action = 'lost'), 0), COUNT(*), 'deadletter founder actions' FROM cohort_all;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'holder_ambiguous', COALESCE(SUM(action = 'rework' AND holder_count <> 1), 0), COUNT(*), 'rework actions without exactly one holder' FROM cohort_all;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'binding_mismatch', COALESCE(SUM(binding_ok = 0 AND action <> 'lost'), 0), COUNT(*), 'bound action mismatch' FROM cohort_all;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'duplicate_verdict', COALESCE(SUM(verdict_match_count >= 2), 0), COUNT(*), 'actions with duplicate verdicts' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'missing_verdict', COALESCE(SUM(verdict_match_count = 0), 0), COUNT(*), 'actions without a verdict' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'docs_cards', (SELECT COUNT(*) FROM docs_cards), COUNT(*), 'machine docs-only cards' FROM cohort_all;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'eligible_docs_cards', (SELECT COUNT(*) FROM eligible_docs_cards), COUNT(*), 'docs cards with a current declaration' FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'docs_runs', COUNT(*), COUNT(*), 'distinct machine docs-only runs' FROM docs_runs;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'eligible_docs_runs', (SELECT COUNT(*) FROM eligible_docs_runs), COUNT(*), 'declared docs-only run population' FROM docs_runs;

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'line1_machine_class', COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1), 0), COUNT(*), 'coverage line 1' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'line2_human_class', COALESCE(SUM(action_binding_ok = 1 AND declaration_ok = 1), 0), COUNT(*), 'coverage line 2' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'line3_strength_two', COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1 AND s2_ok = 1), 0), COUNT(*), 'coverage line 3' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'line4_founder_action', COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1), 0), COUNT(*), 'coverage line 4' FROM acts;

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'status',
       CASE WHEN
         COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1), 0) = COUNT(*)
         AND COALESCE(SUM(action_binding_ok = 1 AND declaration_ok = 1), 0) = COUNT(*)
         AND COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1 AND s2_ok = 1), 0) = COUNT(*)
         AND COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1), 0) = COUNT(*)
       THEN 'TABLE_VALID'
       ELSE 'TABLE_VOID: ' || rtrim(
         CASE WHEN COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1), 0) <> COUNT(*) THEN 'line1,' ELSE '' END ||
         CASE WHEN COALESCE(SUM(action_binding_ok = 1 AND declaration_ok = 1), 0) <> COUNT(*) THEN 'line2,' ELSE '' END ||
         CASE WHEN COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1 AND mirror_ok = 1 AND s2_ok = 1), 0) <> COUNT(*) THEN 'line3,' ELSE '' END ||
         CASE WHEN COALESCE(SUM(action_binding_ok = 1 AND verdict_ok = 1), 0) <> COUNT(*) THEN 'line4,' ELSE '' END,
         ',')
       END,
       COUNT(*), COUNT(*), 'all four coverage lines must equal the cohort'
FROM acts;

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'N1_founder_authored_rework',
       COUNT(DISTINCT CASE WHEN verdict = 'rework' AND founder_authored = 1 THEN run_id END),
       (SELECT COUNT(*) FROM eligible_docs_runs),
       'machine docs-only runs the founder herself sent back'
FROM eligible_docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'N2_founder_authority_rework',
       COUNT(DISTINCT CASE WHEN e.verdict = 'rework' AND r.authority = 'founder' THEN e.run_id END),
       (SELECT COUNT(*) FROM eligible_docs_runs),
       'machine docs-only runs sent back under founder authority'
FROM eligible_docs_cards e
LEFT JOIN workflow_rework_request r ON r.request_id = e.verdict_request_id;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'N1_release_threshold', 0, COUNT(*),
       'precommitted threshold: N1 must be 0 / full eligible population'
FROM eligible_docs_runs;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'N2_release_threshold', 0, COUNT(*),
       'precommitted threshold: N2 must be 0 / full eligible population'
FROM eligible_docs_runs;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'status',
       CASE
         WHEN EXISTS (SELECT 1 FROM report_output WHERE name GLOB 'TABLE_VOID:*')
           THEN 'RELEASE_HOLD: incomplete_coverage'
         WHEN n1.denominator = 0 THEN 'RELEASE_HOLD: no_population'
         WHEN n1.numerator > 0 AND n2.numerator > 0
           THEN 'RELEASE_HOLD: N1_nonzero,N2_nonzero'
         WHEN n1.numerator > 0 THEN 'RELEASE_HOLD: N1_nonzero'
         WHEN n2.numerator > 0 THEN 'RELEASE_HOLD: N2_nonzero'
         ELSE 'RELEASE_CANDIDATE_ONLY: thresholds_met'
       END,
       0, n1.denominator,
       'precommitted only: N1 and N2 must each be 0 / full eligible population; this report never merges'
FROM report_output n1
JOIN report_output n2 ON n2.name = 'N2_founder_authority_rework'
WHERE n1.name = 'N1_founder_authored_rework';
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'N2_wide_all_rework',
       COUNT(DISTINCT CASE WHEN e.verdict = 'rework' THEN e.run_id END),
       (SELECT COUNT(*) FROM eligible_docs_runs),
       'all machine docs-only rework including Lead/operator'
FROM eligible_docs_cards e;

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'detail', 'N3', 1, (SELECT COUNT(*) FROM eligible_docs_runs),
       json_object(
         'run_id', e.run_id,
         'issue_id', e.issue_id,
         'question_id', e.holder_question_id,
         'pr_number', e.verdict_pr_number,
         'repo_identity', e.verdict_repo_identity,
         'head_sha', e.verdict_head_sha,
         'authority', r.authority,
         'founder_feedback_text', CASE r.authority
           WHEN 'founder' THEN r.founder_feedback_verbatim
           ELSE json_extract(r.founder_quote_json, '$.text') END,
         'lead_feedback', r.lead_feedback,
         'recorded_at', e.recorded_at
       )
FROM eligible_docs_cards e
JOIN workflow_rework_request r ON r.request_id = e.verdict_request_id
WHERE e.verdict = 'rework' AND e.founder_authored = 1
  AND e.action_key = (
    SELECT e2.action_key
    FROM eligible_docs_cards e2
    JOIN workflow_rework_request r2 ON r2.request_id = e2.verdict_request_id
    WHERE e2.run_id = e.run_id
      AND e2.verdict = 'rework'
      AND e2.founder_authored = 1
    ORDER BY e2.recorded_at, e2.action_key
    LIMIT 1
  )
ORDER BY e.run_id, e.action_key;

INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'undeclared_docs_cards', COALESCE(SUM(declared_class IS NULL), 0), COUNT(*), 'docs-only cards without declaration' FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'declaration_after_verdict', COALESCE(SUM(declared_class IS NOT NULL AND julianday(declared_at) > julianday(recorded_at)), 0), COUNT(*), 'late declarations, reported but accepted' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'machine_unknown', COALESCE(SUM(machine_class = 'unknown'), 0), COUNT(*), 'unknown machine classifications' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'strength_two_no_ledger_row', COALESCE(SUM(s2_row_count = 0 AND s2_other_head_row_count = 0), 0), COUNT(*), 'docs cards without any strength-two row' FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'strength_two_other_head_only', COALESCE(SUM(s2_row_count = 0 AND s2_other_head_row_count > 0), 0), COUNT(*), 'exact head missing while another head is recorded' FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'scope_unresolved', COALESCE(SUM(machine_reason = 'scope_unresolved'), 0), COUNT(*), 'machine line 1 binding failures' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'strength_two_post_verdict_rows',
       (SELECT COUNT(*) FROM strength_two_evidence_record s JOIN docs_cards d
          ON s.run_id = d.observation_run_id
         AND s.target_repo_identity = d.observation_repo_identity
         AND s.head_sha = d.observation_head_sha
         AND julianday(s.recorded_at) > julianday(d.observed_at)),
       COUNT(*), 'strength-two rows added after the observed verdict'
FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'operator_verdicts', COALESCE(SUM(json_extract(author_evidence_json, '$.kind') = 'operator'), 0), COUNT(*), 'operator-attributed founder-gate verdicts' FROM acts;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'verdicts_before_receipt',
       COALESCE(SUM(julianday(recorded_at) < julianday((SELECT applied_at FROM state_store_migration WHERE migration_id = 'fly-2398-shadow-observation-v1'))), 0),
       COUNT(*), 'background verdicts predating shadow table availability'
FROM workflow_founder_gate_verdict;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'snapshot_age_over_30s_proxy',
       COALESCE(SUM(machine_declared_max_snapshot_age_ms > 30000), 0), COUNT(*),
       '不等价于误判单数,精确数需 PR head 变更事件台账'
FROM docs_cards;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'nested_post_observation_hit', COALESCE(SUM(status = 'hit'), 0), COUNT(*), 'upper-bound proxy; hit outranks incomparable' FROM nested_run;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'nested_post_observation_incomparable', COALESCE(SUM(status = 'incomparable'), 0), COUNT(*), 'identity key unavailable and no card hit' FROM nested_run;
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'nested_post_observation_clear', COALESCE(SUM(status = 'clear'), 0), COUNT(*), 'no post-observation pair detected' FROM nested_run;

CREATE TEMP TABLE declared_classes(value TEXT PRIMARY KEY);
INSERT INTO declared_classes VALUES ('pure_docs'), ('config_only'), ('single_point_change'), ('other_code');
CREATE TEMP TABLE machine_classes(value TEXT PRIMARY KEY);
INSERT INTO machine_classes VALUES ('docs_only'), ('ship_relevant'), ('unknown');
INSERT INTO report_output(kind, name, numerator, denominator, detail)
SELECT 'metric', 'matrix_' || dc.value || '_x_' || mc.value,
       (SELECT COUNT(*) FROM acts a
         WHERE a.declared_class = dc.value AND a.machine_class = mc.value),
       (SELECT COUNT(*) FROM acts), 'human x machine card matrix'
FROM declared_classes dc CROSS JOIN machine_classes mc
ORDER BY dc.value, mc.value;

SELECT json_object(
  'kind', kind,
  'name', name,
  'numerator', numerator,
  'denominator', denominator,
  'detail', detail
)
FROM report_output
ORDER BY seq;
