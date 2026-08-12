#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly1686-audit.XXXXXX")"
FIXTURE_DB="$FIXTURE_DIR/teamlead.db"
RESULT_JSON="$FIXTURE_DIR/result.json"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

cd "$REPO_ROOT"

FIXTURE_DB="$FIXTURE_DB" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
import { buildWorkflowRunSnapshotV1 } from "./packages/teamlead/dist/workflow-run-snapshot.js";

const db = new DatabaseSync(process.env.FIXTURE_DB);
db.exec(`
  CREATE TABLE workflow_run (
    run_id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    current_node_id TEXT NOT NULL,
    snapshot TEXT,
    status TEXT NOT NULL,
    engine_owned INTEGER NOT NULL
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
    head_sha TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    receipt_id TEXT
  );
  CREATE TABLE workflow_gate_holder (
    run_id TEXT NOT NULL,
    gate_node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    question_id TEXT,
    state TEXT NOT NULL,
    carrier_binding_state TEXT,
    authority_mode TEXT
  );
  CREATE TABLE workflow_pr_manifest (
    run_id TEXT NOT NULL,
    current_revision INTEGER,
    sealed_at TEXT
  );
  CREATE TABLE workflow_run_event (
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    event_uid TEXT
  );
  CREATE TABLE workflow_ship_target_binding (
    run_id TEXT NOT NULL,
    approve_question_id TEXT,
    superseded_at TEXT,
    worktree_binding_generation TEXT
  );
  CREATE TABLE sessions (
    execution_id TEXT,
    pr_number INTEGER
  );
`);

const snapshot = JSON.stringify(
  buildWorkflowRunSnapshotV1({
    template: { id: "fixture", revision: 1 },
    manifest: {
      schema_version: 1,
      manifest_variant: "land_v1",
      nodes: [
        { id: "build", type: "implement", vendor: "codex", model: "gpt-5.6-sol" },
        { id: "verify", type: "qa", vendor: "claude", model: "claude-opus-5" },
        { id: "approval", type: "gate" },
        { id: "publish", type: "land", execution: "engine" },
      ],
      edges: [
        { id: "built", from: "build", to: "verify", condition: "implement_done" },
        { id: "passed", from: "verify", to: "approval", condition: "qa_pass" },
        { id: "approved", from: "approval", to: "publish", condition: "founder_approved" },
      ],
      loops: [
        {
          id: "verify_retry",
          from: "verify",
          to: "build",
          loop_when: "qa_fail",
          exit_when: "qa_pass",
          max_iterations: 3,
          on_limit: "escalate",
        },
        {
          id: "founder_feedback",
          from: "approval",
          to: "build",
          loop_when: "founder_feedback_kickback",
          exit_when: "founder_approved",
          max_iterations: 3,
          on_limit: "escalate",
        },
      ],
      approval_gate: { node: "approval", predicate: "founder_approved" },
      terminal_node: { node: "publish" },
      ship_claims: ["qa_passed", "founder_approved"],
    },
  }),
);

const insertRun = db.prepare(
  "INSERT INTO workflow_run VALUES (?, 'flywheel', ?, ?, ?, 'active', 1)",
);
const insertNode = db.prepare(
  "INSERT INTO workflow_run_node VALUES (?, ?, 1, ?, ?)",
);
for (const fixture of [
  { run: "unconsumed", current: "verify" },
  { run: "legacy-gate", current: "approval", owner: "build" },
  { run: "stale-sealed", current: "verify", sealed: true },
  { run: "gate-entry", current: "approval", owner: "verify" },
]) {
  insertRun.run(fixture.run, `FLY-${fixture.run}`, fixture.current, snapshot);
  for (const node of ["build", "verify", "approval"])
    insertNode.run(fixture.run, node, node === fixture.current ? "active" : "done", `${fixture.run}-${node}`);
  if (fixture.owner) {
    db.prepare("INSERT INTO workflow_node_pr_binding VALUES (?, ?, 1, ?, 42, ?)").run(
      fixture.run,
      fixture.owner,
      "a".repeat(40),
      `receipt-${fixture.run}`,
    );
  }
  if (fixture.sealed)
    db.prepare("INSERT INTO workflow_pr_manifest VALUES (?, 1, '2026-08-11T00:00:00Z')").run(fixture.run);
}
db.close();
NODE

set +e
node scripts/fly1686-gate-entry-audit.mjs \
  --db "$FIXTURE_DB" --mode forward --json >"$RESULT_JSON"
audit_status=$?
set -e

if [[ "$audit_status" -ne 2 ]]; then
  echo "expected disposition exit 2, got $audit_status" >&2
  exit 1
fi

RESULT_JSON="$RESULT_JSON" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const result = JSON.parse(readFileSync(process.env.RESULT_JSON, "utf8"));
assert.equal(result.scanned, 4);
assert.equal(result.requiresDisposition, 2);
const classes = new Map(result.rows.map((row) => [row.runId, row.classification]));
assert.equal(classes.get("unconsumed"), "unconsumed_before_gate");
assert.equal(classes.get("legacy-gate"), "already_in_gate_legacy_binding");
assert.equal(classes.get("stale-sealed"), "stale_sealed_before_gate");
assert.equal(classes.get("gate-entry"), "gate_entry_authority_current");
NODE

echo "PASS: FLY-1686 gate-entry audit fixture"
