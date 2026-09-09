import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as collector from "../lib/collect.mjs";

import {
	buildLinearQuery,
	healthLogDates,
	mapCommData,
	mapLinearResponse,
	parseReportArgs,
} from "../lib/collect.mjs";

for (const refused of [null, "teamlead", "comm"]) {
	test(`database collection releases before next acquisition and isolates ${refused ?? "no"} budget refusal`, async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2351-cycle-"));
		const paths = {
			teamlead: join(root, "team.db"),
			comm: join(root, "comm.db"),
		};
		try {
			execFileSync("sqlite3", [
				paths.teamlead,
				`
				CREATE TABLE sessions(execution_id,issue_identifier,project_name,status,started_at,terminal_at,last_error,session_role,pr_number,branch);
				CREATE TABLE session_events(id,event_id,ts,execution_id,issue_id,event_type,payload,source);
				CREATE TABLE codex_review_job(request_id,execution_id,issue_id,review_type,round,frozen_head_sha,status,verdict,created_at,updated_at,responded_at,failure_reason);
				CREATE TABLE auto_qa_record(parent_execution_id,target_pr_head_sha,issue_id,qa_execution_id,status,started_at,completed_at);
				INSERT INTO sessions VALUES('exec-1','FLY-1','flywheel','running','2026-01-01 00:00:00',NULL,NULL,'implement',NULL,NULL);`,
			]);
			execFileSync("sqlite3", [
				paths.comm,
				`
				CREATE TABLE messages(id,from_agent,to_agent,type,parent_id,checkpoint,created_at,content);
				CREATE TABLE runner_phase_wakes(queue_seq,execution_id,message_id,state,queued_at,started_at,finished_at);
				INSERT INTO messages VALUES('q1','exec-1','lead','question',NULL,'review_code','2026-01-01 00:00:00','review');`,
			]);
			const calls = [];
			let live = false;
			const result = await collector.collectDatabaseSources({
				issues: ["FLY-1"],
				project: "flywheel",
				asOf: Date.parse("2026-02-01T00:00:00Z"),
				minT0: 0,
				withSnapshot: async (database, use) => {
					assert.equal(live, false);
					calls.push(`acquire:${database}`);
					live = true;
					try {
						if (database === refused)
							throw new Error("managed_snapshot_budget_exceeded");
						return await use(paths[database]);
					} finally {
						live = false;
						calls.push(`release:${database}`);
					}
				},
			});
			assert.deepEqual(calls, [
				"acquire:teamlead",
				"release:teamlead",
				"acquire:comm",
				"release:comm",
			]);
			assert.deepEqual(
				result.errors,
				refused
					? {
							[refused === "comm" ? "commdb" : refused]:
								"managed_snapshot_budget_exceeded",
						}
					: {},
			);
			assert.equal(
				result.status.teamlead,
				refused === "teamlead" ? "failed" : "ok",
			);
			assert.equal(result.status.commdb, refused === "comm" ? "failed" : "ok");
			if (!refused) assert.equal(result.comm.questions[0].id, "q1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

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
