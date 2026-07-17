import assert from "node:assert/strict";
import test from "node:test";

import {
	analyzeSources,
	buildAutoQaIntervals,
	buildSuggestions,
	clipIntervals,
} from "../lib/pipeline.mjs";

test("instantaneous auto-QA records do not create zero-length intervals", () => {
	assert.deepEqual(
		buildAutoQaIntervals(
			[
				{
					parent_execution_id: "parent",
					target_pr_head_sha: "abc",
					issue_id: "FLY-1",
					qa_execution_id: "qa",
					status: "failed",
					started_at: "2026-07-17 10:00:00",
					completed_at: "2026-07-17 10:00:00",
				},
			],
			Date.parse("2026-07-17T12:00:00Z"),
		),
		[],
	);
});

test("clipping preserves producer overlap intent instead of disabling validation globally", () => {
	const intervals = clipIntervals(
		[
			{ start_ms: 0, end_ms: 80, allow_overlap: true },
			{ start_ms: 20, end_ms: 100 },
		],
		0,
		100,
		true,
	);
	assert.deepEqual(
		intervals.map((item) => item.allow_overlap),
		[true, false],
	);
});

test("source bundle analysis produces a conserved evidence-backed issue report", () => {
	const asOf = Date.parse("2026-07-17T12:00:00Z");
	const bundle = {
		asOf,
		issues: ["FLY-1"],
		linear: {
			"FLY-1": {
				identifier: "FLY-1",
				createdAt: "2026-07-17T10:00:00Z",
				completedAt: "2026-07-17T12:00:00Z",
				history: [],
			},
		},
		team: {
			sessions: [
				{
					execution_id: "design",
					issue_identifier: "FLY-1",
					project_name: "flywheel",
					session_role: "design",
					started_at: "2026-07-17 10:10:00",
					terminal_at: "2026-07-17 10:30:00",
					status: "completed",
					last_error: null,
				},
			],
			events: [
				{
					event_id: "stage-1",
					execution_id: "design",
					issue_id: "FLY-1",
					event_type: "stage_changed",
					ts: "2026-07-17 10:10:00",
					payload: '{"stage":"onboard"}',
				},
				{
					event_id: "stage-2",
					execution_id: "design",
					issue_id: "FLY-1",
					event_type: "stage_changed",
					ts: "2026-07-17 10:20:00",
					payload: '{"stage":"design_review"}',
				},
			],
			reviews: [],
			qaRecords: [],
		},
		comm: { questions: [], responses: [], wakes: [] },
		github: {
			prsByIssue: {
				"FLY-1": [
					{
						number: 1,
						headRefName: "feature",
						createdAt: "2026-07-17T10:30:00Z",
						mergedAt: "2026-07-17T12:00:00Z",
					},
				],
			},
			runsByIssue: {
				"FLY-1": [
					{
						databaseId: 1,
						branch: "feature",
						workflowName: "CI",
						event: "pull_request",
						headSha: "aaa",
						createdAt: "2026-07-17T10:30:00Z",
						updatedAt: "2026-07-17T10:40:00Z",
						status: "completed",
						conclusion: "success",
					},
				],
			},
		},
		health: { status: "failed", note: "fixture missing", logText: "" },
		status: { linear: "ok", teamlead: "ok", commdb: "ok", gh: "ok" },
	};
	const { reports, diagnostics } = analyzeSources(bundle);
	assert.equal(reports.length, 1);
	assert.equal(reports[0].kind, "analyzed");
	assert.equal(
		reports[0].segments.reduce(
			(sum, item) => sum + item.end_ms - item.start_ms,
			0,
		),
		2 * 60 * 60 * 1000,
	);
	assert.ok(reports[0].segments.every((item) => item.evidence.length > 0));
	assert.ok(reports[0].overlays.some((item) => item.kind === "load_unknown"));
	assert.equal(diagnostics["FLY-1"].ci_rounds, 1);
	assert.ok(buildSuggestions(reports, diagnostics).length >= 5);
});
