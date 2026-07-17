import assert from "node:assert/strict";
import test from "node:test";

import {
	buildLinearQuery,
	healthLogDates,
	mapCommData,
	mapLinearResponse,
	parseReportArgs,
} from "../lib/collect.mjs";

test("health log dates follow the local calendar and never request a post-as-of day", () => {
	assert.deepEqual(
		healthLogDates(
			Date.parse("2026-07-14T21:07:22.898Z"),
			Date.parse("2026-07-17T08:55:31.345Z"),
		),
		["2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"],
	);
});

test("CLI parsing freezes now once and rejects unsafe issue identifiers", () => {
	const now = Date.parse("2026-07-17T12:34:56Z");
	assert.deepEqual(
		parseReportArgs(
			["--issues", "FLY-1,FLY-2", "--as-of", "now", "--out", "out"],
			() => now,
		),
		{
			issues: ["FLY-1", "FLY-2"],
			asOf: now,
			asOfIso: "2026-07-17T12:34:56.000Z",
			out: "out",
			project: "flywheel",
		},
	);
	assert.throws(
		() =>
			parseReportArgs(
				["--issues", "FLY-1');DROP TABLE sessions;--", "--out", "out"],
				() => now,
			),
		/issue identifier/,
	);
});

test("Linear query aliases are safe and response records are clipped to as-of", () => {
	const query = buildLinearQuery(["FLY-1", "FLY-2"]);
	assert.match(query, /i0: issue\(id: "FLY-1"\)/);
	assert.match(query, /i1: issue\(id: "FLY-2"\)/);
	const asOf = Date.parse("2026-07-17T12:00:00Z");
	const mapped = mapLinearResponse(
		{
			data: {
				i0: {
					identifier: "FLY-1",
					createdAt: "2026-07-17T10:00:00Z",
					completedAt: "2026-07-17T12:30:00Z",
					history: {
						nodes: [
							{ createdAt: "2026-07-17T11:00:00Z" },
							{ createdAt: "2026-07-17T12:30:00Z" },
						],
					},
				},
			},
		},
		["FLY-1"],
		asOf,
	);
	assert.equal(mapped["FLY-1"].completedAt, null);
	assert.equal(mapped["FLY-1"].history.length, 1);
});

test("CommDB mapping binds questions by execution id and keeps only minimal publishable fields", () => {
	const mapped = mapCommData(
		[
			{
				id: "q1",
				from_agent: "exec-1",
				checkpoint: "approve_to_ship",
				created_at: "2026-07-17 10:00:00",
				content:
					"PR ready head abcdefabcdefabcdefabcdefabcdefabcdefabcd secret prose",
			},
			{
				id: "r1",
				parent_id: "q1",
				type: "response",
				created_at: "2026-07-17 10:05:00",
				content: "private response",
			},
		],
		[{ execution_id: "exec-1", issue_identifier: "FLY-1" }],
	);
	assert.deepEqual(mapped.questions[0], {
		id: "q1",
		issue_identifier: "FLY-1",
		execution_id: "exec-1",
		checkpoint: "approve_to_ship",
		created_at: "2026-07-17 10:00:00",
		pr_head_sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
	});
	assert.deepEqual(mapped.responses[0], {
		parent_id: "q1",
		created_at: "2026-07-17 10:05:00",
	});
	assert.doesNotMatch(JSON.stringify(mapped), /secret prose|private response/);
});
