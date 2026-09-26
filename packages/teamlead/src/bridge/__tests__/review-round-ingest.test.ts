import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { ingestReviewRound } from "../review-round-ingest.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const THREAD_A = "01a0daf6-1f50-7522-b7dc-f0b3812a5dab";
const THREAD_B = "01a0daf6-1f50-7522-b7dc-f0b3812a5dac";
const TURN_1 = "01a0daf6-2634-7a23-a8e9-c1669023f451";
const TURN_2 = "01a0daf6-2634-7a23-a8e9-c1669023f452";
const BLOB = "a".repeat(40);
const BLOB2 = "b".repeat(40);
const HEAD = "c".repeat(40);
const NOW = new Date("2026-09-25T12:00:00.000Z");

function roundBody(overrides: Record<string, unknown> = {}) {
	return {
		executionId: EXEC,
		reviewType: "design",
		codexThreadId: THREAD_A,
		codexTurnId: TURN_1,
		round: 1,
		verdict: "CHANGES_REQUESTED",
		findings: { critical: 0, high: 2, medium: 1, low: 0 },
		modelEvidence: "rollout_turn",
		observedModel: "gpt-6-astra",
		observedEffort: "xhigh",
		requestId: "req-1",
		reviewedTarget: "engineering/doc/x/plan.md",
		reviewedPlanBlobSha: BLOB,
		reviewedAt: "2026-09-25T11:00:00.000Z",
		projectName: "flywheel",
		...overrides,
	};
}

function gateBody(overrides: Record<string, unknown> = {}) {
	return {
		kind: "gate_acceptance",
		executionId: EXEC,
		reviewType: "design",
		codexThreadId: THREAD_A,
		codexTurnId: TURN_2,
		finalRound: 2,
		roundsTotal: 2,
		observedModel: "gpt-6-astra",
		observedEffort: "xhigh",
		requestId: "req-1",
		reviewedTarget: "engineering/doc/x/plan.md",
		reviewedPlanBlobSha: BLOB,
		acceptedAt: "2026-09-25T11:30:00.000Z",
		...overrides,
	};
}

describe("FLY-2891 review round ingest", () => {
	let store: StateStore;
	let clock: Date;
	const ingest = (body: unknown, delivery: "http" | "spool" = "http") =>
		ingestReviewRound(store, body, { delivery, now: () => clock });

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		clock = NOW;
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-2891",
			project_name: "flywheel",
			status: "running",
		});
		vi.spyOn(store, "getWorkflowRunNodeForExecution").mockReturnValue({
			run_id: "run-1",
			node_id: "eng_design",
			attempt: 1,
			state: "running",
			execution_id: EXEC,
			started_at: "2026-09-25T10:00:00.000Z",
			ended_at: null,
		} as never);
		vi.spyOn(store, "getWorkflowExecutionRuntime").mockReturnValue({
			vendor: "claude",
			model: "claude-opus-5-5",
		} as never);
		vi.spyOn(store, "listWorkflowRunEvents").mockReturnValue([
			{
				run_id: "run-1",
				seq: 1,
				event_uid: "review_model_routed:run-1:eng_design:design:req-1",
				kind: "review_model_routed",
				node_id: "eng_design",
				edge_id: null,
				execution_id: EXEC,
				payload: {
					reviewType: "design",
					requestId: "req-1",
					reviewerVendor: "codex",
					reviewerModel: "gpt-6-astra",
					reviewerEffort: "xhigh",
				},
				at: "2026-09-25T10:30:00.000Z",
			},
		]);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});

	it("records a round with server-derived identity and a model match", () => {
		const result = ingest(
			roundBody({ issueId: "FAKE", runId: "fake", requiredModel: "x" }),
		);
		expect(result).toEqual({
			httpStatus: 200,
			body: {
				recorded: true,
				kind: "round",
				requiredModel: "gpt-6-astra",
				requiredEffort: "xhigh",
				modelMatch: true,
			},
		});
		expect(
			store.reviewRounds.getRound({
				executionId: EXEC,
				reviewType: "design",
				codexThreadId: THREAD_A,
				codexTurnId: TURN_1,
			}),
		).toMatchObject({
			project_name: "flywheel",
			issue_id: "FLY-2891",
			run_id: "run-1",
			node_id: "eng_design",
			author_vendor: "claude",
			author_model: "claude-opus-5-5",
			findings_high: 2,
			required_model: "gpt-6-astra",
			model_match: 1,
			delivery: "http",
			received_at: NOW.toISOString(),
		});
	});

	it("flags a wrong-model round (model_match=0) without rejecting it", () => {
		const result = ingest(roundBody({ observedModel: "gpt-5.6-sol" }));
		expect(result).toMatchObject({
			httpStatus: 200,
			body: { modelMatch: false, requiredModel: "gpt-6-astra" },
		});
	});

	it("model_match is NULL without a requirement or without evidence", () => {
		vi.mocked(store.listWorkflowRunEvents).mockReturnValue([]);
		vi.spyOn(store, "getWorkflowRun").mockReturnValue(undefined);
		expect(ingest(roundBody())).toMatchObject({
			body: { modelMatch: null },
		});
		expect(
			ingest(
				roundBody({
					codexTurnId: TURN_2,
					round: 2,
					modelEvidence: "unavailable",
					observedModel: undefined,
					observedEffort: undefined,
				}),
			),
		).toMatchObject({ body: { modelMatch: null } });
	});

	it("is idempotent for identical core facts and conflicts on differing ones", () => {
		expect(ingest(roundBody()).httpStatus).toBe(200);
		expect(ingest(roundBody(), "spool")).toMatchObject({
			httpStatus: 200,
			body: { duplicate: true },
		});
		const conflict = ingest(roundBody({ verdict: "APPROVED" }));
		expect(conflict).toMatchObject({
			httpStatus: 409,
			body: { recorded: false, errorType: "conflict" },
		});
		expect(
			store.reviewRounds.getRound({
				executionId: EXEC,
				reviewType: "design",
				codexThreadId: THREAD_A,
				codexTurnId: TURN_1,
			}),
		).toMatchObject({ verdict: "CHANGES_REQUESTED", delivery: "http" });
		expect(ingest(roundBody({ reviewedPlanBlobSha: BLOB2 })).httpStatus).toBe(
			409,
		);
		expect(ingest(roundBody({ observedModel: "gpt-5.6-sol" })).httpStatus).toBe(
			409,
		);
	});

	it("backfills model evidence once, and rejects a conflicting known model", () => {
		expect(
			ingest(
				roundBody({
					modelEvidence: "unavailable",
					observedModel: undefined,
					observedEffort: undefined,
					reviewedTarget: undefined,
				}),
			).httpStatus,
		).toBe(200);
		expect(ingest(roundBody())).toMatchObject({
			httpStatus: 200,
			body: { backfilled: true, modelMatch: true },
		});
		expect(
			store.reviewRounds.getRound({
				executionId: EXEC,
				reviewType: "design",
				codexThreadId: THREAD_A,
				codexTurnId: TURN_1,
			}),
		).toMatchObject({
			model_evidence: "rollout_turn",
			observed_model: "gpt-6-astra",
			model_match: 1,
			reviewed_target: "engineering/doc/x/plan.md",
		});
		expect(ingest(roundBody({ observedModel: "gpt-5.6-sol" })).httpStatus).toBe(
			409,
		);
	});

	it("fills a NULL reviewed_target without treating it as a conflict", () => {
		ingest(roundBody({ reviewedTarget: undefined }));
		expect(
			ingest(roundBody({ reviewedTarget: "https://github.com/o/r/pull/1" })),
		).toMatchObject({ httpStatus: 200, body: { duplicate: true } });
		expect(
			ingest(roundBody({ reviewedTarget: "https://github.com/o/r/pull/2" })),
		).toMatchObject({ httpStatus: 200, body: { duplicate: true } });
		expect(
			store.reviewRounds.getRound({
				executionId: EXEC,
				reviewType: "design",
				codexThreadId: THREAD_A,
				codexTurnId: TURN_1,
			})?.reviewed_target,
		).toBe("https://github.com/o/r/pull/1");
	});

	it("rejects a second turn claiming the same round number on one thread", () => {
		ingest(roundBody());
		expect(ingest(roundBody({ codexTurnId: TURN_2 }))).toMatchObject({
			httpStatus: 409,
			body: { errorType: "conflict" },
		});
		expect(
			ingest(roundBody({ codexThreadId: THREAD_B, codexTurnId: TURN_2 }))
				.httpStatus,
		).toBe(200);
	});

	it("records gate acceptance independently of round arrival order", () => {
		expect(ingest(gateBody())).toMatchObject({
			httpStatus: 200,
			body: { recorded: true, kind: "gate_acceptance", modelMatch: true },
		});
		expect(
			ingest(roundBody({ codexTurnId: TURN_2, round: 2, verdict: "APPROVED" }))
				.httpStatus,
		).toBe(200);
		expect(ingest(roundBody()).httpStatus).toBe(200);
		expect(
			store.reviewRounds.listRoundsForExecutions([EXEC]).map((r) => r.round),
		).toEqual([1, 2]);
		expect(
			store.reviewRounds.listGateAcceptancesForExecutions([EXEC]),
		).toHaveLength(1);
	});

	it("accepts a fresh-thread acceptance (finalRound 1 of 2 total)", () => {
		ingest(roundBody());
		ingest(
			roundBody({
				codexThreadId: THREAD_B,
				codexTurnId: TURN_2,
				round: 1,
				verdict: "APPROVED",
			}),
		);
		expect(
			ingest(
				gateBody({
					codexThreadId: THREAD_B,
					codexTurnId: TURN_2,
					finalRound: 1,
					roundsTotal: 2,
				}),
			),
		).toMatchObject({ httpStatus: 200, body: { recorded: true } });
	});

	it("treats a lost-receipt spool redelivery of an acceptance as duplicate and keeps first times", () => {
		expect(ingest(gateBody()).httpStatus).toBe(200);
		clock = new Date("2026-09-25T13:00:00.000Z");
		expect(ingest(gateBody(), "spool")).toMatchObject({
			httpStatus: 200,
			body: { duplicate: true },
		});
		// Re-running the gate on the same result: same accepted_at, still duplicate.
		expect(ingest(gateBody())).toMatchObject({ body: { duplicate: true } });
		expect(
			store.reviewRounds.getGateAcceptance({
				executionId: EXEC,
				reviewType: "design",
				codexTurnId: TURN_2,
			}),
		).toMatchObject({
			accepted_at: "2026-09-25T11:30:00.000Z",
			received_at: NOW.toISOString(),
		});
	});

	it("conflicts when an acceptance's business facts differ", () => {
		ingest(gateBody());
		for (const change of [
			{ finalRound: 1 },
			{ roundsTotal: 3 },
			{ observedModel: "gpt-5.6-sol" },
			{ reviewedTarget: "other/plan.md" },
		])
			expect(ingest(gateBody(change))).toMatchObject({
				httpStatus: 409,
				body: { errorType: "conflict" },
			});
		// Metadata alone never conflicts.
		expect(
			ingest(gateBody({ acceptedAt: "2026-09-25T11:45:00.000Z" })).httpStatus,
		).toBe(200);
	});

	it("validates payload boundaries as invalid_payload", () => {
		for (const bad of [
			null,
			[],
			roundBody({ reviewType: "qa" }),
			roundBody({ verdict: "LGTM" }),
			roundBody({ round: 0 }),
			roundBody({ round: 201 }),
			roundBody({ round: 1.5 }),
			roundBody({ codexThreadId: "../x" }),
			roundBody({ codexTurnId: "short" }),
			roundBody({ findings: { high: -1 } }),
			roundBody({ findings: { high: 10_001 } }),
			roundBody({ observedModel: "m".repeat(129) }),
			roundBody({ reviewedTarget: "t".repeat(513) }),
			roundBody({ reviewedPlanBlobSha: "xyz" }),
			roundBody({ reviewedAt: "not-a-date" }),
			roundBody({ reviewedAt: "2026-09-25T12:02:00.000Z" }),
			roundBody({ modelEvidence: "rollout_turn", observedModel: undefined }),
			roundBody({ modelEvidence: "unavailable" }),
			roundBody({ kind: "other" }),
			gateBody({ finalRound: 3, roundsTotal: 2 }),
			gateBody({ reviewedTarget: undefined }),
			gateBody({ observedModel: undefined }),
			gateBody({ requestId: undefined }),
			gateBody({ reviewType: "code", reviewedPlanBlobSha: undefined }),
		])
			expect(ingest(bad)).toMatchObject({
				httpStatus: 400,
				body: { recorded: false, errorType: "invalid_payload" },
			});
	});

	it("returns unknown_execution (404) and project_mismatch (409)", () => {
		expect(
			ingest(
				roundBody({ executionId: "99999999-2222-4333-8444-555555555555" }),
			),
		).toMatchObject({
			httpStatus: 404,
			body: { errorType: "unknown_execution" },
		});
		expect(ingest(roundBody({ projectName: "other" }))).toMatchObject({
			httpStatus: 409,
			body: { errorType: "project_mismatch" },
		});
	});

	it("uses the latest code route and records the reviewed head", () => {
		vi.mocked(store.listWorkflowRunEvents).mockReturnValue([
			{
				run_id: "run-1",
				seq: 1,
				event_uid: "review_model_routed:run-1:implement:code:e1",
				kind: "review_model_routed",
				node_id: "implement",
				edge_id: null,
				execution_id: EXEC,
				payload: {
					reviewType: "code",
					requestId: "e1",
					reviewerVendor: "codex",
					reviewerModel: "gpt-5.6-sol",
					reviewerEffort: "high",
				},
				at: "2026-09-25T10:30:00.000Z",
			},
			{
				run_id: "run-1",
				seq: 2,
				event_uid: "review_model_routed:run-1:implement:code:e2",
				kind: "review_model_routed",
				node_id: "implement",
				edge_id: null,
				execution_id: EXEC,
				payload: {
					reviewType: "code",
					requestId: "e2",
					reviewerVendor: "codex",
					reviewerModel: "gpt-5.6-sol",
					reviewerEffort: "xhigh",
				},
				at: "2026-09-25T10:40:00.000Z",
			},
		]);
		const result = ingest(
			roundBody({
				reviewType: "code",
				observedModel: "gpt-5.6-sol",
				reviewedPlanBlobSha: undefined,
				reviewedHeadSha: HEAD.toUpperCase(),
				requestId: undefined,
			}),
		);
		expect(result).toMatchObject({
			httpStatus: 200,
			body: { requiredEffort: "xhigh", modelMatch: true },
		});
	});

	it("reports 500 without leaking internals when the write throws", () => {
		const warn = vi.fn();
		vi.spyOn(store, "reviewRounds", "get").mockReturnValue({
			recordRound: () => {
				throw new Error("disk I/O error at /secret/path");
			},
		} as never);
		const result = ingestReviewRound(store, roundBody(), {
			delivery: "http",
			now: () => clock,
			logger: { warn },
		});
		expect(result).toEqual({
			httpStatus: 500,
			body: { recorded: false, reason: "review round write failed" },
		});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk I/O"));
	});

	it("stamps codex_review_job.completed_at once on the first completion", () => {
		const raw = (
			store as unknown as { db: { raw: import("better-sqlite3").Database } }
		).db.raw;
		raw
			.prepare(
				`INSERT INTO codex_review_job (request_id, execution_id, project_name, review_type, question_id, status)
				 VALUES ('job-1', ?, 'flywheel', 'design', 'q-1', 'running')`,
			)
			.run(EXEC);
		store.completeCodexReviewJob("job-1", "APPROVED");
		const first = raw
			.prepare(
				"SELECT completed_at FROM codex_review_job WHERE request_id = 'job-1'",
			)
			.get() as { completed_at: string | null };
		expect(first.completed_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
		raw
			.prepare(
				"UPDATE codex_review_job SET completed_at = '2000-01-01 00:00:00' WHERE request_id = 'job-1'",
			)
			.run();
		store.completeCodexReviewJob("job-1", "APPROVED");
		expect(
			(
				raw
					.prepare(
						"SELECT completed_at FROM codex_review_job WHERE request_id = 'job-1'",
					)
					.get() as { completed_at: string }
			).completed_at,
		).toBe("2000-01-01 00:00:00");
	});
});
