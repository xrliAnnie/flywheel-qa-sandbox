import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	backupSqliteSnapshot,
	buildCiIntervals,
	buildGateIntervals,
	buildInfraIntervals,
	buildReviewIntervals,
	buildReworkIntervals,
	buildSessionIntervals,
	canonicalizeExtract,
	querySqliteSnapshot,
} from "../lib/extract.mjs";
import { validateIntervals } from "../lib/validate.mjs";

test("failed review rounds measure created-to-updated runtime and separate delivery latency", () => {
	const result = buildReviewIntervals(
		[
			{
				request_id: "req-7",
				issue_id: "FLY-1",
				review_type: "code",
				round: 7,
				created_at: "2026-07-17 03:20:26",
				updated_at: "2026-07-17 03:38:28",
				responded_at: "2026-07-17 03:40:00",
				status: "failed",
				verdict: null,
			},
		],
		Date.parse("2026-07-17T04:00:00Z"),
	);
	assert.equal(
		result.intervals[0].end_ms - result.intervals[0].start_ms,
		18 * 60_000 + 2_000,
	);
	assert.equal(result.intervals[0].state, "failed");
	assert.equal(result.intervals[0].label, "review_running");
	assert.equal(result.intervals[0].issue, "FLY-1");
	assert.equal(result.delivery_latencies[0].duration_ms, 92_000);
});

test("instantaneous terminal records are dropped instead of emitting zero-length activity", () => {
	const asOf = Date.parse("2026-07-17T12:00:00Z");
	assert.deepEqual(
		buildReviewIntervals(
			[
				{
					request_id: "instant-review",
					issue_id: "FLY-1",
					review_type: "code",
					round: 1,
					created_at: "2026-07-17 10:00:00",
					updated_at: "2026-07-17 10:00:00",
					status: "failed",
				},
			],
			asOf,
		).intervals,
		[],
	);
	assert.deepEqual(
		buildSessionIntervals(
			[
				{
					execution_id: "instant-qa",
					issue_identifier: "FLY-1",
					session_role: "qa",
					started_at: "2026-07-17 10:00:00",
					terminal_at: "2026-07-17 10:00:00",
					status: "failed",
				},
			],
			[],
			asOf,
		),
		[],
	);
	assert.deepEqual(
		buildGateIntervals({
			questions: [
				{
					id: "instant-gate",
					issue_identifier: "FLY-1",
					execution_id: "e1",
					checkpoint: "brainstorm",
					created_at: "2026-07-17 10:00:00",
				},
			],
			responses: [
				{ parent_id: "instant-gate", created_at: "2026-07-17 10:00:00" },
			],
			asOf,
		}),
		[],
	);
	assert.deepEqual(
		buildCiIntervals(
			[
				{
					databaseId: 1,
					branch: "feature",
					workflowName: "CI",
					event: "pull_request",
					headSha: "aaa",
					createdAt: "2026-07-17T10:00:00Z",
					updatedAt: "2026-07-17T10:00:00Z",
					status: "completed",
					conclusion: "failure",
				},
			],
			{ issue: "FLY-1", asOf, requiredWorkflows: ["CI"] },
		),
		[],
	);
	assert.deepEqual(
		buildInfraIntervals({
			allProjectSessions: ["a", "b", "c"].map((execution_id) => ({
				execution_id,
				issue_identifier: "FLY-1",
				project_name: "flywheel",
				status: "terminated",
				started_at: "2026-07-17 09:00:00",
				terminal_at: "2026-07-17 10:00:00",
				last_error: "instant cluster",
			})),
			sampleIssues: ["FLY-1"],
			asOf: Date.parse("2026-07-17T10:00:00Z"),
		}),
		[],
	);
});

test("concurrent phase sessions are valid production-shaped session stages", () => {
	const asOf = Date.parse("2026-07-17T12:00:00Z");
	const sessions = [
		{
			execution_id: "design",
			issue_identifier: "FLY-1",
			session_role: "design",
			started_at: "2026-07-17 10:00:00",
			terminal_at: "2026-07-17 11:00:00",
			status: "completed",
		},
		{
			execution_id: "implement",
			issue_identifier: "FLY-1",
			session_role: "implement",
			started_at: "2026-07-17 10:30:00",
			terminal_at: "2026-07-17 11:30:00",
			status: "completed",
		},
	];
	const events = sessions.map((session) => ({
		event_id: `stage-${session.execution_id}`,
		execution_id: session.execution_id,
		event_type: "stage_changed",
		ts: session.started_at,
		payload: '{"stage":"implement"}',
	}));
	const intervals = buildSessionIntervals(sessions, events, asOf);

	assert.equal(intervals.length, 2);
	assert.doesNotThrow(() =>
		validateIntervals(intervals, Date.parse("2026-07-17T10:00:00Z"), asOf),
	);
});

test("CI runs from multiple PR branches may overlap for one issue", () => {
	const asOf = Date.parse("2026-07-17T12:00:00Z");
	const intervals = buildCiIntervals(
		[
			{
				databaseId: 1,
				branch: "flywheel-FLY-1",
				workflowName: "CI",
				event: "pull_request",
				headSha: "aaa",
				createdAt: "2026-07-17T10:00:00Z",
				updatedAt: "2026-07-17T11:00:00Z",
				status: "completed",
				conclusion: "success",
			},
			{
				databaseId: 2,
				branch: "flywheel-FLY-1-follow-up",
				workflowName: "CI",
				event: "pull_request",
				headSha: "bbb",
				createdAt: "2026-07-17T10:30:00Z",
				updatedAt: "2026-07-17T11:30:00Z",
				status: "completed",
				conclusion: "success",
			},
		],
		{ issue: "FLY-1", asOf, requiredWorkflows: ["CI"] },
	);

	assert.equal(intervals.length, 2);
	assert.doesNotThrow(() =>
		validateIntervals(intervals, Date.parse("2026-07-17T10:00:00Z"), asOf),
	);
});

test("rework tracks from successor executions may overlap", () => {
	const asOf = Date.parse("2026-07-17T20:00:00Z");
	const intervals = buildReworkIntervals({
		reviewRows: [
			{
				request_id: "old-failure",
				execution_id: "old-exec",
				issue_id: "FLY-1",
				review_type: "code",
				verdict: "CHANGES_REQUESTED",
				created_at: "2026-07-17 18:00:00",
				updated_at: "2026-07-17 18:28:55",
			},
			{
				request_id: "new-failure",
				execution_id: "new-exec",
				issue_id: "FLY-1",
				review_type: "code",
				verdict: "CHANGES_REQUESTED",
				created_at: "2026-07-17 18:50:00",
				updated_at: "2026-07-17 19:04:54",
			},
			{
				request_id: "new-verification",
				execution_id: "new-exec",
				issue_id: "FLY-1",
				review_type: "code",
				verdict: "APPROVED",
				created_at: "2026-07-17 19:20:32",
				updated_at: "2026-07-17 19:30:00",
			},
		],
		eventRows: [],
		qaSessions: [],
		asOf,
	});

	assert.equal(intervals.length, 2);
	assert.doesNotThrow(() =>
		validateIntervals(intervals, Date.parse("2026-07-17T18:00:00Z"), asOf),
	);
});

test("human gates ignore review transport and close on earliest response, terminal, head change, or supersession", () => {
	const result = buildGateIntervals({
		questions: [
			{
				id: "review",
				issue_identifier: "FLY-1",
				execution_id: "e1",
				checkpoint: "review_code",
				created_at: "2026-07-17 14:50:00",
			},
			{
				id: "late",
				issue_identifier: "FLY-1",
				execution_id: "e1",
				checkpoint: "approve_to_ship",
				created_at: "2026-07-17 14:50:00",
				pr_head_sha: "aaa",
			},
			{
				id: "old",
				issue_identifier: "FLY-2",
				execution_id: "e2",
				checkpoint: "brainstorm",
				created_at: "2026-07-17 10:00:00",
			},
			{
				id: "new",
				issue_identifier: "FLY-2",
				execution_id: "e2",
				checkpoint: "brainstorm",
				created_at: "2026-07-17 10:10:00",
			},
			{
				id: "head",
				issue_identifier: "FLY-3",
				execution_id: "e3",
				checkpoint: "approve_to_ship",
				created_at: "2026-07-17 11:00:00",
				pr_head_sha: "old-sha",
			},
		],
		responses: [
			{ parent_id: "late", created_at: "2026-07-18 05:23:00" },
			{ parent_id: "new", created_at: "2026-07-17 10:12:00" },
		],
		sessionTerminals: [
			{ execution_id: "e1", terminal_at: "2026-07-17 21:59:00" },
		],
		headChanges: [
			{
				issue_identifier: "FLY-3",
				from_sha: "old-sha",
				at: "2026-07-17 11:03:00",
			},
		],
		asOf: Date.parse("2026-07-18T06:00:00Z"),
	});
	assert.deepEqual(
		result.map((item) => [
			item.evidence[0].key,
			new Date(item.end_ms).toISOString(),
			item.state,
		]),
		[
			["commdb:question=late", "2026-07-17T21:59:00.000Z", "superseded"],
			["commdb:question=old", "2026-07-17T10:10:00.000Z", "superseded"],
			["commdb:question=new", "2026-07-17T10:12:00.000Z", "ok"],
			["commdb:question=head", "2026-07-17T11:03:00.000Z", "superseded"],
		],
	);
});

test("infra incident requires a three-session same-fingerprint project-wide cluster and a recovery anchor", () => {
	const sessions = [
		{
			execution_id: "a",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "terminated",
			terminal_at: "2026-07-17 10:00:10",
			started_at: "2026-07-17 09:00:00",
			last_error: "restart killed session",
		},
		{
			execution_id: "b",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "failed",
			terminal_at: "2026-07-17 10:00:20",
			started_at: "2026-07-17 09:10:00",
			last_error: "restart killed session",
		},
		{
			execution_id: "outside",
			issue_identifier: "FLY-OTHER",
			project_name: "flywheel",
			status: "terminated",
			terminal_at: "2026-07-17 10:00:30",
			started_at: "2026-07-17 09:20:00",
			last_error: "restart killed session",
		},
		{
			execution_id: "recovery",
			issue_identifier: "FLY-NEW",
			project_name: "flywheel",
			status: "running",
			terminal_at: null,
			started_at: "2026-07-17 10:05:00",
			last_error: null,
		},
	];
	const incidents = buildInfraIntervals({
		allProjectSessions: sessions,
		sampleIssues: ["FLY-1"],
		asOf: Date.parse("2026-07-17T11:00:00Z"),
	});
	assert.equal(incidents.length, 1);
	assert.equal(incidents[0].label, "infra_incident");
	assert.equal(incidents[0].end_ms, Date.parse("2026-07-17T10:05:00Z"));
	assert.match(incidents[0].evidence[0].summary, /3 sessions/);

	const insufficient = buildInfraIntervals({
		allProjectSessions: sessions.slice(0, 2),
		sampleIssues: ["FLY-1"],
		asOf: Date.parse("2026-07-17T11:00:00Z"),
	});
	assert.deepEqual(insufficient, []);
	const mismatch = buildInfraIntervals({
		allProjectSessions: sessions
			.slice(0, 3)
			.map((item, index) =>
				index === 2 ? { ...item, last_error: "different failure" } : item,
			),
		sampleIssues: ["FLY-1"],
		asOf: Date.parse("2026-07-17T11:00:00Z"),
	});
	assert.deepEqual(mismatch, []);
});

test("cluster without a recovery anchor is explicitly unmeasurable", () => {
	const allProjectSessions = ["a", "b", "c"].map((execution_id, index) => ({
		execution_id,
		issue_identifier: index === 0 ? "FLY-1" : `FLY-X${index}`,
		project_name: "flywheel",
		status: "terminated",
		terminal_at: `2026-07-17 10:00:${10 + index}`,
		started_at: "2026-07-17 09:00:00",
		last_error: "restart killed session",
	}));
	const [tail] = buildInfraIntervals({
		allProjectSessions,
		sampleIssues: ["FLY-1"],
		asOf: Date.parse("2026-07-17T11:00:00Z"),
	});
	assert.equal(tail.label, "unmeasurable");
	assert.equal(tail.end_ms, null);
	assert.equal(tail.state, "open");
});

test("canonical extract bytes ignore execution ephemera and post-as-of growth but change for late pre-as-of data", () => {
	const asOf = "2026-07-17T12:00:00.000Z";
	const base = [
		{
			key: "b",
			effective_at: "2026-07-17T11:00:00Z",
			value: 2,
			scratch_path: "/tmp/run-a",
		},
		{
			key: "a",
			effective_at: "2026-07-17T10:00:00Z",
			value: 1,
			captured_at: "now-a",
		},
	];
	const first = canonicalizeExtract(base, { asOf, sourceId: "fixture" });
	const withPostAsOfGrowth = canonicalizeExtract(
		[
			{ ...base[1], captured_at: "now-b" },
			{ ...base[0], scratch_path: "/different/scratch" },
			{ key: "post", effective_at: "2026-07-17T12:00:01Z", value: 9 },
		],
		{ asOf, sourceId: "fixture" },
	);
	assert.equal(first.bytes, withPostAsOfGrowth.bytes);
	const withLatePreAsOf = canonicalizeExtract(
		[...base, { key: "late", effective_at: "2026-07-17T11:30:00Z", value: 3 }],
		{ asOf, sourceId: "fixture" },
	);
	assert.notEqual(first.bytes, withLatePreAsOf.bytes);
	assert.notEqual(first.sha256, withLatePreAsOf.sha256);
});

test("WAL source backup is read through immutable snapshot without mutating source content", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly1327-snapshot-"));
	const source = join(root, "source.db");
	const snapshot = join(root, "snapshot.db");
	try {
		execFileSync("sqlite3", [
			source,
			"PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES ('before');",
		]);
		const beforeMain = createHash("sha256")
			.update(readFileSync(source))
			.digest("hex");
		const beforeDump = execFileSync(
			"sqlite3",
			["-readonly", `file:${source}?mode=ro`, ".dump sample"],
			{ encoding: "utf8" },
		);
		await backupSqliteSnapshot(source, snapshot);
		const afterMain = createHash("sha256")
			.update(readFileSync(source))
			.digest("hex");
		const afterDump = execFileSync(
			"sqlite3",
			["-readonly", `file:${source}?mode=ro`, ".dump sample"],
			{ encoding: "utf8" },
		);
		assert.equal(afterMain, beforeMain);
		assert.equal(afterDump, beforeDump);

		execFileSync("sqlite3", [
			source,
			"INSERT INTO sample(value) VALUES ('after');",
		]);
		const rows = await querySqliteSnapshot(
			snapshot,
			"SELECT value FROM sample ORDER BY id",
		);
		assert.deepEqual(rows, [{ value: "before" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session stage events separate design work, implementation work, and independent QA", () => {
	const sessions = [
		{
			execution_id: "design",
			issue_identifier: "FLY-1",
			session_role: "design",
			started_at: "2026-07-17 10:00:00",
			terminal_at: "2026-07-17 10:50:00",
			status: "completed",
		},
		{
			execution_id: "impl",
			issue_identifier: "FLY-1",
			session_role: "implement",
			started_at: "2026-07-17 10:50:00",
			terminal_at: "2026-07-17 11:40:00",
			status: "completed",
		},
		{
			execution_id: "qa",
			issue_identifier: "FLY-1",
			session_role: "qa",
			started_at: "2026-07-17 11:40:00",
			terminal_at: "2026-07-17 12:10:00",
			status: "completed",
		},
	];
	const events = [
		{
			execution_id: "design",
			ts: "2026-07-17 10:05:00",
			event_type: "stage_changed",
			payload: '{"stage":"onboard"}',
		},
		{
			execution_id: "design",
			ts: "2026-07-17 10:10:00",
			event_type: "stage_changed",
			payload: '{"stage":"brainstorm"}',
		},
		{
			execution_id: "design",
			ts: "2026-07-17 10:20:00",
			event_type: "stage_changed",
			payload: '{"stage":"research"}',
		},
		{
			execution_id: "design",
			ts: "2026-07-17 10:30:00",
			event_type: "stage_changed",
			payload: '{"stage":"plan"}',
		},
		{
			execution_id: "design",
			ts: "2026-07-17 10:40:00",
			event_type: "stage_changed",
			payload: '{"stage":"design_review"}',
		},
		{
			execution_id: "impl",
			ts: "2026-07-17 10:55:00",
			event_type: "stage_changed",
			payload: '{"stage":"implement"}',
		},
		{
			execution_id: "impl",
			ts: "2026-07-17 11:20:00",
			event_type: "stage_changed",
			payload: '{"stage":"test"}',
		},
		{
			execution_id: "impl",
			ts: "2026-07-17 11:30:00",
			event_type: "stage_changed",
			payload: '{"stage":"code_review"}',
		},
	];
	const intervals = buildSessionIntervals(
		sessions,
		events,
		Date.parse("2026-07-17T13:00:00Z"),
	);
	assert.deepEqual(
		intervals
			.filter((item) => item.label === "working")
			.map((item) => [item.sublabel, item.start_ms, item.end_ms]),
		[
			[
				"design",
				Date.parse("2026-07-17T10:05:00Z"),
				Date.parse("2026-07-17T10:10:00Z"),
			],
			[
				"design",
				Date.parse("2026-07-17T10:10:00Z"),
				Date.parse("2026-07-17T10:20:00Z"),
			],
			[
				"design",
				Date.parse("2026-07-17T10:20:00Z"),
				Date.parse("2026-07-17T10:30:00Z"),
			],
			[
				"design",
				Date.parse("2026-07-17T10:30:00Z"),
				Date.parse("2026-07-17T10:40:00Z"),
			],
			[
				"implement",
				Date.parse("2026-07-17T10:55:00Z"),
				Date.parse("2026-07-17T11:20:00Z"),
			],
			[
				"implement",
				Date.parse("2026-07-17T11:20:00Z"),
				Date.parse("2026-07-17T11:30:00Z"),
			],
		],
	);
	assert.deepEqual(
		intervals
			.filter((item) => item.label === "qa_running")
			.map((item) => [item.start_ms, item.end_ms]),
		[[Date.parse("2026-07-17T11:40:00Z"), Date.parse("2026-07-17T12:10:00Z")]],
	);
});

test("review and QA failures open measured rework windows until the next verification starts", () => {
	const reviewRows = [
		{
			request_id: "r1",
			execution_id: "impl",
			issue_id: "FLY-1",
			review_type: "code",
			verdict: "CHANGES_REQUESTED",
			status: "done",
			created_at: "2026-07-17 10:00:00",
			updated_at: "2026-07-17 10:05:00",
		},
		{
			request_id: "r2",
			execution_id: "impl",
			issue_id: "FLY-1",
			review_type: "code",
			verdict: "APPROVED",
			status: "done",
			created_at: "2026-07-17 10:20:00",
			updated_at: "2026-07-17 10:25:00",
		},
	];
	const eventRows = [
		{
			event_id: "qfail",
			execution_id: "qa1",
			issue_id: "FLY-1",
			event_type: "qa_result",
			ts: "2026-07-17 11:00:00",
			payload: '{"verdict":"FAIL"}',
		},
	];
	const qaSessions = [
		{
			execution_id: "qa2",
			issue_identifier: "FLY-1",
			session_role: "qa",
			started_at: "2026-07-17 11:30:00",
			terminal_at: null,
		},
	];
	const intervals = buildReworkIntervals({
		reviewRows,
		eventRows,
		qaSessions,
		asOf: Date.parse("2026-07-17T12:00:00Z"),
	});
	assert.deepEqual(
		intervals.map((item) => [item.sublabel, item.end_ms - item.start_ms]),
		[
			["review_fix", 15 * 60_000],
			["qa_fix", 30 * 60_000],
		],
	);
});

test("CI rounds bind to each head and truncate superseded runs", () => {
	const intervals = buildCiIntervals(
		[
			{
				databaseId: 1,
				branch: "feature",
				workflowName: "CI",
				event: "pull_request",
				headSha: "aaa",
				createdAt: "2026-07-17T10:00:00Z",
				updatedAt: "2026-07-17T10:50:00Z",
				status: "completed",
				conclusion: "cancelled",
			},
			{
				databaseId: 2,
				branch: "feature",
				workflowName: "CI",
				event: "pull_request",
				headSha: "bbb",
				createdAt: "2026-07-17T10:30:00Z",
				updatedAt: "2026-07-17T11:00:00Z",
				status: "completed",
				conclusion: "success",
			},
			{
				databaseId: 3,
				branch: "feature",
				workflowName: "Nightly",
				event: "schedule",
				headSha: "bbb",
				createdAt: "2026-07-17T10:30:00Z",
				updatedAt: "2026-07-17T11:00:00Z",
				status: "completed",
				conclusion: "success",
			},
		],
		{
			issue: "FLY-1",
			asOf: Date.parse("2026-07-17T12:00:00Z"),
			requiredWorkflows: ["CI"],
		},
	);
	assert.deepEqual(
		intervals.map((item) => [item.evidence[0].key, item.end_ms, item.state]),
		[
			["gh_run:databaseId=1", Date.parse("2026-07-17T10:30:00Z"), "superseded"],
			["gh_run:databaseId=2", Date.parse("2026-07-17T11:00:00Z"), "ok"],
		],
	);
});
