import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	defaultShadowWindowStart,
	normalizeShadowInstant,
	renderFly2398ShadowTable,
	runFly2398ShadowTable,
} from "../fly-2398-shadow-table.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");
const roots = [];
const connections = [];

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "fly2398-shadow-table-"));
	roots.push(root);
	const path = join(root, "teamlead.db");
	const db = new Database(path);
	connections.push(db);
	db.pragma("journal_mode = WAL");
	db.pragma("wal_autocheckpoint = 0");
	db.exec(`
		CREATE TABLE state_store_migration (migration_id TEXT, applied_at TEXT);
		CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY, issue_id TEXT);
		CREATE TABLE workflow_run_node (run_id TEXT, execution_id TEXT);
		CREATE TABLE workflow_gate_holder (
			run_id TEXT, gate_node_id TEXT, attempt INTEGER, head_sha TEXT,
			question_id TEXT, authority_mode TEXT, subject_kind TEXT
		);
		CREATE TABLE workflow_claims (
			id INTEGER PRIMARY KEY, workflow_run_id TEXT, issued_at TEXT,
			decision_kind TEXT, predicate TEXT, issuer_kind TEXT, subject_kind TEXT,
			subject_digest TEXT, evidence TEXT, authority_id TEXT
		);
		CREATE TABLE workflow_rework_request (
			request_id TEXT PRIMARY KEY, run_id TEXT, requested_at TEXT,
			source_attempt INTEGER, authority TEXT, source_node_id TEXT,
			founder_feedback_verbatim TEXT, founder_quote_json TEXT, lead_feedback TEXT
		);
		CREATE TABLE workflow_source_deadletter (
			project TEXT, source_event_id TEXT, reason TEXT, at TEXT
		);
		CREATE TABLE workflow_founder_gate_verdict (
			verdict_id TEXT PRIMARY KEY, run_id TEXT, verdict TEXT, question_id TEXT,
			repo_identity TEXT, pr_number INTEGER, head_sha TEXT,
			rework_request_id TEXT, claim_id INTEGER, founder_authored INTEGER,
			author_evidence_json TEXT, recorded_at TEXT
		);
		CREATE TABLE auto_merge_shadow_observation (
			verdict_id TEXT PRIMARY KEY, run_id TEXT, question_id TEXT,
			repo_identity TEXT, pr_number INTEGER, head_sha TEXT, observed_at TEXT,
			machine_class TEXT, machine_reason TEXT,
			machine_declared_max_snapshot_age_ms INTEGER, machine_basis_json TEXT,
			s2_ran_status TEXT, s2_ran_reason TEXT, s2_record_status TEXT,
			s2_record_reason TEXT, s2_verdict TEXT, s2_basis_record_id TEXT,
			s2_row_count INTEGER, s2_other_head_row_count INTEGER
		);
		CREATE TABLE auto_merge_shadow_declaration (
			declaration_id TEXT PRIMARY KEY, question_id TEXT, run_id TEXT,
			declared_class TEXT, declared_by TEXT, discord_channel_id TEXT,
			discord_message_id TEXT, discord_author_user_id TEXT, message_ts TEXT,
			declaration_seq INTEGER, declared_at TEXT
		);
		CREATE TABLE strength_two_evidence_record (
			record_id TEXT PRIMARY KEY, run_id TEXT, target_repo_identity TEXT,
			head_sha TEXT, ran_status TEXT, ran_reason TEXT, record_status TEXT,
			record_reason TEXT, verdict TEXT, recorded_at TEXT
		);
		CREATE TABLE codex_review_record (
			execution_id TEXT, target_repo_identity TEXT, target_pr_head_sha TEXT,
			created_at TEXT
		);
		INSERT INTO state_store_migration VALUES
			('fly-2398-shadow-observation-v1', '2026-08-09T10:15:00.000Z');
	`);

	const runs = [
		["run-doc-approved", "FLY-1", "exec-doc-approved"],
		["run-doc-rework", "FLY-2", "exec-doc-rework"],
		["run-code", "FLY-3", "exec-code"],
		["run-mixed", "FLY-4", "exec-mixed"],
	];
	for (const [runId, issueId, executionId] of runs) {
		db.prepare("INSERT INTO workflow_run VALUES (?, ?)").run(runId, issueId);
		db.prepare("INSERT INTO workflow_run_node VALUES (?, ?)").run(
			runId,
			executionId,
		);
	}
	const actions = [
		{
			id: 1,
			runId: "run-doc-approved",
			question: "question-1",
			head: "a".repeat(40),
			time: "2026-08-10T01:00:00.000Z",
			action: "approved",
			machine: "docs_only",
			declared: "pure_docs",
			basis: { schemaVersion: 1, prs: [], nestedReviews: { entries: [] } },
		},
		{
			id: 2,
			runId: "run-doc-rework",
			question: "question-2",
			head: "b".repeat(40),
			time: "2026-08-11T02:00:00.000Z",
			action: "rework",
			machine: "docs_only",
			declared: "pure_docs",
			basis: { schemaVersion: 1, prs: [], nestedReviews: { entries: [] } },
		},
		{
			id: 3,
			runId: "run-code",
			question: "question-3",
			head: "c".repeat(40),
			time: "2026-08-12T03:00:00.000Z",
			action: "approved",
			machine: "ship_relevant",
			declared: "other_code",
			basis: { schemaVersion: 1, prs: [], nestedReviews: { entries: [] } },
		},
		{
			id: 4,
			runId: "run-mixed",
			question: "question-4",
			head: "d".repeat(40),
			time: "2026-08-13T04:00:00.000Z",
			action: "approved",
			machine: "docs_only",
			declared: "pure_docs",
			basis: { schemaVersion: 1, prs: [], nestedReviews: { entries: [] } },
		},
		{
			id: 5,
			runId: "run-mixed",
			question: "question-5",
			head: "e".repeat(40),
			time: "2026-08-14T05:00:00.000Z",
			action: "approved",
			machine: "docs_only",
			declared: "pure_docs",
			basis: {
				schemaVersion: 1,
				prs: [
					{ repoIdentityKey: null, expectedHead: null, snapshotHead: null },
				],
				nestedReviews: { entries: [] },
			},
		},
	];
	for (const action of actions) {
		db.prepare(
			`INSERT INTO workflow_gate_holder VALUES
			 (?, 'founder_gate', 1, ?, ?, 'land', 'git_head')`,
		).run(action.runId, action.head, action.question);
		let claimId = null;
		let requestId = null;
		if (action.action === "approved") {
			claimId = action.id;
			db.prepare(
				`INSERT INTO workflow_claims VALUES
			 (?, ?, ?, 'founder_decision', 'founder_approved', 'founder_challenge',
			  'git_head', ?, ?, ?)`,
			).run(
				action.id,
				action.runId,
				action.time.replace("T", " ").replace(".000Z", ""),
				action.head,
				JSON.stringify({ questionId: action.question }),
				action.question,
			);
		} else {
			requestId = "rework-2";
			db.prepare(
				`INSERT INTO workflow_rework_request VALUES
			 (?, ?, ?, 1, 'founder', 'founder_gate', ?, NULL, NULL)`,
			).run(
				requestId,
				action.runId,
				action.time,
				"Please revise the implementation.",
			);
		}
		const verdictId = `verdict-${action.id}`;
		db.prepare(
			`INSERT INTO workflow_founder_gate_verdict VALUES
			 (?, ?, ?, ?, '__main__', ?, ?, ?, ?, 1, ?, ?)`,
		).run(
			verdictId,
			action.runId,
			action.action,
			action.question,
			100 + action.id,
			action.head,
			requestId,
			claimId,
			JSON.stringify({ kind: "gate_response" }),
			action.time,
		);
		db.prepare(
			`INSERT INTO auto_merge_shadow_observation VALUES
			 (?, ?, ?, '__main__', ?, ?, ?, ?, ?, NULL, ?,
			  'unsatisfied', 'no_ledger_row', 'unsatisfied', 'no_ledger_row',
			  'unsatisfied', NULL, 0, 0)`,
		).run(
			verdictId,
			action.runId,
			action.question,
			100 + action.id,
			action.head,
			action.time,
			action.machine,
			action.machine === "docs_only" ? null : "primary_ship_relevant",
			JSON.stringify(action.basis),
		);
		db.prepare(
			`INSERT INTO auto_merge_shadow_declaration VALUES
			 (?, ?, ?, ?, 'flywheel-eng-lead', '12345678901234567', ?,
			  '32345678901234567', ?, 1, ?)`,
		).run(
			`declaration-${action.id}`,
			action.question,
			action.runId,
			action.declared,
			String(22345678901234560 + action.id),
			action.time,
			action.time,
		);
	}
	db.prepare(
		`INSERT INTO codex_review_record VALUES
		 ('exec-mixed', 'owner/new-repo', ?, '2026-08-13T04:00:01.000Z')`,
	).run("f".repeat(40));
	return { db, path };
}

function metric(report, name) {
	const row = report.rows.find(
		(candidate) => candidate.kind === "metric" && candidate.name === name,
	);
	assert.ok(row, `missing metric ${name}`);
	return row;
}

function tableStatus(report) {
	const row = report.rows.find((candidate) => candidate.kind === "status");
	assert.ok(row, "missing table status");
	return row.name;
}

function releaseStatus(report) {
	const row = report.rows.find(
		(candidate) =>
			candidate.kind === "status" && candidate.name.startsWith("RELEASE_"),
	);
	assert.ok(row, "missing release status");
	return row.name;
}

async function reportAfter(sql) {
	const { db, path } = createFixture();
	db.exec(sql);
	return runFly2398ShadowTable({
		db: path,
		expectedForeignKeyBaseline: [],
	});
}

test.afterEach(() => {
	for (const connection of connections.splice(0)) connection.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("normalizes only canonical UTC milliseconds and derives the next UTC midnight", () => {
	assert.equal(
		normalizeShadowInstant("2026-08-10T00:00:00.000Z"),
		"2026-08-10T00:00:00.000Z",
	);
	for (const invalid of [
		"2026-08-10T00:00:00Z",
		"2026-08-10T00:00:00.000+00:00",
		"2026-08-10T00:00:00.000Zjunk",
		"2026-02-30T00:00:00.000Z",
	]) {
		assert.throws(() => normalizeShadowInstant(invalid), /canonical UTC/);
	}
	assert.equal(
		defaultShadowWindowStart("2026-08-09T10:15:00.000Z"),
		"2026-08-10T00:00:00.000Z",
	);
});

test("backs up live WAL, independently recomputes all four lines and preserves hit priority", async () => {
	const { path } = createFixture();
	const before = sha256(path);
	const progress = [];
	const report = await runFly2398ShadowTable({
		db: path,
		expectedForeignKeyBaseline: [],
		onProgress: (message) => progress.push(message),
	});
	assert.equal(report.windowStart, "2026-08-10T00:00:00.000Z");
	assert.equal(report.windowEnd, "2026-08-24T00:00:00.000Z");
	assert.equal(report.windowStartSource, "receipt_next_utc_midnight");
	const metrics = new Map(
		report.rows
			.filter((row) => row.kind === "metric")
			.map((row) => [row.name, `${row.numerator} / ${row.denominator}`]),
	);
	assert.equal(metrics.get("cohort_actions"), "5 / 5");
	assert.equal(metrics.get("cohort_runs"), "4 / 4");
	assert.equal(metrics.get("line1_machine_class"), "5 / 5");
	assert.equal(metrics.get("line2_human_class"), "5 / 5");
	assert.equal(metrics.get("line3_strength_two"), "5 / 5");
	assert.equal(metrics.get("line4_founder_action"), "5 / 5");
	assert.equal(metrics.get("docs_cards"), "4 / 5");
	assert.equal(metrics.get("eligible_docs_runs"), "3 / 3");
	assert.equal(metrics.get("N1_founder_authored_rework"), "1 / 3");
	assert.equal(metrics.get("N2_founder_authority_rework"), "1 / 3");
	assert.equal(metrics.get("N1_release_threshold"), "0 / 3");
	assert.equal(metrics.get("N2_release_threshold"), "0 / 3");
	assert.equal(metrics.get("N2_wide_all_rework"), "1 / 3");
	assert.equal(metrics.get("nested_post_observation_hit"), "1 / 3");
	assert.equal(metrics.get("nested_post_observation_incomparable"), "0 / 3");
	assert.equal(metrics.get("nested_post_observation_clear"), "2 / 3");
	assert.equal(
		metric(report, "snapshot_age_over_30s_proxy").detail,
		"不等价于误判单数,精确数需 PR head 变更事件台账",
	);
	assert.ok(
		report.rows.some(
			(row) => row.kind === "status" && row.name === "TABLE_VALID",
		),
	);
	assert.ok(
		report.rows.some(
			(row) =>
				row.kind === "status" &&
				row.name === "RELEASE_HOLD: N1_nonzero,N2_nonzero" &&
				row.detail ===
					"precommitted only: N1 and N2 must each be 0 / full eligible population; this report never merges",
		),
	);
	assert.equal(
		report.rows.filter((row) => row.kind === "detail" && row.name === "N3")
			.length,
		1,
	);
	assert.deepEqual(progress, [
		"creating WAL-safe online backup",
		"online backup complete; opening immutable snapshot",
		"report complete",
	]);
	assert.equal(sha256(path), before, "the report mutated its source database");
});

test("keeps an empty population valid and renders every zero with its denominator", async () => {
	const { path } = createFixture();
	const report = await runFly2398ShadowTable({
		db: path,
		windowStart: "2026-08-25T00:00:00.000Z",
		windowEnd: "2026-09-08T00:00:00.000Z",
		expectedForeignKeyBaseline: [],
	});
	const fourLines = report.rows.filter(
		(row) => row.kind === "metric" && row.name.startsWith("line"),
	);
	assert.deepEqual(
		fourLines.map(({ numerator, denominator }) => [numerator, denominator]),
		[
			[0, 0],
			[0, 0],
			[0, 0],
			[0, 0],
		],
	);
	assert.ok(
		report.rows.some(
			(row) => row.kind === "status" && row.name === "TABLE_VALID",
		),
	);
	assert.ok(
		report.rows.some(
			(row) =>
				row.kind === "status" && row.name === "RELEASE_HOLD: no_population",
		),
	);
	const markdown = renderFly2398ShadowTable(report);
	assert.match(markdown, /0 \/ 0 \(no population\)/);
	assert.doesNotMatch(markdown, /\| 0 \|/);
});

test("voids the table when any of the four independent record lines is incomplete", async () => {
	const missingObservation = await reportAfter(
		"DELETE FROM auto_merge_shadow_observation WHERE verdict_id = 'verdict-1'",
	);
	assert.deepEqual(
		[
			metric(missingObservation, "line1_machine_class").numerator,
			metric(missingObservation, "line3_strength_two").numerator,
		],
		[4, 4],
	);
	assert.match(tableStatus(missingObservation), /line1.*line3/);
	assert.equal(
		releaseStatus(missingObservation),
		"RELEASE_HOLD: incomplete_coverage",
	);

	const missingDeclaration = await reportAfter(
		"DELETE FROM auto_merge_shadow_declaration WHERE question_id = 'question-1'",
	);
	assert.equal(metric(missingDeclaration, "line2_human_class").numerator, 4);
	assert.match(tableStatus(missingDeclaration), /line2/);
	const crossRunDeclaration = await reportAfter(`
		UPDATE auto_merge_shadow_declaration
		SET run_id = 'run-code'
		WHERE question_id = 'question-1'
	`);
	assert.equal(metric(crossRunDeclaration, "line2_human_class").numerator, 4);
	assert.match(tableStatus(crossRunDeclaration), /line2/);

	const lostAction = await reportAfter(`
		INSERT INTO workflow_source_deadletter VALUES
		 ('flywheel', 'founder-approval:lost-1', 'parse_failed', '2026-08-15T00:00:00.000Z')
	`);
	assert.deepEqual(
		[
			metric(lostAction, "lost_actions").numerator,
			metric(lostAction, "lost_actions").denominator,
			metric(lostAction, "line4_founder_action").numerator,
			metric(lostAction, "line4_founder_action").denominator,
		],
		[1, 6, 5, 6],
	);
	assert.match(tableStatus(lostAction), /line4/);
});

test("marks zero N1 and N2 as a candidate only and never as an automatic merge", async () => {
	const report = await reportAfter(
		"DELETE FROM workflow_rework_request WHERE request_id = 'rework-2'",
	);
	assert.equal(tableStatus(report), "TABLE_VALID");
	assert.equal(metric(report, "N1_founder_authored_rework").numerator, 0);
	assert.equal(metric(report, "N2_founder_authority_rework").numerator, 0);
	assert.equal(releaseStatus(report), "RELEASE_CANDIDATE_ONLY: thresholds_met");
	assert.doesNotMatch(releaseStatus(report), /auto.?merge/i);
});

test("voids mirrored observations and duplicate verdict actions without multiplying the cohort", async () => {
	const mirrorMismatch = await reportAfter(`
		UPDATE auto_merge_shadow_observation
		SET observed_at = '2026-08-10T01:00:01.000Z'
		WHERE verdict_id = 'verdict-1'
	`);
	assert.equal(metric(mirrorMismatch, "line1_machine_class").numerator, 4);
	assert.equal(metric(mirrorMismatch, "line3_strength_two").numerator, 4);
	assert.match(tableStatus(mirrorMismatch), /line1.*line3/);

	const duplicateVerdict = await reportAfter(`
		INSERT INTO workflow_founder_gate_verdict VALUES
		 ('verdict-duplicate', 'run-doc-approved', 'approved', 'question-1',
		  '__main__', 101, '${"a".repeat(40)}', NULL, 1, 1,
		  '{"kind":"gate_response"}', '2026-08-10T01:00:00.000Z')
	`);
	assert.deepEqual(
		[
			metric(duplicateVerdict, "cohort_actions").numerator,
			metric(duplicateVerdict, "duplicate_verdict").numerator,
			metric(duplicateVerdict, "line4_founder_action").numerator,
		],
		[5, 1, 4],
	);
	assert.match(tableStatus(duplicateVerdict), /line4/);
});

test("emits one N3 detail per reworked run even when the run has multiple founder reworks", async () => {
	const report = await reportAfter(`
		INSERT INTO workflow_gate_holder VALUES
		 ('run-doc-rework', 'founder_gate', 2, '${"g".repeat(40)}', 'question-6', 'land', 'git_head');
		INSERT INTO workflow_rework_request VALUES
		 ('rework-6', 'run-doc-rework', '2026-08-15T06:00:00.000Z', 2,
		  'founder', 'founder_gate', 'Please revise it again.', NULL, NULL);
		INSERT INTO workflow_founder_gate_verdict VALUES
		 ('verdict-6', 'run-doc-rework', 'rework', 'question-6', '__main__', 106,
		  '${"g".repeat(40)}', 'rework-6', NULL, 1,
		  '{"kind":"gate_response"}', '2026-08-15T06:00:00.000Z');
		INSERT INTO auto_merge_shadow_observation VALUES
		 ('verdict-6', 'run-doc-rework', 'question-6', '__main__', 106,
		  '${"g".repeat(40)}', '2026-08-15T06:00:00.000Z', 'docs_only', NULL,
		  NULL, '{"schemaVersion":1,"prs":[],"nestedReviews":{"entries":[]}}',
		  'unsatisfied', 'no_ledger_row', 'unsatisfied', 'no_ledger_row',
		  'unsatisfied', NULL, 0, 0);
		INSERT INTO auto_merge_shadow_declaration VALUES
		 ('declaration-6', 'question-6', 'run-doc-rework', 'pure_docs',
		  'flywheel-eng-lead', '12345678901234567', '62345678901234567',
		  '32345678901234567', '2026-08-15T06:00:00.000Z', 1,
		  '2026-08-15T06:00:00.000Z')
	`);
	const n1 = metric(report, "N1_founder_authored_rework");
	const n3 = report.rows.filter(
		(row) => row.kind === "detail" && row.name === "N3",
	);
	assert.equal(n1.numerator, 1);
	assert.equal(n3.length, n1.numerator);
});

test("fails closed for missing or duplicate receipts and invalid windows", async () => {
	for (const mutation of [
		"DELETE FROM state_store_migration",
		`INSERT INTO state_store_migration VALUES
		 ('fly-2398-shadow-observation-v1', '2026-08-09T10:16:00.000Z')`,
	]) {
		const { db, path } = createFixture();
		db.exec(mutation);
		await assert.rejects(
			runFly2398ShadowTable({ db: path, expectedForeignKeyBaseline: [] }),
			/shadow migration receipt count must be 1/,
		);
	}
	const invalidBounds = [
		[
			"2026-08-09T10:14:59.999Z",
			"2026-08-10T00:00:00.000Z",
			/window start must/,
		],
		[
			"2026-08-10T00:00:00.000Z",
			"2026-08-10T00:00:00.000Z",
			/window start must/,
		],
		[
			"2026-08-11T00:00:00.000Z",
			"2026-08-10T00:00:00.000Z",
			/window start must/,
		],
		[
			"2026-08-10T00:00:00.000Z",
			"2026-08-11T00:00:00.000Z",
			/window must be exactly 14 days/,
		],
	];
	for (const [windowStart, windowEnd, expected] of invalidBounds) {
		const { path } = createFixture();
		await assert.rejects(
			runFly2398ShadowTable({
				db: path,
				windowStart,
				windowEnd,
				expectedForeignKeyBaseline: [],
			}),
			expected,
		);
	}
	const { path } = createFixture();
	await assert.rejects(
		runFly2398ShadowTable({
			db: path,
			windowStart: "2099-01-01T00:00:00.000Z",
			windowEnd: "2099-01-15T00:00:00.000Z",
			expectedForeignKeyBaseline: [],
		}),
		/window must be complete/,
	);
});

test("rejects a WAL snapshot begun before the two-week boundary", async () => {
	const { path } = createFixture();
	const clock = ["2026-08-23T23:59:59.999Z", "2026-08-24T00:00:00.001Z"];
	await assert.rejects(
		runFly2398ShadowTable({
			db: path,
			windowStart: "2026-08-10T00:00:00.000Z",
			windowEnd: "2026-08-24T00:00:00.000Z",
			expectedForeignKeyBaseline: [],
			now: () => clock.shift() ?? "2026-08-24T00:00:00.001Z",
		}),
		/snapshot must begin after the complete window/,
	);
});

test("the standalone SQL guard aborts invalid bounds without wrapper help", () => {
	const { path } = createFixture();
	const sql = resolve(
		repoRoot,
		"engineering/doc/FLY-2398-auto-merge-shadow-run/shadow-table.sql",
	);
	for (const [windowStart, windowEnd] of [
		["2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
		["2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z"],
		["2099-01-01T00:00:00.000Z", "2099-01-15T00:00:00.000Z"],
	]) {
		const result = spawnSync("sqlite3", ["-batch", path], {
			encoding: "utf8",
			input: `.bail on
.parameter init
.parameter set :window_start '${windowStart}'
.parameter set :window_end '${windowEnd}'
.read '${sql.replaceAll("'", "''")}'
`,
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /CHECK constraint failed/);
	}
});
