#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly1707-replay.XXXXXX")"
FIXTURE_DB="$FIXTURE_DIR/teamlead.db"
FIXTURE_REPO="$FIXTURE_DIR/repo"
RESULT_JSON="$FIXTURE_DIR/result.json"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

git init -q "$FIXTURE_REPO"
git -C "$FIXTURE_REPO" config user.name "FLY-1707 fixture"
git -C "$FIXTURE_REPO" config user.email "fly1707@example.invalid"
git -C "$FIXTURE_REPO" commit --allow-empty -qm reviewed
REVIEWED_HEAD="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
git -C "$FIXTURE_REPO" commit --allow-empty -qm advanced
ADVANCED_HEAD="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"

FIXTURE_DB="$FIXTURE_DB" REVIEWED_HEAD="$REVIEWED_HEAD" ADVANCED_HEAD="$ADVANCED_HEAD" \
  node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.FIXTURE_DB);
db.exec(`
  CREATE TABLE workflow_run (
    run_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    template_id TEXT,
    current_node_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workflow_run_node (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    execution_id TEXT
  );
  CREATE TABLE workflow_node_pr_binding (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    head_sha TEXT NOT NULL
  );
  CREATE TABLE codex_review_record (
    execution_id TEXT NOT NULL,
    target_pr_head_sha TEXT NOT NULL,
    status TEXT NOT NULL,
    approved_at TEXT
  );
`);

const fixtures = [
  { issue: "FLY-1645", target: "qa", targetAttempt: 1, exact: true },
  { issue: "FLY-1680", target: "implement", targetAttempt: 2, exact: true },
  { issue: "FLY-1614", target: "implement", targetAttempt: 2, exact: false },
  { issue: "FLY-1686", target: "implement", targetAttempt: 2, exact: false },
];
for (const [index, fixture] of fixtures.entries()) {
  const runId = `run-${fixture.issue}`;
  const executionId = `implement-${index}`;
  db.prepare("INSERT INTO workflow_run VALUES (?, ?, 'tpl_code', ?, 'terminated', '2026-08-11 07:00:00')")
    .run(runId, fixture.issue, fixture.target);
  db.prepare("INSERT INTO workflow_run_node VALUES (?, 'design', 1, 'done', ?)")
    .run(runId, `design-${index}`);
  db.prepare("INSERT INTO workflow_run_node VALUES (?, 'implement', 1, 'done', ?)")
    .run(runId, executionId);
  db.prepare("INSERT INTO workflow_run_node VALUES (?, ?, ?, 'pending', ?)")
    .run(runId, fixture.target, fixture.targetAttempt, executionId);
  db.prepare("INSERT INTO workflow_node_pr_binding VALUES (?, 'implement', 1, ?)")
    .run(runId, process.env.ADVANCED_HEAD);
  db.prepare("INSERT INTO codex_review_record VALUES (?, ?, 'approved', '2026-08-11 10:00:00')")
    .run(
      executionId,
      fixture.exact ? process.env.ADVANCED_HEAD : process.env.REVIEWED_HEAD,
    );
}
db.close();
NODE

cd "$REPO_ROOT"
node scripts/qa-fly-1707-incident-replay.mjs \
  --db "$FIXTURE_DB" --repo "$FIXTURE_REPO" --json >"$RESULT_JSON"

RESULT_JSON="$RESULT_JSON" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const result = JSON.parse(readFileSync(process.env.RESULT_JSON, "utf8"));
assert.equal(result.qualified, 4);
assert.deepEqual(
  result.rows.map((row) => [
    row.issueId,
    row.targetNodeId,
    row.designAttempts,
    row.newDesignAttempts,
  ]),
  [
    ["FLY-1645", "qa", 1, 0],
    ["FLY-1680", "implement", 1, 0],
    ["FLY-1614", "implement", 1, 0],
    ["FLY-1686", "implement", 1, 0],
  ],
);
assert.equal(result.rows.find((row) => row.issueId === "FLY-1614").lineage, "forward");
assert.equal(result.fly1614MutatedHeadRefused, true);
assert.match(result.caveat, /凭据重建/);
assert.match(result.caveat, /4\.1/);
NODE

set +e
node scripts/qa-fly-1707-incident-replay.mjs \
  --db "$HOME/.flywheel/teamlead.db" --repo "$FIXTURE_REPO" --json \
  >"$FIXTURE_DIR/guard.out" 2>"$FIXTURE_DIR/guard.err"
guard_status=$?
set -e
if [[ "$guard_status" -eq 0 ]] || ! grep -q "production_db_refused" "$FIXTURE_DIR/guard.err"; then
  echo "expected canonical production DB guard to fail closed" >&2
  exit 1
fi

set +e
pnpm exec tsx scripts/qa-fly-1707-incident-dispatcher.ts \
  --db "$HOME/.flywheel/teamlead.db" --repo "$FIXTURE_REPO" \
  >"$FIXTURE_DIR/dispatcher-guard.out" 2>"$FIXTURE_DIR/dispatcher-guard.err"
dispatcher_guard_status=$?
set -e
if [[ "$dispatcher_guard_status" -eq 0 ]] || \
  ! grep -q "production_db_refused" "$FIXTURE_DIR/dispatcher-guard.err"; then
  echo "expected incident dispatcher to refuse the canonical production DB" >&2
  exit 1
fi

echo "PASS: FLY-1707 incident replay fixture"
