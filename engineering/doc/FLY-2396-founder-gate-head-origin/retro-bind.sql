-- FLY-2396 retro report: bind legacy founder-gate verdicts to exact head.
-- Read-only. Run on an immutable copy:
--   sqlite3 -header "file:/path/teamlead-copy.db?immutable=1" < retro-bind.sql
-- No time-window guessing: every join is an equality on existing keys.
-- Spec-frozen set = the 55 rework rows with requested_at <= 2026-09-03T21:28:57.010Z
-- (PR #1063 build-issues.md §B2 counted 55 at that point).

.mode column

-- ---------------------------------------------------------------------------
-- 0. Spec repro (expected: every founder_gate node has NULL execution_id; 0 joins)
-- ---------------------------------------------------------------------------
SELECT 'repro_gate_execution_null' AS metric,
       SUM(execution_id IS NULL) AS null_cnt, COUNT(*) AS total
  FROM workflow_run_node WHERE node_id = 'founder_gate';

SELECT 'repro_rework_join_execution' AS metric, COUNT(*) AS joined
  FROM workflow_rework_request r
  LEFT JOIN workflow_run_node n
    ON n.run_id = r.run_id AND n.node_id = r.source_node_id AND n.attempt = r.source_attempt
 WHERE r.authority = 'founder' AND r.source_node_id = 'founder_gate'
   AND n.execution_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Rework verdicts (打回): holder for (run_id, 'founder_gate', source_attempt)
--    is the head the founder was shown. Must be exactly one holder row.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS temp.rework_bind;
CREATE TEMP TABLE rework_bind AS
SELECT r.request_id,
       r.run_id,
       r.requested_at,
       r.source_attempt,
       (SELECT COUNT(*) FROM workflow_gate_holder h
         WHERE h.run_id = r.run_id AND h.gate_node_id = 'founder_gate'
           AND h.attempt = r.source_attempt) AS holder_count,
       (SELECT h.head_sha FROM workflow_gate_holder h
         WHERE h.run_id = r.run_id AND h.gate_node_id = 'founder_gate'
           AND h.attempt = r.source_attempt LIMIT 1) AS holder_head,
       (SELECT h.question_id FROM workflow_gate_holder h
         WHERE h.run_id = r.run_id AND h.gate_node_id = 'founder_gate'
           AND h.attempt = r.source_attempt LIMIT 1) AS question_id
  FROM workflow_rework_request r
 WHERE r.authority = 'founder' AND r.source_node_id = 'founder_gate'
   AND julianday(r.requested_at) < julianday(:legacy_cutoff)
   AND NOT EXISTS (
         SELECT 1 FROM workflow_founder_gate_verdict v
          WHERE v.rework_request_id = r.request_id
       );

DROP TABLE IF EXISTS temp.rework_resolved;
CREATE TEMP TABLE rework_resolved AS
SELECT b.*,
       CASE WHEN b.holder_count = 1
                  AND length(b.holder_head) = 40
                  AND b.holder_head NOT GLOB '*[^0-9a-f]*'
            THEN b.holder_head END AS head_sha,
       (SELECT p.pr_number FROM workflow_node_pr_binding p
         WHERE p.run_id = b.run_id AND p.head_sha = b.holder_head AND b.holder_count = 1 LIMIT 1) AS pr_number,
       COALESCE(
         (SELECT s.probe_repo_slug FROM workflow_ship_target_binding s
           WHERE s.approve_question_id = b.question_id LIMIT 1),
         (SELECT p.probe_repo_slug FROM workflow_node_pr_binding p
           WHERE p.run_id = b.run_id AND p.head_sha = b.holder_head LIMIT 1)) AS repo,
       b.requested_at <= '2026-09-03T21:28:57.010Z' AS in_spec55
  FROM rework_bind b;

SELECT 'rework_spec55' AS scope,
       COUNT(*) AS total,
       SUM(head_sha IS NOT NULL) AS bound_head,
       SUM(head_sha IS NOT NULL AND pr_number IS NOT NULL AND repo IS NOT NULL) AS bound_repo_pr_head
  FROM rework_resolved WHERE in_spec55;

SELECT 'rework_legacy_all' AS scope,
       COUNT(*) AS total,
       SUM(head_sha IS NOT NULL) AS bound_head,
       SUM(head_sha IS NOT NULL AND pr_number IS NOT NULL AND repo IS NOT NULL) AS bound_repo_pr_head
  FROM rework_resolved;

-- Rows that do not bind to a full (repo, pr_number, head_sha) triple, with why.
SELECT 'rework_unbound' AS scope, substr(run_id, 1, 8) AS run, requested_at,
       holder_count, length(holder_head) AS holder_head_len, pr_number, repo
  FROM rework_resolved
 WHERE NOT (head_sha IS NOT NULL AND pr_number IS NOT NULL AND repo IS NOT NULL)
 ORDER BY requested_at;

-- Post-cutoff founder decisions that were accepted by a legacy/non-land path
-- but have no exact-head ledger row. Keep this population explicit even when
-- empty: absence from the ledger is unknown evidence, never a clean zero.
DROP TABLE IF EXISTS temp.founder_verdict_unrecorded_post_cutoff;
CREATE TEMP TABLE founder_verdict_unrecorded_post_cutoff AS
SELECT 'rework' AS verdict_kind,
       r.request_id AS source_identity,
       r.requested_at AS occurred_at
  FROM workflow_rework_request r
 WHERE r.authority IN ('founder','lead')
   AND r.source_node_id = 'founder_gate'
   AND julianday(r.requested_at) >= julianday(:legacy_cutoff)
   AND NOT EXISTS (
         SELECT 1 FROM workflow_founder_gate_verdict v
          WHERE v.rework_request_id = r.request_id
       )
UNION ALL
SELECT 'approval' AS verdict_kind,
       CAST(c.id AS TEXT) AS source_identity,
       MIN(s.applied_at) AS occurred_at
  FROM workflow_claims c
  JOIN workflow_source_receipt s ON s.claim_id = c.id
 WHERE c.decision_kind = 'founder_decision'
   AND c.predicate = 'founder_approved'
   AND c.issuer_kind = 'founder_challenge'
   AND julianday(s.applied_at) >= julianday(:legacy_cutoff)
   AND NOT EXISTS (
         SELECT 1 FROM workflow_founder_gate_verdict v
          WHERE v.claim_id = c.id
       )
 GROUP BY c.id;

SELECT 'founder_verdict_unrecorded_post_cutoff' AS scope,
       COUNT(*) AS total,
       COALESCE(SUM(verdict_kind = 'approval'), 0) AS approvals,
       COALESCE(SUM(verdict_kind = 'rework'), 0) AS reworks,
       'missing exact-head ledger = unknown' AS reason
  FROM founder_verdict_unrecorded_post_cutoff;

SELECT 'founder_verdict_unrecorded_detail' AS scope,
       verdict_kind, source_identity, occurred_at
  FROM founder_verdict_unrecorded_post_cutoff
 ORDER BY occurred_at, verdict_kind, source_identity;

-- ---------------------------------------------------------------------------
-- 2. Pass verdicts (过卡): founder_gate node rows in state 'done'.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS temp.pass_resolved;
CREATE TEMP TABLE pass_resolved AS
SELECT n.run_id, n.attempt, n.ended_at,
       (SELECT COUNT(*) FROM workflow_gate_holder h
         WHERE h.run_id = n.run_id AND h.gate_node_id = 'founder_gate' AND h.attempt = n.attempt) AS holder_count,
       (SELECT h.head_sha FROM workflow_gate_holder h
         WHERE h.run_id = n.run_id AND h.gate_node_id = 'founder_gate' AND h.attempt = n.attempt LIMIT 1) AS holder_head,
       (SELECT h.authority_mode FROM workflow_gate_holder h
         WHERE h.run_id = n.run_id AND h.gate_node_id = 'founder_gate' AND h.attempt = n.attempt LIMIT 1) AS authority_mode
  FROM workflow_run_node n
 WHERE n.node_id = 'founder_gate' AND n.state = 'done';

SELECT 'pass_today' AS scope,
       COUNT(*) AS total,
       SUM(holder_count = 1 AND length(holder_head) = 40) AS bound_head,
       SUM(holder_count = 1 AND EXISTS (
             SELECT 1 FROM workflow_node_pr_binding p
              WHERE p.run_id = pass_resolved.run_id AND p.head_sha = pass_resolved.holder_head)) AS bound_repo_pr_head,
       SUM(authority_mode <> 'land') AS non_land_subjects
  FROM pass_resolved;

-- ---------------------------------------------------------------------------
-- 3. founder_authored for legacy rows: NEVER inferred from text.
--    Every legacy row is 未判定 unless a human attestation exists in
--    legacy-attestation.json (loaded here as a temp table by the runner).
--    Report format fixed by Lead (2026-09-06): "63 条: N attested / M 未判定 / 0 猜测".
-- ---------------------------------------------------------------------------
SELECT 'founder_authored_legacy' AS scope,
       COUNT(*) AS total,
       SUM(a.founder_authored IS NOT NULL) AS attested,
       SUM(a.founder_authored IS NULL) AS undetermined,
       0 AS guessed
  FROM rework_resolved r
  LEFT JOIN legacy_attestation a
    ON r.run_id LIKE a.run_id_prefix || '%' AND r.requested_at = a.requested_at;

-- Positive controls: expected 1,1,0,0,0 in this order.
SELECT 'positive_control' AS scope, a.run_id_prefix, a.founder_authored,
       substr(r.head_sha, 1, 8) AS head, r.pr_number, r.repo
  FROM legacy_attestation a
  JOIN rework_resolved r
    ON r.run_id LIKE a.run_id_prefix || '%' AND r.requested_at = a.requested_at
 ORDER BY a.ordinal;
