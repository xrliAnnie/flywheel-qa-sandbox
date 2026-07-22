import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildQaResultBody,
	buildQaResultFailureMarker,
	classifyQaResultRejection,
	qaResult,
} from "../qa-result.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/**
 * FLY-579 P1: the QA verdict event body. Field-aligned with the Bridge
 * consumer (event-route.ts event_type === "qa_result" → onQaResult).
 */
describe("buildQaResultBody", () => {
	it("builds a pass verdict event keyed to the QA exec, targeting the parent", () => {
		const body = buildQaResultBody({
			status: "pass",
			qaExecutionId: "qa-1",
			targetExecutionId: "main-1",
			issueId: "FLY-9",
			projectName: "proj",
			prHeadSha: "f".repeat(40),
			summary: "verified the flow end to end",
			eventId: "evt-1",
		});
		expect(body).toEqual({
			event_id: "evt-1",
			execution_id: "qa-1",
			issue_id: "FLY-9",
			project_name: "proj",
			event_type: "qa_result",
			source: "flywheel-comm",
			payload: {
				status: "pass",
				targetExecutionId: "main-1",
				qaExecutionId: "qa-1",
				prHeadSha: "f".repeat(40),
				summary: "verified the flow end to end",
			},
		});
	});

	it("omits optional prHeadSha/summary when absent", () => {
		const body = buildQaResultBody({
			status: "fail",
			qaExecutionId: "qa-2",
			targetExecutionId: "main-2",
			issueId: "FLY-9",
			projectName: "proj",
			eventId: "evt-2",
		});
		expect(body.payload).toEqual({
			status: "fail",
			targetExecutionId: "main-2",
			qaExecutionId: "qa-2",
		});
		expect("prHeadSha" in body.payload).toBe(false);
		expect("summary" in body.payload).toBe(false);
	});

	it("the QA exec is the event execution_id (not the parent) — so it links to the QA session", () => {
		const body = buildQaResultBody({
			status: "pass",
			qaExecutionId: "qa-3",
			targetExecutionId: "main-3",
			issueId: "FLY-9",
			projectName: "proj",
		});
		expect(body.execution_id).toBe("qa-3");
		expect(body.payload.targetExecutionId).toBe("main-3");
		expect(body.event_id).toBeTruthy();
	});
});

describe("credential-backed qa-result delivery", () => {
	it("uses the dedicated decision route without the fleet ingest bearer", async () => {
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-1");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1244");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_INGEST_TOKEN", "fleet-secret");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1,
					serverSeq: 1,
					idempotentReplay: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			summary: "all checks passed",
			prHeadSha: "a".repeat(40),
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; body: string },
		];
		expect(url).toBe("http://127.0.0.1:9876/api/workflow/decision");
		expect(init.headers.Authorization).toBeUndefined();
		expect(JSON.parse(init.body)).toMatchObject({
			credential: "scoped-secret",
			status: "pass",
			summary: "all checks passed",
			client_pr_head_sha: "a".repeat(40),
			client_request_id: expect.any(String),
		});
	});

	it("keeps legacy /events + bearer behavior when no scoped credential exists", async () => {
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-legacy");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1244");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_INGEST_TOKEN", "fleet-secret");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await qaResult({
			status: "fail",
			targetExec: "impl-1",
			prHeadSha: "b".repeat(40),
		});

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe("http://127.0.0.1:9876/events");
		expect(init.headers.Authorization).toBe("Bearer fleet-secret");
	});

	it("failure marker is opaque: digest + retry identity, never event body or credential", () => {
		const marker = buildQaResultFailureMarker({
			execId: "qa-1",
			requestId: "request-1",
			body: { credential: "do-not-persist", summary: "private report" },
			lastError: "Bridge returned 503",
			timestamp: "2026-07-14T00:00:00.000Z",
		});
		expect(marker).toMatchObject({
			execution_id: "qa-1",
			client_request_id: "request-1",
			error: "Bridge returned 503",
			body_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(marker)).not.toContain("do-not-persist");
		expect(JSON.stringify(marker)).not.toContain("private report");
	});
});

describe("FLY-1425 qa-result fail-loud contract", () => {
	const deterministicReasons = [
		"workflow_submission_required",
		"credential_not_found",
		"credential_revoked",
		"credential_expired",
		"credential_receipt_corrupt",
		"invalid_request",
		"invalid_status",
		"invalid_client_head",
		"invalid_timestamp",
		"head_authority_mismatch",
		"replay_payload_mismatch",
		"not_durable_qa_execution",
		"predicate_not_allowed",
		"binding_not_current",
		"same_vendor_review",
		"missing_subject_producer",
		"node_does_not_emit_decisions",
		"decision_family_mismatch",
		"materialized_head_invalid",
		"materialized_output_mismatch",
		"materialized_producer_ambiguous",
		"execution_not_found",
		"worktree_not_found",
		"invalid_git_head",
		"run_not_found",
		"transition_refused",
	] as const;
	const retryableReasons = [
		"materialized_head_unavailable",
		"materialized_run_snapshot_unavailable",
		"materialized_review_node_unavailable",
		"materialized_producer_unavailable",
		"execution_runtime_unavailable",
		"producer_runtime_unavailable",
		"producer_not_found",
		"head_unavailable",
		"git_head_unavailable",
		"decision_authority_unavailable",
		"invalid_server_clock",
	] as const;

	function stubBaseEnv(): void {
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-engine");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1425");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
	}

	function stubFastFailureExit(): ReturnType<typeof vi.spyOn> {
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);
		return vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);
	}

	it.each(deterministicReasons)(
		"classifies stable deterministic reason %s as fail",
		(reason) => {
			expect(classifyQaResultRejection(reason)).toBe("fail");
		},
	);

	it.each(retryableReasons)(
		"classifies recoverable reason %s as retry",
		(reason) => {
			expect(classifyQaResultRejection(reason)).toBe("retry");
		},
	);

	it("keeps unknown server reasons retryable for forward compatibility", () => {
		expect(classifyQaResultRejection("new_bridge_reason")).toBe("retry");
		expect(classifyQaResultRejection(undefined)).toBe("retry");
	});

	it("refuses locally when an engine credential was expected but is missing", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not enable the local sentinel for values other than exact 1", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "true");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: "a".repeat(40),
		});

		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9876/events");
	});

	it("fails immediately on a deterministic reason and accepts the legacy error field", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
					status: 409,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const exit = stubFastFailureExit();

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("explains replay_payload_mismatch without claiming the current verdict landed", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: false, reason: "replay_payload_mismatch" }),
					{ status: 409 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		stubFastFailureExit();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult({
				status: "fail",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining(
				"does NOT prove the current verdict was recorded",
			),
		);
	});

	it.each([
		[409, { ok: false, reason: "new_bridge_reason" }],
		[503, { ok: false, reason: "invalid_request" }],
	] as const)(
		"keeps bounded retry for HTTP %s recoverable responses",
		async (status, body) => {
			stubBaseEnv();
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
			const fetchMock = vi
				.fn()
				.mockImplementation(
					async () => new Response(JSON.stringify(body), { status }),
				);
			vi.stubGlobal("fetch", fetchMock);
			stubFastFailureExit();

			await expect(
				qaResult({
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: "a".repeat(40),
				}),
			).rejects.toThrow("exit:1");
			expect(fetchMock).toHaveBeenCalledTimes(4);
		},
	);

	it("accepts only a shaped decision acknowledgement before claiming consumption", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("prints an honest decision-consumed message only for a shaped ack", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						claimId: 42,
						serverSeq: 7,
						idempotentReplay: false,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: "a".repeat(40),
		});

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"decision consumed (claimId=42 serverSeq=7 idempotentReplay=false)",
			),
		);
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("delivered"));
	});

	it("labels a legacy /events success as stored but not a DAG decision", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: "a".repeat(40),
		});

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"accepted by /events (event stored; NOT a DAG decision)",
			),
		);
	});
});
