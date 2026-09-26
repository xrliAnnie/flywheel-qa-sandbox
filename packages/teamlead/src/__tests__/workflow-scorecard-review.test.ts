import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRoundStore } from "../bridge/review-round-store.js";
import { runWorkflowScorecardCli } from "../workflow-scorecard-cli.js";
import {
	jobReviewGroups,
	localReviewGroups,
	normalizeReviewRounds,
	readWorkflowScorecardReport,
} from "../workflow-scorecard-report.js";

const AS_OF = "2026-09-30T00:00:00.000Z";

function localRound(overrides: Record<string, unknown> = {}) {
	return {
		execution_id: "exec-1",
		review_type: "design",
		codex_thread_id: "thread-a",
		codex_turn_id: "turn-1",
		round: 1,
		verdict: "CHANGES_REQUESTED",
		observed_model: "gpt-6-astra",
		required_model: "gpt-6-astra",
		model_match: 1,
		reviewed_at: "2026-09-25T10:00:00.000Z",
		...overrides,
	} as never;
}

function acceptance(overrides: Record<string, unknown> = {}) {
	return {
		execution_id: "exec-1",
		review_type: "design",
		codex_thread_id: "thread-a",
		codex_turn_id: "turn-2",
		final_round: 2,
		rounds_total: 2,
		accepted_at: "2026-09-25T11:00:00.000Z",
		...overrides,
	} as never;
}

function job(overrides: Record<string, unknown> = {}) {
	return {
		request_id: "job-1",
		execution_id: "exec-2",
		review_type: "code",
		target_repo_identity: "__main__",
		status: "done",
		reviewer_verdict: "CHANGES_REQUESTED",
		verdict: "CHANGES_REQUESTED",
		created_at: "2026-09-25 10:00:00",
		updated_at: "2026-09-25 10:30:00",
		completed_at: "2026-09-25 10:20:00",
		responded_at: null,
		...overrides,
	} as never;
}

describe("FLY-2891 normalizeReviewRounds", () => {
	const round = (
		at: string,
		rawVerdict: "APPROVED" | "CHANGES_REQUESTED",
		ordinal: number,
		seriesKey = "s",
	) => ({ at, rawVerdict, ordinal, seriesKey });

	it("computes first pass and rounds to approval across merged series", () => {
		expect(
			normalizeReviewRounds([
				{
					rounds: [
						round("2026-09-25T10:00:00Z", "CHANGES_REQUESTED", 1, "a"),
						round("2026-09-25T11:00:00Z", "APPROVED", 1, "b"),
					],
					expectedTotal: 2,
				},
			]),
		).toEqual({ firstPass: false, roundsToApproval: 2, coverage: "complete" });
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "APPROVED", 1)],
					expectedTotal: 1,
				},
			]),
		).toEqual({ firstPass: true, roundsToApproval: 1, coverage: "complete" });
	});

	it("never turns missing data into a pass", () => {
		expect(normalizeReviewRounds([])).toEqual({
			firstPass: null,
			roundsToApproval: null,
			coverage: "none",
		});
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "APPROVED", 1)],
					expectedTotal: null,
				},
			]),
		).toMatchObject({ firstPass: null, coverage: "unverified" });
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "APPROVED", 2)],
					expectedTotal: 1,
				},
			]),
		).toMatchObject({ firstPass: null, coverage: "incomplete" });
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "APPROVED", 1)],
					expectedTotal: 1,
					gap: true,
				},
			]),
		).toMatchObject({ firstPass: null, coverage: "incomplete" });
	});

	it("a complete review without any APPROVED is not a first pass and has no rounds-to-approval", () => {
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "CHANGES_REQUESTED", 1)],
					expectedTotal: 1,
				},
			]),
		).toEqual({
			firstPass: false,
			roundsToApproval: null,
			coverage: "complete",
		});
	});

	it("one incomplete group makes the whole issue incomplete", () => {
		expect(
			normalizeReviewRounds([
				{
					rounds: [round("2026-09-25T10:00:00Z", "APPROVED", 1, "a")],
					expectedTotal: 1,
				},
				{
					rounds: [round("2026-09-25T09:00:00Z", "APPROVED", 2, "b")],
					expectedTotal: 1,
				},
			]),
		).toMatchObject({ coverage: "incomplete", firstPass: null });
	});
});

describe("FLY-2891 local (Claude-author) adapter", () => {
	it("counts rounds up to the accepted turn and reconciles with rounds_total", () => {
		const { groups } = localReviewGroups(
			[
				localRound(),
				localRound({
					codex_turn_id: "turn-2",
					round: 2,
					verdict: "APPROVED",
					reviewed_at: "2026-09-25T10:30:00.000Z",
				}),
				localRound({
					codex_turn_id: "turn-3",
					round: 3,
					verdict: "CHANGES_REQUESTED",
					reviewed_at: "2026-09-25T12:00:00.000Z",
				}),
			],
			[acceptance()],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: false,
			roundsToApproval: 2,
			coverage: "complete",
		});
	});

	it("fresh thread: A R1 CR + B R1 APPROVED is two rounds, not a first pass", () => {
		const { groups } = localReviewGroups(
			[
				localRound(),
				localRound({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-9",
					round: 1,
					verdict: "APPROVED",
					reviewed_at: "2026-09-25T10:40:00.000Z",
				}),
			],
			[
				acceptance({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-9",
					final_round: 1,
					rounds_total: 2,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: false,
			roundsToApproval: 2,
			coverage: "complete",
		});
	});

	it("an acceptance with no rounds, or a whole missing thread, is incomplete", () => {
		expect(
			normalizeReviewRounds(
				localReviewGroups([], [acceptance({ rounds_total: 3 })], AS_OF).groups,
			),
		).toMatchObject({ coverage: "incomplete", firstPass: null });
		expect(
			normalizeReviewRounds(
				localReviewGroups(
					[
						localRound({
							codex_thread_id: "thread-b",
							codex_turn_id: "turn-9",
							round: 1,
							verdict: "APPROVED",
						}),
					],
					[
						acceptance({
							codex_thread_id: "thread-b",
							codex_turn_id: "turn-9",
							final_round: 1,
							rounds_total: 2,
						}),
					],
					AS_OF,
				).groups,
			),
		).toMatchObject({ coverage: "incomplete", firstPass: null });
	});

	it("rounds without an acceptance are unverified; accepted turn missing is incomplete", () => {
		expect(
			normalizeReviewRounds(
				localReviewGroups([localRound({ verdict: "APPROVED" })], [], AS_OF)
					.groups,
			),
		).toMatchObject({ coverage: "unverified", firstPass: null });
		expect(
			normalizeReviewRounds(
				localReviewGroups(
					[localRound()],
					[
						acceptance({
							codex_turn_id: "turn-404",
							final_round: 1,
							rounds_total: 1,
						}),
					],
					AS_OF,
				).groups,
			),
		).toMatchObject({ coverage: "incomplete" });
	});

	it("QA repro: an off-model APPROVED thread is not a first pass; only required-model rounds count", () => {
		const { groups, reviewerModels } = localReviewGroups(
			[
				localRound({
					codex_thread_id: "thread-off",
					codex_turn_id: "turn-off",
					round: 1,
					verdict: "APPROVED",
					observed_model: "gpt-5.6-sol",
					model_match: 0,
					reviewed_at: "2026-09-25T09:00:00.000Z",
				}),
				localRound({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-b1",
					round: 1,
					verdict: "CHANGES_REQUESTED",
					reviewed_at: "2026-09-25T10:00:00.000Z",
				}),
				localRound({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-b2",
					round: 2,
					verdict: "APPROVED",
					reviewed_at: "2026-09-25T10:30:00.000Z",
				}),
				// after the accepted turn: neither a round nor a reviewer model
				localRound({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-b3",
					round: 3,
					verdict: "CHANGES_REQUESTED",
					observed_model: "gpt-9-late",
					reviewed_at: "2026-09-25T12:00:00.000Z",
				}),
			],
			[
				acceptance({
					codex_thread_id: "thread-b",
					codex_turn_id: "turn-b2",
					final_round: 2,
					rounds_total: 3,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: false,
			roundsToApproval: 2,
			coverage: "complete",
		});
		expect([...reviewerModels]).toEqual(["gpt-6-astra"]);
	});

	it("an off-model round earlier in the same thread is excluded without breaking the series", () => {
		const { groups } = localReviewGroups(
			[
				localRound({
					codex_turn_id: "turn-1",
					round: 1,
					verdict: "CHANGES_REQUESTED",
					observed_model: "gpt-5.6-sol",
					model_match: 0,
				}),
				localRound({
					codex_turn_id: "turn-2",
					round: 2,
					verdict: "CHANGES_REQUESTED",
					reviewed_at: "2026-09-25T10:10:00.000Z",
				}),
				localRound({
					codex_turn_id: "turn-3",
					round: 3,
					verdict: "APPROVED",
					reviewed_at: "2026-09-25T10:20:00.000Z",
				}),
			],
			[
				acceptance({
					codex_turn_id: "turn-3",
					final_round: 3,
					rounds_total: 3,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: false,
			roundsToApproval: 2,
			coverage: "complete",
		});
	});

	it("an acceptance that points at an off-model round cannot prove a complete pass", () => {
		const { groups } = localReviewGroups(
			[
				localRound({ codex_turn_id: "turn-1", round: 1, verdict: "APPROVED" }),
				localRound({
					codex_turn_id: "turn-2",
					round: 2,
					verdict: "APPROVED",
					observed_model: "gpt-5.6-sol",
					model_match: 0,
					reviewed_at: "2026-09-25T10:10:00.000Z",
				}),
			],
			[
				acceptance({
					codex_turn_id: "turn-2",
					final_round: 2,
					rounds_total: 2,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toMatchObject({
			coverage: "incomplete",
			firstPass: null,
		});
	});

	it("more off-model rounds than rounds_total is a contradiction, not 'no data'", () => {
		const { groups } = localReviewGroups(
			[
				localRound({
					codex_turn_id: "turn-1",
					round: 1,
					verdict: "CHANGES_REQUESTED",
					observed_model: "gpt-5.6-sol",
					model_match: 0,
				}),
				localRound({
					codex_turn_id: "turn-2",
					round: 2,
					verdict: "APPROVED",
					observed_model: "gpt-5.6-sol",
					model_match: 0,
					reviewed_at: "2026-09-25T10:10:00.000Z",
				}),
			],
			[
				acceptance({
					codex_turn_id: "turn-2",
					final_round: 2,
					rounds_total: 1,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toMatchObject({
			coverage: "incomplete",
			firstPass: null,
		});
	});

	it("a round with no model evidence under a model requirement is unverified", () => {
		const { groups } = localReviewGroups(
			[
				localRound({
					codex_turn_id: "turn-2",
					round: 1,
					verdict: "APPROVED",
					observed_model: null,
					model_match: null,
				}),
			],
			[
				acceptance({
					codex_turn_id: "turn-2",
					final_round: 1,
					rounds_total: 1,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toMatchObject({
			coverage: "unverified",
			firstPass: null,
		});
	});

	it("without any model requirement, rounds count as recorded", () => {
		const { groups } = localReviewGroups(
			[
				localRound({
					codex_turn_id: "turn-2",
					round: 1,
					verdict: "APPROVED",
					required_model: null,
					model_match: null,
				}),
			],
			[
				acceptance({
					codex_turn_id: "turn-2",
					final_round: 1,
					rounds_total: 1,
				}),
			],
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: true,
			roundsToApproval: 1,
			coverage: "complete",
		});
	});

	it("cuts at asOf and uses the earliest acceptance", () => {
		const { groups } = localReviewGroups(
			[
				localRound(),
				localRound({
					codex_turn_id: "turn-2",
					round: 2,
					verdict: "APPROVED",
					reviewed_at: "2026-09-25T10:30:00.000Z",
				}),
			],
			[acceptance()],
			"2026-09-25T10:15:00.000Z",
		);
		expect(normalizeReviewRounds(groups)).toMatchObject({
			coverage: "unverified",
		});
	});
});

describe("FLY-2891 Bridge job (Astra) adapter", () => {
	it("uses the raw reviewer verdict, not the policy-folded one", () => {
		const { groups } = jobReviewGroups(
			[
				job({ verdict: "APPROVED", reviewer_verdict: "CHANGES_REQUESTED" }),
				job({
					request_id: "job-2",
					reviewer_verdict: "APPROVED",
					verdict: "APPROVED",
					created_at: "2026-09-25 11:00:00",
					completed_at: "2026-09-25 11:20:00",
				}),
			],
			new Set(),
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: false,
			roundsToApproval: 2,
			coverage: "complete",
		});
	});

	it("a failed request before the first APPROVED is not a round", () => {
		const { groups } = jobReviewGroups(
			[
				job({ status: "failed", reviewer_verdict: null }),
				job({
					request_id: "job-2",
					reviewer_verdict: "APPROVED",
					created_at: "2026-09-25 11:00:00",
				}),
			],
			new Set(),
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: true,
			roundsToApproval: 1,
			coverage: "complete",
		});
	});

	it("a done row without a raw verdict is a coverage gap", () => {
		const { groups } = jobReviewGroups(
			[
				job({ reviewer_verdict: null }),
				job({
					request_id: "job-2",
					reviewer_verdict: "APPROVED",
					created_at: "2026-09-25 11:00:00",
				}),
			],
			new Set(),
			AS_OF,
		);
		expect(normalizeReviewRounds(groups)).toMatchObject({
			coverage: "incomplete",
			firstPass: null,
		});
	});

	it("excludes reuse copies and keeps repo series apart", () => {
		const { groups } = jobReviewGroups(
			[
				job({ reviewer_verdict: "APPROVED" }),
				job({
					request_id: "copy",
					reviewer_verdict: "CHANGES_REQUESTED",
					created_at: "2026-09-25 09:00:00",
					completed_at: "2026-09-25 09:10:00",
				}),
				job({
					request_id: "nested",
					target_repo_identity: "nested/repo",
					reviewer_verdict: "APPROVED",
					created_at: "2026-09-25 12:00:00",
					completed_at: "2026-09-25 12:10:00",
				}),
			],
			new Set(["copy"]),
			AS_OF,
		);
		expect(groups).toHaveLength(2);
		expect(normalizeReviewRounds(groups)).toEqual({
			firstPass: true,
			roundsToApproval: 1,
			coverage: "complete",
		});
	});

	it("reports exactly the jobs it counted (for reviewer models)", () => {
		const { countedRequestIds } = jobReviewGroups(
			[
				job({ reviewer_verdict: "APPROVED" }),
				job({ request_id: "copy", reviewer_verdict: "APPROVED" }),
				job({
					request_id: "late",
					reviewer_verdict: "APPROVED",
					completed_at: "2026-10-05 00:00:00",
				}),
				job({ request_id: "failed", status: "failed", reviewer_verdict: null }),
			],
			new Set(["copy"]),
			AS_OF,
		);
		expect([...countedRequestIds]).toEqual(["job-1"]);
	});

	it("uses the stable completion time, falls back to updated_at and counts it", () => {
		// completed 10:20, updated 10:30, delivered much later: asOf 10:25 sees it.
		const late = jobReviewGroups(
			[
				job({
					reviewer_verdict: "APPROVED",
					responded_at: "2026-09-29 00:00:00",
				}),
			],
			new Set(),
			"2026-09-25T10:25:00.000Z",
		);
		expect(normalizeReviewRounds(late.groups)).toMatchObject({
			firstPass: true,
		});
		expect(late.timeBasisFallback).toBe(0);
		const historical = jobReviewGroups(
			[job({ reviewer_verdict: "APPROVED", completed_at: null })],
			new Set(),
			"2026-09-25T11:00:00.000Z",
		);
		expect(historical.timeBasisFallback).toBe(1);
		expect(normalizeReviewRounds(historical.groups)).toMatchObject({
			firstPass: true,
		});
		const beforeFallback = jobReviewGroups(
			[job({ reviewer_verdict: "APPROVED", completed_at: null })],
			new Set(),
			"2026-09-25T10:25:00.000Z",
		);
		expect(normalizeReviewRounds(beforeFallback.groups).coverage).toBe("none");
	});
});

describe("FLY-2891 scorecard report review metrics", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const path of cleanups.splice(0))
			rmSync(path, { recursive: true, force: true });
	});

	function fixture(): string {
		const dir = mkdtempSync(join(tmpdir(), "fly2891-scorecard-"));
		cleanups.push(dir);
		const path = join(dir, "teamlead.db");
		const db = new BetterSqlite3(path);
		db.exec(`
			CREATE TABLE workflow_run(run_id TEXT PRIMARY KEY, issue_id TEXT, project_name TEXT, status TEXT);
			CREATE TABLE workflow_run_issue_alias(run_id TEXT, issue_alias TEXT, PRIMARY KEY(run_id, issue_alias));
			CREATE TABLE workflow_execution_runtime(execution_id TEXT PRIMARY KEY, model TEXT);
			CREATE TABLE workflow_execution_binding(activation_id TEXT PRIMARY KEY, execution_id TEXT, run_id TEXT, node_id TEXT, attempt INTEGER, bound_at TEXT);
			CREATE TABLE workflow_scorecard_activation(activation_id TEXT PRIMARY KEY, execution_id TEXT, run_id TEXT, node_id TEXT, attempt INTEGER, axis TEXT, assignment_state TEXT, policy_version TEXT, arm_id TEXT, assignment_event_uid TEXT, assignment_digest TEXT, admitted_at TEXT, closed_at TEXT, close_event_uid TEXT, close_kind TEXT);
			CREATE TABLE workflow_scorecard_turn(vendor TEXT, native_session_id TEXT, native_turn_id TEXT, execution_id TEXT, activation_id TEXT, attribution_state TEXT, started_at TEXT, ended_at TEXT, source_generation TEXT, start_offset INTEGER, end_offset INTEGER);
			CREATE TABLE workflow_scorecard_usage(vendor TEXT, native_session_id TEXT, source_generation TEXT, source_record_id TEXT, provider_request_id TEXT, native_turn_id TEXT, observed_model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, normalized_delta INTEGER, source_digest TEXT, at TEXT, source_offset INTEGER);
			CREATE TABLE workflow_scorecard_cursor(vendor TEXT, native_session_id TEXT, source_generation TEXT, execution_id TEXT, source_locator TEXT, committed_offset INTEGER, source_fingerprint TEXT, coverage TEXT, error TEXT, final_watermark INTEGER, updated_at TEXT);
			CREATE TABLE workflow_run_event(run_id TEXT, seq INTEGER, event_uid TEXT, kind TEXT, node_id TEXT, edge_id TEXT, execution_id TEXT, payload TEXT, at TEXT);
			CREATE TABLE workflow_claims(workflow_run_id TEXT, decision_kind TEXT, predicate TEXT, server_seq INTEGER, issued_at TEXT);
			CREATE TABLE workflow_gate_holder(run_id TEXT, question_id TEXT PRIMARY KEY, created_at TEXT);
			CREATE TABLE ship_judgment_outcome(outcome_id TEXT PRIMARY KEY, question_id TEXT, run_id TEXT, authorship TEXT, decision TEXT, decided_at TEXT, observed_at TEXT);
			CREATE TABLE codex_review_job(request_id TEXT PRIMARY KEY, execution_id TEXT, review_type TEXT, target_repo_identity TEXT, status TEXT, reviewer_verdict TEXT, verdict TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, responded_at TEXT);
			CREATE TABLE codex_review_reuse_binding(request_id TEXT PRIMARY KEY, source_request_id TEXT);
		`);
		new ReviewRoundStore(db).migrate();
		const bind = (run: string, exec: string, node: string, at: string) => {
			db.prepare(
				"INSERT INTO workflow_execution_binding VALUES (?, ?, ?, ?, 1, ?)",
			).run(`activation:${exec}`, exec, run, node, at);
			db.prepare(
				`INSERT INTO workflow_scorecard_activation VALUES (?, ?, ?, ?, 1, ?, 'assigned', 'v1', 'arm', NULL, NULL, ?, ?, NULL, 'done')`,
			).run(
				`activation:${exec}`,
				exec,
				run,
				node,
				node === "eng_design" ? "design" : "implement",
				at,
				at,
			);
		};
		db.prepare(
			"INSERT INTO workflow_run VALUES ('run-1','FLY-1','flywheel','completed')",
		).run();
		db.prepare(
			"INSERT INTO workflow_run VALUES ('run-2','FLY-2','flywheel','completed')",
		).run();
		bind("run-1", "exec-d1", "eng_design", "2026-09-25T09:00:00.000Z");
		bind("run-1", "exec-i1", "implement", "2026-09-25T09:30:00.000Z");
		bind("run-2", "exec-i2", "implement", "2026-09-25T09:00:00.000Z");
		const store = new ReviewRoundStore(db);
		const base = {
			projectName: "flywheel",
			modelEvidence: "rollout_turn" as const,
			observedEffort: "xhigh",
			modelMatch: 1 as const,
			delivery: "http" as const,
			receivedAt: "2026-09-25T12:00:00.000Z",
		};
		store.recordRound({
			...base,
			executionId: "exec-d1",
			reviewType: "design",
			codexThreadId: "thread-d",
			codexTurnId: "turn-d1",
			round: 1,
			verdict: "APPROVED",
			observedModel: "gpt-6-astra",
			reviewedAt: "2026-09-25T09:10:00.000Z",
		});
		store.recordGateAcceptance({
			executionId: "exec-d1",
			reviewType: "design",
			codexThreadId: "thread-d",
			codexTurnId: "turn-d1",
			finalRound: 1,
			roundsTotal: 1,
			observedModel: "gpt-6-astra",
			observedEffort: "xhigh",
			reviewedTarget: "plan.md",
			requestId: "req",
			reviewedPlanBlobSha: "a".repeat(40),
			projectName: "flywheel",
			acceptedAt: "2026-09-25T09:11:00.000Z",
			receivedAt: "2026-09-25T09:11:00.000Z",
		});
		store.recordRound({
			...base,
			executionId: "exec-i1",
			reviewType: "code",
			codexThreadId: "thread-c",
			codexTurnId: "turn-c1",
			round: 1,
			verdict: "CHANGES_REQUESTED",
			observedModel: "gpt-5.6-sol",
			reviewedAt: "2026-09-25T10:00:00.000Z",
		});
		store.recordRound({
			...base,
			executionId: "exec-i1",
			reviewType: "code",
			codexThreadId: "thread-c",
			codexTurnId: "turn-c2",
			round: 2,
			verdict: "APPROVED",
			observedModel: "gpt-5.6-sol",
			reviewedAt: "2026-09-25T10:30:00.000Z",
		});
		store.recordGateAcceptance({
			executionId: "exec-i1",
			reviewType: "code",
			codexThreadId: "thread-c",
			codexTurnId: "turn-c2",
			finalRound: 2,
			roundsTotal: 2,
			observedModel: "gpt-5.6-sol",
			observedEffort: "xhigh",
			reviewedTarget: "pr",
			reviewedHeadSha: "b".repeat(40),
			projectName: "flywheel",
			acceptedAt: "2026-09-25T10:31:00.000Z",
			receivedAt: "2026-09-25T10:31:00.000Z",
		});
		db.prepare(
			`INSERT INTO codex_review_job VALUES ('job-1','exec-i2','code','__main__','done','APPROVED','APPROVED','2026-09-25 10:00:00','2026-09-25 10:30:00','2026-09-25 10:20:00',NULL)`,
		).run();
		db.prepare(
			"INSERT INTO workflow_run_event VALUES ('run-2',1,'review_model_routed:run-2:implement:code:job-1','review_model_routed','implement',NULL,'exec-i2',?, '2026-09-25T10:00:00.000Z')",
		).run(
			JSON.stringify({
				reviewType: "code",
				requestId: "job-1",
				reviewerVendor: "claude",
				reviewerModel: "claude-opus-5-5",
				reviewerEffort: "xhigh",
			}),
		);
		db.close();
		return path;
	}

	it("reports per-issue review metrics and group first-pass rates for both lines", () => {
		const path = fixture();
		const db = new BetterSqlite3(path, { readonly: true });
		try {
			const report = readWorkflowScorecardReport(db, {
				project: "flywheel",
				from: "2026-09-01T00:00:00.000Z",
				to: "2026-10-01T00:00:00.000Z",
				asOf: AS_OF,
			});
			const byIssue = Object.fromEntries(
				report.issues.map((i) => [i.issueId, i]),
			);
			expect(byIssue["FLY-1"]!.designReview).toEqual({
				firstPass: true,
				roundsToApproval: 1,
				reviewerModels: ["gpt-6-astra"],
				source: "local_round",
				coverage: "complete",
				timeBasisFallback: 0,
			});
			expect(byIssue["FLY-1"]!.codeReview).toMatchObject({
				firstPass: false,
				roundsToApproval: 2,
				source: "local_round",
			});
			expect(byIssue["FLY-2"]!.codeReview).toEqual({
				firstPass: true,
				roundsToApproval: 1,
				reviewerModels: ["claude-opus-5-5"],
				source: "bridge_job",
				coverage: "complete",
				timeBasisFallback: 0,
			});
			expect(byIssue["FLY-2"]!.designReview.coverage).toBe("none");
			const implement = report.groups.find(
				(group) => group.axis === "implement" && group.issueCount === 2,
			)!;
			expect(implement.codeReviewFirstPass).toEqual({
				numerator: 1,
				denominator: 2,
				rate: 0.5,
			});
			expect(implement.codeReviewRoundsMean).toBe(1.5);
			expect(implement.codeReviewCoverage).toEqual({
				complete: 2,
				incomplete: 0,
				unverified: 0,
				none: 0,
			});
			expect(implement.designReviewFirstPass).toEqual({
				numerator: 1,
				denominator: 1,
				rate: 1,
			});
		} finally {
			db.close();
		}
	});

	it("QA repro through the database: an off-model APPROVED round does not make a first pass", () => {
		const path = fixture();
		const writable = new BetterSqlite3(path);
		try {
			writable
				.prepare(
					"INSERT INTO workflow_run VALUES ('run-3','FLY-3','flywheel','completed')",
				)
				.run();
			writable
				.prepare(
					"INSERT INTO workflow_execution_binding VALUES ('activation:exec-d3','exec-d3','run-3','eng_design',1,'2026-09-25T09:00:00.000Z')",
				)
				.run();
			writable
				.prepare(
					`INSERT INTO workflow_scorecard_activation VALUES ('activation:exec-d3','exec-d3','run-3','eng_design',1,'design','assigned','v1','arm',NULL,NULL,'2026-09-25T09:00:00.000Z','2026-09-25T09:00:00.000Z',NULL,'done')`,
				)
				.run();
			const store = new ReviewRoundStore(writable);
			const round = {
				projectName: "flywheel",
				executionId: "exec-d3",
				reviewType: "design" as const,
				modelEvidence: "rollout_turn" as const,
				observedEffort: "xhigh",
				requiredModel: "gpt-6-astra",
				requiredEffort: "xhigh",
				delivery: "http" as const,
				receivedAt: "2026-09-25T12:00:00.000Z",
			};
			store.recordRound({
				...round,
				codexThreadId: "thread-off",
				codexTurnId: "turn-off",
				round: 1,
				verdict: "APPROVED",
				observedModel: "gpt-5.6-sol",
				modelMatch: 0,
				reviewedAt: "2026-09-25T09:10:00.000Z",
			});
			store.recordRound({
				...round,
				codexThreadId: "thread-on",
				codexTurnId: "turn-on1",
				round: 1,
				verdict: "CHANGES_REQUESTED",
				observedModel: "gpt-6-astra",
				modelMatch: 1,
				reviewedAt: "2026-09-25T09:30:00.000Z",
			});
			store.recordRound({
				...round,
				codexThreadId: "thread-on",
				codexTurnId: "turn-on2",
				round: 2,
				verdict: "APPROVED",
				observedModel: "gpt-6-astra",
				modelMatch: 1,
				reviewedAt: "2026-09-25T09:50:00.000Z",
			});
			store.recordGateAcceptance({
				executionId: "exec-d3",
				reviewType: "design",
				codexThreadId: "thread-on",
				codexTurnId: "turn-on2",
				finalRound: 2,
				roundsTotal: 3,
				observedModel: "gpt-6-astra",
				observedEffort: "xhigh",
				reviewedTarget: "plan.md",
				requestId: "req-3",
				reviewedPlanBlobSha: "c".repeat(40),
				projectName: "flywheel",
				acceptedAt: "2026-09-25T09:51:00.000Z",
				receivedAt: "2026-09-25T09:51:00.000Z",
			});
		} finally {
			writable.close();
		}
		const db = new BetterSqlite3(path, { readonly: true });
		try {
			const report = readWorkflowScorecardReport(db, {
				project: "flywheel",
				from: "2026-09-01T00:00:00.000Z",
				to: "2026-10-01T00:00:00.000Z",
				asOf: AS_OF,
				issue: "FLY-3",
			});
			expect(report.issues[0]!.designReview).toEqual({
				firstPass: false,
				roundsToApproval: 2,
				reviewerModels: ["gpt-6-astra"],
				source: "local_round",
				coverage: "complete",
				timeBasisFallback: 0,
			});
		} finally {
			db.close();
		}
	});

	it("CLI text shows review lines and spool counts", () => {
		const path = fixture();
		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"report",
					"--db",
					path,
					"--project",
					"flywheel",
					"--from",
					"2026-09-01T00:00:00.000Z",
					"--to",
					"2026-10-01T00:00:00.000Z",
					"--as-of",
					AS_OF,
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		expect(stdout).toContain(
			"code_first_pass=1/2 code_rounds_mean=1.5 code_incomplete=0",
		);
		expect(stdout).toContain(
			"design_first_pass=1/1 design_rounds_mean=1 design_incomplete=0",
		);
		expect(stdout).toMatch(/review_round_spool_pending=0 quarantined=0/);
	});
});
