import assert from "node:assert/strict";
import test from "node:test";
import { segmentIssue } from "../lib/segment.mjs";
import { parseSqliteUtc } from "../lib/time.mjs";
import { validateIntervals, validateReport } from "../lib/validate.mjs";

const evidence = (key) => [{ source: "fixture", key, summary: key }];
const fullCoverage = (end = 100) =>
	["linear", "teamlead", "commdb", "gh"].map((source) => ({
		source,
		authoritative_kind: "all",
		status: "ok",
		covered: [{ start_ms: 0, end_ms: end }],
		note: "fixture",
	}));

test("SQLite UTC timestamps parse independently of the host timezone", () => {
	assert.equal(parseSqliteUtc("2026-07-17 08:00:01.250"), 1784275201250);
});

test("validated intervals keep bounded evidence-backed activity", () => {
	const interval = {
		source: "teamlead",
		kind: "review_round",
		issue: "FLY-1",
		start_ms: 10,
		end_ms: 20,
		state: "ok",
		evidence: [{ source: "teamlead", key: "review:1", summary: "round 1" }],
	};
	assert.deepEqual(validateIntervals([interval], 0, 30), [interval]);
});

test("interval validation rejects unpaired, untraceable, out-of-range, and overlapping activity", () => {
	const base = {
		source: "teamlead",
		kind: "review_round",
		issue: "FLY-1",
		start_ms: 10,
		end_ms: 20,
		state: "ok",
		evidence: [{ source: "teamlead", key: "review:1", summary: "round 1" }],
	};
	assert.throws(
		() => validateIntervals([{ ...base, end_ms: null }], 0, 30),
		/terminal interval/,
	);
	assert.throws(
		() => validateIntervals([{ ...base, evidence: [] }], 0, 30),
		/evidence/,
	);
	assert.throws(
		() => validateIntervals([{ ...base, start_ms: -1 }], 0, 30),
		/outside lifecycle/,
	);
	assert.throws(
		() => validateIntervals([{ ...base, end_ms: 31 }], 0, 30),
		/outside lifecycle/,
	);
	assert.throws(
		() =>
			validateIntervals(
				[
					base,
					{
						...base,
						start_ms: 19,
						end_ms: 25,
						evidence: [{ ...base.evidence[0], key: "review:2" }],
					},
				],
				0,
				30,
			),
		/overlap/,
	);
});

test("parallel cross-family review dominates CI without double-counting wall time", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		coverage: fullCoverage(),
		intervals: [
			{
				source: "teamlead",
				kind: "review_round",
				label: "review_running",
				start_ms: 10,
				end_ms: 50,
				state: "ok",
				issue: "FLY-1",
				evidence: evidence("review"),
			},
			{
				source: "gh",
				kind: "ci_run",
				label: "ci_waiting",
				start_ms: 20,
				end_ms: 40,
				state: "ok",
				issue: "FLY-1",
				evidence: evidence("ci"),
			},
		],
	});
	assert.equal(report.kind, "analyzed");
	assert.equal(
		report.segments.find((item) => item.start_ms === 20).label,
		"review_running",
	);
	assert.equal(
		report.segments.reduce((sum, item) => sum + item.end_ms - item.start_ms, 0),
		100,
	);
});

test("required source failure yields no verdict while optional health failure stays analyzable", () => {
	const requiredFailure = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		intervals: [],
		coverage: fullCoverage().map((item) =>
			item.source === "gh" ? { ...item, status: "failed", covered: [] } : item,
		),
	});
	assert.equal(requiredFailure.kind, "no_verdict");
	assert.deepEqual(requiredFailure.failed_sources, [
		{ source: "gh", kind: "all" },
	]);

	const optionalFailure = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		intervals: [],
		coverage: [
			...fullCoverage(),
			{
				source: "system-health",
				authoritative_kind: "load",
				status: "failed",
				covered: [],
				note: "missing",
			},
		],
	});
	assert.equal(optionalFailure.kind, "analyzed");
	assert.deepEqual(optionalFailure.overlays, [
		{ kind: "load_unknown", intervals: [{ start_ms: 0, end_ms: 100 }] },
	]);
});

test("partial required-source coverage becomes unmeasurable instead of idle", () => {
	const coverage = fullCoverage().map((item) =>
		item.source === "teamlead"
			? {
					...item,
					status: "partial",
					covered: [
						{ start_ms: 0, end_ms: 40 },
						{ start_ms: 60, end_ms: 100 },
					],
				}
			: item,
	);
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		intervals: [],
		coverage,
	});
	assert.deepEqual(
		report.segments.map(({ start_ms, end_ms, label }) => ({
			start_ms,
			end_ms,
			label,
		})),
		[
			{ start_ms: 0, end_ms: 40, label: "idle_gap" },
			{ start_ms: 40, end_ms: 60, label: "unmeasurable" },
			{ start_ms: 60, end_ms: 100, label: "idle_gap" },
		],
	);
});

test("idle windows distinguish backlog dispatch, phase handoff, and park wake", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		intervals: [],
		coverage: fullCoverage(),
		idleHints: [
			{
				start_ms: 30,
				end_ms: 60,
				sublabel: "phase_handoff",
				evidence: evidence("handoff"),
			},
			{
				start_ms: 60,
				end_ms: 80,
				sublabel: "park_wake",
				evidence: evidence("wake"),
			},
		],
	});
	assert.deepEqual(
		report.segments.map(({ start_ms, end_ms, sublabel }) => ({
			start_ms,
			end_ms,
			sublabel,
		})),
		[
			{ start_ms: 0, end_ms: 30, sublabel: "backlog_or_dispatch_wait" },
			{ start_ms: 30, end_ms: 60, sublabel: "phase_handoff" },
			{ start_ms: 60, end_ms: 80, sublabel: "park_wake" },
			{ start_ms: 80, end_ms: 100, sublabel: "phase_handoff" },
		],
	);
});

test("idle after the first measured activity is a phase handoff, not backlog wait", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		coverage: fullCoverage(),
		intervals: [
			{
				source: "teamlead",
				kind: "session_stage",
				label: "working",
				start_ms: 20,
				end_ms: 30,
				state: "ok",
				issue: "FLY-1",
				evidence: evidence("work"),
			},
		],
	});
	assert.deepEqual(
		report.segments.map((item) => [
			item.start_ms,
			item.end_ms,
			item.sublabel ?? item.label,
		]),
		[
			[0, 20, "backlog_or_dispatch_wait"],
			[20, 30, "working"],
			[30, 100, "phase_handoff"],
		],
	);
});

test("dominant-label priority is a total order across all measured activity", () => {
	const order = [
		"infra_incident",
		"gate_waiting_human",
		"rework_loop",
		"qa_running",
		"review_running",
		"ci_waiting",
		"working",
	];
	for (let index = 0; index < order.length - 1; index += 1) {
		const higher = order[index];
		const lower = order[index + 1];
		const report = segmentIssue({
			issue: "FLY-1",
			t0: 0,
			end: 100,
			asOf: 100,
			coverage: fullCoverage(),
			intervals: [
				{
					source: "fixture",
					kind: lower,
					label: lower,
					start_ms: 0,
					end_ms: 100,
					state: "ok",
					issue: "FLY-1",
					evidence: evidence(lower),
				},
				{
					source: "fixture",
					kind: higher,
					label: higher,
					start_ms: 0,
					end_ms: 100,
					state: "ok",
					issue: "FLY-1",
					evidence: evidence(higher),
				},
			],
		});
		assert.equal(
			report.segments[0].label,
			higher,
			`${higher} must dominate ${lower}`,
		);
	}
});

test("measured activity outranks an unmeasurable incident tail", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		coverage: fullCoverage(),
		intervals: [
			{
				source: "teamlead",
				kind: "incident",
				label: "unmeasurable",
				issue: "FLY-1",
				start_ms: 0,
				end_ms: 100,
				state: "open",
				evidence: evidence("unknown-tail"),
			},
			{
				source: "teamlead",
				kind: "session_stage",
				label: "working",
				issue: "FLY-1",
				start_ms: 0,
				end_ms: 100,
				state: "ok",
				evidence: evidence("measured-work"),
			},
		],
	});
	assert.equal(report.segments[0].label, "working");
});

test("report validation enforces contiguous wall-clock sum, known labels, and evidence", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: 100,
		asOf: 100,
		intervals: [],
		coverage: fullCoverage(),
	});
	assert.equal(validateReport(report), report);
	assert.throws(
		() =>
			validateReport({
				...report,
				segments: report.segments.map((item) => ({ ...item, end_ms: 90 })),
			}),
		/wall-clock/,
	);
	assert.throws(
		() =>
			validateReport({
				...report,
				segments: report.segments.map((item) => ({
					...item,
					label: "guessed",
				})),
			}),
		/label/,
	);
	assert.throws(
		() =>
			validateReport({
				...report,
				segments: report.segments.map((item) => ({ ...item, evidence: [] })),
			}),
		/evidence/,
	);
});

test("unfinished issues and open activity are censored at the fixed as-of", () => {
	const report = segmentIssue({
		issue: "FLY-1",
		t0: 0,
		end: null,
		asOf: 100,
		coverage: fullCoverage(),
		intervals: [
			{
				source: "teamlead",
				kind: "qa_run",
				label: "qa_running",
				start_ms: 80,
				end_ms: null,
				state: "open",
				issue: "FLY-1",
				evidence: evidence("qa-open"),
			},
		],
	});
	assert.equal(report.closed, false);
	assert.equal(report.end_ms, 100);
	assert.deepEqual(report.segments.at(-1), {
		start_ms: 80,
		end_ms: 100,
		label: "qa_running",
		sublabel: undefined,
		in_flight: true,
		evidence: evidence("qa-open"),
	});
});
