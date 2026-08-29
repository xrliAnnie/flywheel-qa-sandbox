import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildQaResultBody,
	buildQaResultFailureMarker,
	qaResult,
} from "../qa-result.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
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
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
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
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
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
