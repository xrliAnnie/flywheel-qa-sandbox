import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { withOperatorSnapshots } from "flywheel-comm/snapshot-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeLegacyCutoff,
	runFly2396RetroReport,
} from "../../../../scripts/fly2396-retro-report.mjs";
import { withManagedSnapshots } from "../../../../scripts/flywheel-snapshot-control.mjs";

const roots: string[] = [];
const connections: Database.Database[] = [];

afterEach(() => {
	for (const connection of connections.splice(0)) connection.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function createReportFixture(
	options: { deployed?: boolean; foreignKeyViolation?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "fly2396-report-test-"));
	roots.push(root);
	const path = join(root, "teamlead.db");
	const db = new Database(path);
	connections.push(db);
	db.pragma("journal_mode = WAL");
	db.pragma("wal_autocheckpoint = 0");
	db.exec(`
		CREATE TABLE state_store_migration (
			migration_id TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		CREATE TABLE workflow_run_node (
			run_id TEXT, node_id TEXT, attempt INTEGER, state TEXT,
			execution_id TEXT, ended_at TEXT
		);
		CREATE TABLE workflow_rework_request (
			request_id TEXT PRIMARY KEY, run_id TEXT, requested_at TEXT,
			source_attempt INTEGER, authority TEXT, source_node_id TEXT
		);
		CREATE TABLE workflow_gate_holder (
			run_id TEXT, gate_node_id TEXT, attempt INTEGER, head_sha TEXT,
			question_id TEXT, authority_mode TEXT
		);
		CREATE TABLE workflow_node_pr_binding (
			run_id TEXT, head_sha TEXT, pr_number INTEGER, probe_repo_slug TEXT
		);
		CREATE TABLE workflow_ship_target_binding (
			approve_question_id TEXT, probe_repo_slug TEXT
		);
		CREATE TABLE workflow_claims (
			id INTEGER PRIMARY KEY, decision_kind TEXT, predicate TEXT,
			issuer_kind TEXT
		);
		CREATE TABLE workflow_source_receipt (
			project TEXT, source_event_id TEXT, claim_id INTEGER, applied_at TEXT
		);
	`);
	if (options.deployed) {
		db.exec(`
			CREATE TABLE workflow_founder_gate_verdict (
				claim_id INTEGER,
				rework_request_id TEXT
			);
			INSERT INTO state_store_migration VALUES (
				'fly-2396-founder-gate-verdict-v1',
				'2026-09-06T20:00:00.000Z'
			);
		`);
	}
	const controls = [
		["c8f001a6", "2026-08-31T19:05:54.972Z", 101],
		["3f9f9f1c", "2026-09-01T00:32:30.282Z", 102],
		["5ae599c6", "2026-08-27T06:18:19.848Z", 103],
		["54f0d683", "2026-09-01T10:45:26.386Z", 104],
		["f5bd6f2b", "2026-08-23T12:56:16.700Z", 105],
	] as const;
	const insertRework = db.prepare(
		"INSERT INTO workflow_rework_request VALUES (?, ?, ?, 1, 'founder', 'founder_gate')",
	);
	const insertNode = db.prepare(
		"INSERT INTO workflow_run_node VALUES (?, 'founder_gate', 1, 'pending', NULL, NULL)",
	);
	const insertHolder = db.prepare(
		"INSERT INTO workflow_gate_holder VALUES (?, 'founder_gate', 1, ?, ?, 'land')",
	);
	const insertPr = db.prepare(
		"INSERT INTO workflow_node_pr_binding VALUES (?, ?, ?, 'xrliAnnie/flywheel')",
	);
	const insertShip = db.prepare(
		"INSERT INTO workflow_ship_target_binding VALUES (?, 'xrliAnnie/flywheel')",
	);
	for (const [prefix, requestedAt, pr] of controls) {
		const runId = `${prefix}-fixture`;
		const requestId = `rework:${prefix}`;
		const questionId = `question:${prefix}`;
		const head = prefix.padEnd(40, "a");
		insertRework.run(requestId, runId, requestedAt);
		insertNode.run(runId);
		insertHolder.run(runId, head, questionId);
		insertPr.run(runId, head, pr);
		insertShip.run(questionId);
	}
	if (options.deployed) {
		const lateRun = "aaaaaaaa-late";
		const lateHead = "b".repeat(40);
		insertRework.run("rework:post-deploy", lateRun, "2026-09-06T20:00:00.001Z");
		db.prepare(
			`INSERT INTO workflow_rework_request
			 VALUES (?, ?, ?, 1, 'lead', 'founder_gate')`,
		).run(
			"rework:post-deploy-lead",
			"cccccccc-lead-late",
			"2026-09-06T20:00:00.005Z",
		);
		insertNode.run(lateRun);
		insertHolder.run(lateRun, lateHead, "question:post-deploy");
		insertPr.run(lateRun, lateHead, 1063);
		insertShip.run("question:post-deploy");
		const recordedRun = "bbbbbbbb-recorded";
		const recordedHead = "c".repeat(40);
		insertRework.run(
			"rework:post-deploy-recorded",
			recordedRun,
			"2026-09-06T20:00:00.003Z",
		);
		insertNode.run(recordedRun);
		insertHolder.run(
			recordedRun,
			recordedHead,
			"question:post-deploy-recorded",
		);
		insertPr.run(recordedRun, recordedHead, 1064);
		insertShip.run("question:post-deploy-recorded");
		db.exec(`
			INSERT INTO workflow_claims
				(id, decision_kind, predicate, issuer_kind)
			VALUES
				(1, 'founder_decision', 'founder_approved', 'founder_challenge'),
				(2, 'founder_decision', 'founder_approved', 'founder_challenge');
			INSERT INTO workflow_source_receipt
				(project, source_event_id, claim_id, applied_at)
			VALUES
				('flywheel', 'founder-approve:post-deploy', 1,
					'2026-09-06T20:00:00.002Z'),
				('flywheel', 'founder-approve:post-deploy-recorded', 2,
					'2026-09-06T20:00:00.004Z');
			INSERT INTO workflow_founder_gate_verdict
				(claim_id, rework_request_id)
			VALUES
				(NULL, 'rework:post-deploy-recorded'),
				(2, NULL);
		`);
	}
	if (options.foreignKeyViolation) {
		db.pragma("foreign_keys = OFF");
		db.exec(`
			CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
			CREATE TABLE fixture_child (
				id INTEGER PRIMARY KEY,
				parent_id INTEGER REFERENCES fixture_parent(id)
			);
			INSERT INTO fixture_child VALUES (1, 99);
		`);
	}
	return { db, path };
}

function runManagedReport(options: {
	db: string;
	preDeployCutoff?: string;
	expectedForeignKeyBaseline: string[];
}) {
	return withManagedSnapshots(
		{
			label: "fly2396-retro-report-test",
			env: {},
			sources: [{ name: "teamlead", source: options.db, kind: "teamlead" }],
		},
		({ paths }) =>
			runFly2396RetroReport({ ...options, snapshot: paths.teamlead }),
		{
			withOperatorSnapshots: (input, use) =>
				withOperatorSnapshots(input, use, {
					stateRoot: join(dirname(options.db), "state"),
					managedRoot: join(dirname(options.db), "snapshots"),
					processStartIdentity: () => "fly2396-test-process",
					readDataDisk: () => ({
						disk_avail_gb: 1_000,
						disk: {
							volume: "/System/Volumes/Data",
							availBytes: 1_000_000_000_000,
							observedAt: new Date().toISOString(),
						},
					}),
				}),
		},
	);
}

describe("FLY-2396 retro report cutoff", () => {
	it.each([
		"0",
		"2026-09-06",
		"09/06/2026",
		"2026-09-06T12:00:00",
		"2026-09-06T12:00:00+00:00",
		"2026-09-06T12:00:00.0000Z",
	])("rejects non-contract cutoff %s", (value) => {
		expect(() => normalizeLegacyCutoff(value)).toThrow(
			"cutoff must be a strict UTC ISO instant",
		);
	});

	it.each([
		["2026-09-06T12:00:00Z", "2026-09-06T12:00:00.000Z"],
		["2026-09-06T12:00:00.1Z", "2026-09-06T12:00:00.100Z"],
		["2026-09-06T12:00:00.123Z", "2026-09-06T12:00:00.123Z"],
	])("normalizes a valid cutoff %s", (value, expected) => {
		expect(normalizeLegacyCutoff(value)).toBe(expected);
	});

	it("backs up uncheckpointed WAL and consumes TEMP attestations on a pre-deploy schema", async () => {
		const { path } = createReportFixture();
		expect(existsSync(`${path}-wal`)).toBe(true);
		expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
		const output = await runManagedReport({
			db: path,
			preDeployCutoff: "2026-09-06T20:00:00.000Z",
			expectedForeignKeyBaseline: [],
		});
		expect(output).toContain(
			"PRE-DEPLOY EVIDENCE (cutoff=2026-09-06T20:00:00.000Z)",
		);
		expect(output).toMatch(/repro_gate_execution_null\s+5\s+5/);
		expect(output).toMatch(/founder_authored_legacy\s+5\s+5\s+0\s+0/);
		expect(output).toMatch(
			/founder_verdict_unrecorded_post_cutoff\s+0\s+0\s+0\s+missing exact-head ledger = unknown/,
		);
		for (const [prefix, authored] of [
			["c8f001a6", 1],
			["3f9f9f1c", 1],
			["5ae599c6", 0],
			["54f0d683", 0],
			["f5bd6f2b", 0],
		] as const) {
			expect(output).toMatch(new RegExp(`${prefix}\\s+${authored}\\s+`));
		}
	});

	it("refuses a pre-deploy schema without an explicit cutoff", async () => {
		const { path } = createReportFixture();
		await expect(
			runManagedReport({ db: path, expectedForeignKeyBaseline: [] }),
		).rejects.toThrow("pre-deploy schema requires --pre-deploy-cutoff");
	});

	it("uses the migration receipt after deployment and forbids a cutoff stub", async () => {
		const { path } = createReportFixture({ deployed: true });
		await expect(
			runManagedReport({
				db: path,
				preDeployCutoff: "2026-09-06T20:00:00.000Z",
				expectedForeignKeyBaseline: [],
			}),
		).rejects.toThrow("pre-deploy cutoff is forbidden after deployment");
		const output = await runManagedReport({
			db: path,
			expectedForeignKeyBaseline: [],
		});
		expect(output).toContain(
			"DEPLOYED EVIDENCE (cutoff=2026-09-06T20:00:00.000Z)",
		);
		expect(output).toMatch(/rework_legacy_all\s+5\s+5\s+5/);
		expect(output).toMatch(
			/founder_verdict_unrecorded_post_cutoff\s+3\s+1\s+2\s+missing exact-head ledger = unknown/,
		);
		expect(output).toMatch(
			/founder_verdict_unrecorded_detail\s+approval\s+1\s+2026-09-06T20:00:00.002Z/,
		);
		expect(output).toMatch(
			/founder_verdict_unrecorded_detail\s+rework\s+rework:post-deploy\s+2026-09-06T20:00:00.001Z/,
		);
		expect(output).toMatch(
			/founder_verdict_unrecorded_detail\s+rework\s+rework:post-deploy-lead\s+2026-09-06T20:00:00.005Z/,
		);
		expect(output).not.toMatch(
			/founder_verdict_unrecorded_detail\s+approval\s+2\s+2026-09-06T20:00:00.004Z/,
		);
		expect(output).not.toMatch(
			/founder_verdict_unrecorded_detail\s+rework\s+rework:post-deploy-recorded\s+2026-09-06T20:00:00.003Z/,
		);
	});

	it("fails closed when the snapshot has a foreign-key violation", async () => {
		const { path } = createReportFixture({ foreignKeyViolation: true });
		await expect(
			runManagedReport({
				db: path,
				preDeployCutoff: "2026-09-06T20:00:00.000Z",
				expectedForeignKeyBaseline: [],
			}),
		).rejects.toThrow("snapshot foreign_key_check baseline drift");
	});
});
