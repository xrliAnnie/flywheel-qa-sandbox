import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectQaIdentity } from "../lib/qa-fly-2456-qa-identity.mjs";

const require = createRequire(
		new URL("../../packages/flywheel-comm/package.json", import.meta.url),
	),
	Database = require("better-sqlite3");
function fixture(t, change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-qa-id-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "state.db"),
		commPath = join(dir, "comm.db"),
		db = new Database(dbPath),
		comm = new Database(commPath);
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const name of ["sessions", "workflow_run", "workflow_run_node"])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	const commSource = readFileSync(
		new URL("../../packages/flywheel-comm/src/db.ts", import.meta.url),
		"utf8",
	);
	comm.exec(
		commSource.match(
			/CREATE TABLE IF NOT EXISTS runner_workflow_activation \([\s\S]*?\n\s*\)/,
		)[0],
	);
	db.exec(
		"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES('qa-exec','FLY-1','test-slot-4','running');INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES('run','FLY-1','test-slot-4');INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES('run','qa',1,'running','qa-exec')",
	);
	comm.exec(
		"INSERT INTO runner_workflow_activation(execution_id,epoch,activation_id,run_id,node_id,attempt,output_credential,submission_credential,context_json,context_digest,created_at) VALUES('qa-exec',1,'activation','run','qa',1,'out','secret','{}','digest','2026-09-09T00:00:00Z')",
	);
	change(db, comm);
	db.close();
	comm.close();
	for (const path of [dbPath, commPath])
		writeFileSync(
			`${path}.meta.json`,
			JSON.stringify({
				observedAt: "2026-09-09T00:02:00Z",
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
			}),
		);
	const manifest = {
		config: { slot: 4, issues: { B1: "FLY-1" } },
		steps: {
			start: {
				intent: { detail: { kind: "start", label: "B1" } },
				receipt: {
					result: { executionId: "b1", workflowRunId: "run", issueId: "FLY-1" },
				},
			},
			qa: {
				intent: {
					createdAt: "2026-09-09T00:01:00Z",
					detail: { kind: "qa-identity", label: "B1", issueId: "FLY-1" },
				},
			},
		},
	};
	return {
		manifest,
		step: "qa",
		dbPath,
		commPath,
		now: Date.parse("2026-09-09T00:03:00Z"),
	};
}
test("QA identity derives from engine attempt1 and exact activation without credentials", (t) => {
	const f = fixture(t),
		r = inspectQaIdentity(f);
	assert.equal(r.action, "adopt-existing");
	assert.equal(r.result.executionId, "qa-exec");
	assert.equal(r.result.source, "workflow-engine");
	assert.doesNotMatch(JSON.stringify(r), /secret|output_credential/);
	f.manifest.steps.qa.receipt = { result: r.result };
	assert.equal(inspectQaIdentity(f).action, "replay");
});
test("missing or mismatched engine identity is never a manual start permission", (t) => {
	for (const change of [
		(db) => db.exec("DELETE FROM workflow_run_node"),
		(db) => db.exec("UPDATE sessions SET issue_id='FLY-2'"),
		(_db, comm) =>
			comm.exec("UPDATE runner_workflow_activation SET run_id='other'"),
	])
		assert.equal(inspectQaIdentity(fixture(t, change)).action, "conflict");
});
test("QA adoption requires a timestamped intent and rejects contradictory receipts", (t) => {
	const f = fixture(t);
	delete f.manifest.steps.qa.intent.createdAt;
	assert.equal(inspectQaIdentity(f).action, "conflict");
	const g = fixture(t);
	g.manifest.steps.qa.receipt = { result: { executionId: "forged" } };
	assert.equal(inspectQaIdentity(g).action, "conflict");
});
test("QA adoption rejects physical schema substitution and duplicate activation", (t) => {
	for (const change of [
		(db) =>
			db.exec(
				"ALTER TABLE workflow_run_node RENAME TO hidden;CREATE VIEW workflow_run_node AS SELECT * FROM hidden",
			),
		(_db, comm) =>
			comm.exec(
				"INSERT INTO runner_workflow_activation SELECT execution_id,epoch+1,'second',run_id,node_id,attempt,output_credential,submission_credential,context_json,context_digest,created_at FROM runner_workflow_activation",
			),
	])
		assert.equal(inspectQaIdentity(fixture(t, change)).action, "conflict");
});
test("unbound pending nodes do not invalidate the selected QA identity", (t) => {
	const f = fixture(t, (db) =>
		db.exec(
			"INSERT INTO workflow_run_node(run_id,node_id,attempt,state) VALUES('run','ship',1,'pending')",
		),
	);
	assert.equal(inspectQaIdentity(f).action, "adopt-existing");
});
