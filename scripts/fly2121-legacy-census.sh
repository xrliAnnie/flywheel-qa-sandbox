#!/usr/bin/env bash
# FLY-2121: read-only retirement census for B-class execution fallbacks.
set -euo pipefail

db_path="${1:-${FLYWHEEL_STATE_DIR:-${FLYWHEEL_HOME:-${HOME}/.flywheel}}/teamlead.db}"
if [[ ! -r "$db_path" ]]; then
  echo "fly2121_legacy_census_database_unreadable:$db_path" >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "fly2121_legacy_census_sqlite3_missing" >&2
  exit 2
fi

invalid_json="$(sqlite3 -readonly -cmd '.timeout 5000' "$db_path" <<'SQL'
SELECT COUNT(*)
FROM workflow_run
WHERE engine_owned = 1
  AND status NOT IN (
    'completed','terminated','failed','blocked','timeout','canceled',
    'cancelled','rejected','deferred','shelved','approved'
  )
  AND snapshot IS NOT NULL
  AND json_valid(snapshot) = 0;
SQL
)"
if [[ "$invalid_json" != "0" ]]; then
  echo "fly2121_legacy_census_invalid_snapshot:$invalid_json" >&2
  exit 2
fi

sqlite3 -readonly -cmd '.timeout 5000' "$db_path" <<'SQL'
WITH nonterminal AS (
  SELECT *
  FROM workflow_run
  WHERE status NOT IN (
    'completed','terminated','failed','blocked','timeout','canceled',
    'cancelled','rejected','deferred','shelved','approved'
  )
), legacy_node_runs AS (
  SELECT DISTINCT run_id
  FROM nonterminal
  WHERE current_node_id IN ('design','produce','execute')
  UNION
  SELECT DISTINCT n.run_id
  FROM workflow_run_node n
  JOIN nonterminal r ON r.run_id = n.run_id
  WHERE n.node_id IN ('design','produce','execute')
), unpinned_agent_runs AS (
  SELECT DISTINCT r.run_id
  FROM nonterminal r
  WHERE r.engine_owned = 1
    AND (
      r.snapshot IS NULL
      OR json_extract(r.snapshot, '$.schema_version') = 1
      OR json_extract(r.snapshot, '$.schema_version') NOT IN (1, 2)
      OR EXISTS (
        SELECT 1
        FROM json_each(r.snapshot, '$.resolved.nodes') node
        WHERE json_type(node.value, '$.dispatch') = 'object'
          AND (
            json_type(node.value, '$.agent') IS NULL
            OR trim(COALESCE(json_extract(node.value, '$.agent.content'), '')) = ''
          )
      )
    )
), counts AS (
  SELECT
    (SELECT COUNT(*) FROM legacy_node_runs) AS legacy_node_runs,
    (SELECT COUNT(*) FROM unpinned_agent_runs) AS unpinned_agent_runs
)
SELECT json_object(
  'legacyNodeRuns', legacy_node_runs,
  'unpinnedAgentRuns', unpinned_agent_runs,
  'removable', json(CASE
    WHEN legacy_node_runs = 0 AND unpinned_agent_runs = 0 THEN 'true'
    ELSE 'false'
  END)
)
FROM counts;
SQL
