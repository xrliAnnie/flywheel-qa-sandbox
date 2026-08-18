/**
 * FLY-108: session_completed strict route guard + status mapping + FSM reject logging.
 *
 * Covers:
 * - Strict enum guard: route ∈ {auto_approve, needs_review, blocked}
 * - Missing/undefined/empty route → skip (don't upsert session, don't transition)
 * - Invalid route ("garbage", "rejected") → skip
 * - Valid routes map to the expected status
 * - FSM reject logs at error level with pre-state + target + route
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("session_completed route guard (FLY-108)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	async function startRunning(executionId: string, issueId: string) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-start-${executionId}`,
				execution_id: executionId,
				issue_id: issueId,
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-G1", issueTitle: "Guard test" },
			}),
		});
		expect(res.status).toBe(200);
		const session = store.getSession(executionId);
		store.upsertSession({
			execution_id: executionId,
			issue_id: session?.issue_id ?? issueId,
			project_name: session?.project_name ?? "geoforge3d",
			status: session?.status ?? "running",
			worktree_path: process.cwd(),
		});
	}

	async function postCompleted(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0"; // FLY-869: FSM tests bypass ship gate
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0"; // retired input is ignored
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("empty payload → 200 with warning, session status unchanged", async () => {
		await startRunning("exec-empty", "issue-empty");

		const res = await postCompleted({
			event_id: "evt-empty",
			execution_id: "exec-empty",
			issue_id: "issue-empty",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.warning).toBe("invalid route skipped");
		expect(store.getSession("exec-empty")!.status).toBe("running");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("invalid route"),
		);
	});

	it("decision without route → skip", async () => {
		await startRunning("exec-decnoroute", "issue-decnoroute");

		const res = await postCompleted({
			event_id: "evt-decnoroute",
			execution_id: "exec-decnoroute",
			issue_id: "issue-decnoroute",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: {}, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-decnoroute")!.status).toBe("running");
	});

	it("route=garbage → skip (strict enum)", async () => {
		await startRunning("exec-garbage", "issue-garbage");

		const res = await postCompleted({
			event_id: "evt-garbage",
			execution_id: "exec-garbage",
			issue_id: "issue-garbage",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "garbage" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-garbage")!.status).toBe("running");
	});

	it("route=rejected → skip (not a DecisionRoute)", async () => {
		await startRunning("exec-rejected", "issue-rejected");

		const res = await postCompleted({
			event_id: "evt-rejected",
			execution_id: "exec-rejected",
			issue_id: "issue-rejected",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "rejected" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-rejected")!.status).toBe("running");
	});

	it("route=auto_approve + empty evidence → awaiting_review (guard pass, FSM runs)", async () => {
		await startRunning("exec-aa-empty", "issue-aa-empty");

		const res = await postCompleted({
			event_id: "evt-aa-empty",
			execution_id: "exec-aa-empty",
			issue_id: "issue-aa-empty",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "auto_approve" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-aa-empty")!.status).toBe("awaiting_review");
	});

	it("route=auto_approve + landingStatus.merged → completed", async () => {
		await startRunning("exec-aa-merged", "issue-aa-merged");

		const res = await postCompleted({
			event_id: "evt-aa-merged",
			execution_id: "exec-aa-merged",
			issue_id: "issue-aa-merged",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					landingStatus: { status: "merged", prNumber: 42 },
					changedFilePaths: ["x.ts"],
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 1,
					linesRemoved: 0,
				},
			},
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-aa-merged")!.status).toBe("completed");
	});

	it("route=needs_review → awaiting_review", async () => {
		await startRunning("exec-nr", "issue-nr");

		const res = await postCompleted({
			event_id: "evt-nr",
			execution_id: "exec-nr",
			issue_id: "issue-nr",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-nr")!.status).toBe("awaiting_review");
	});

	// FLY-115 v1.24.5 (FLY-120): when the Lead unblocks `approve_to_ship` via
	// `flywheel-comm respond` (production path) the Runner can resume, merge
	// the PR itself, and emit session_completed before the Bridge's approve
	// action has run. Status must short-circuit to "completed" — leaving it at
	// "awaiting_review" used to make Lead notify Annie about a PR already on
	// main (Round 5 deadlock evidence).
	it("route=needs_review + landingStatus.merged → completed (FLY-120)", async () => {
		await startRunning("exec-nr-merged", "issue-nr-merged");

		const res = await postCompleted({
			event_id: "evt-nr-merged",
			execution_id: "exec-nr-merged",
			issue_id: "issue-nr-merged",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					landingStatus: { status: "merged", prNumber: 7 },
				},
			},
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-nr-merged")!.status).toBe("completed");
	});

	it("route=blocked → blocked", async () => {
		await startRunning("exec-blk", "issue-blk");

		const res = await postCompleted({
			event_id: "evt-blk",
			execution_id: "exec-blk",
			issue_id: "issue-blk",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "blocked" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-blk")!.status).toBe("blocked");
	});

	// FLY-222 #1: no-code/no-merge clean success → terminal completed (NOT
	// awaiting_review). Mirrors DirectEventSink.
	it("route=no_code (no merge) → completed, decision_route persisted", async () => {
		await startRunning("exec-nc", "issue-nc");

		const res = await postCompleted({
			event_id: "evt-nc",
			execution_id: "exec-nc",
			issue_id: "issue-nc",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "no_code" },
				evidence: {},
				summary: "2 issues created, 3 learnings recorded",
			},
		});
		expect(res.status).toBe(200);
		const s = store.getSession("exec-nc")!;
		expect(s.status).toBe("completed");
		expect(s.decision_route).toBe("no_code");
	});

	// FLY-493: pr_handoff (no-transport antigravity build+PR terminal) maps
	// running→completed with PR/landing evidence, never awaiting_review.
	it("route=pr_handoff from running → completed, pr_number + decision_route persisted, NO review binding", async () => {
		await startRunning("exec-ph", "issue-ph");

		const res = await postCompleted({
			event_id: "evt-ph",
			execution_id: "exec-ph",
			issue_id: "issue-ph",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "pr_handoff" },
				evidence: {
					landingStatus: { status: "ready_to_merge", prNumber: 77 },
					headSha: "d".repeat(40),
				},
				summary: "PR #77 open — founder ship pending",
			},
		});
		expect(res.status).toBe(200);
		const s = store.getSession("exec-ph")!;
		expect(s.status).toBe("completed");
		expect(s.decision_route).toBe("pr_handoff");
		expect(s.pr_number).toBe(77);
		// Never enters the wake-dependent approve loop — no review binding written.
		expect(s.review_question_id ?? null).toBeNull();
	});

	it("route=pr_handoff from awaiting_review → skipped, status unchanged", async () => {
		store.upsertSession({
			execution_id: "exec-ph2",
			issue_id: "issue-ph2",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-PH2",
		});

		const res = await postCompleted({
			event_id: "evt-ph2",
			execution_id: "exec-ph2",
			issue_id: "issue-ph2",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "pr_handoff" },
				evidence: { landingStatus: { status: "ready_to_merge", prNumber: 5 } },
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.warning).toBe("pr_handoff from non-running skipped");
		expect(store.getSession("exec-ph2")!.status).toBe("awaiting_review");
	});

	// FLY-222 #1 (Codex code-review MED-2): no_code must NOT terminalize a
	// non-running (review-gated) session — it can only complete a running one.
	it("route=no_code from awaiting_review → skipped, status unchanged", async () => {
		store.upsertSession({
			execution_id: "exec-nc2",
			issue_id: "issue-nc2",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-NC2",
		});

		const res = await postCompleted({
			event_id: "evt-nc2",
			execution_id: "exec-nc2",
			issue_id: "issue-nc2",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.warning).toBe("no_code from non-running skipped");
		// still parked — the review gate was NOT cleared
		expect(store.getSession("exec-nc2")!.status).toBe("awaiting_review");
	});

	it("FSM reject logs at error level with pre-state + target + route", async () => {
		// Put session into a terminal state first via a legit transition.
		await startRunning("exec-fsm-rej", "issue-fsm-rej");
		await postCompleted({
			event_id: "evt-blk-pre",
			execution_id: "exec-fsm-rej",
			issue_id: "issue-fsm-rej",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "blocked" }, evidence: {} },
		});
		expect(store.getSession("exec-fsm-rej")!.status).toBe("blocked");

		// Second session_completed from terminal "blocked" should be rejected by the FSM.
		errorSpy.mockClear();
		await postCompleted({
			event_id: "evt-blk-dup",
			execution_id: "exec-fsm-rej",
			issue_id: "issue-fsm-rej",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});

		const errorCalls = errorSpy.mock.calls
			.map((args) => args.join(" "))
			.join("\n");
		expect(errorCalls).toContain("FSM rejected");
		expect(errorCalls).toContain("pre-state=blocked");
		expect(errorCalls).toContain("target=awaiting_review");
		expect(errorCalls).toContain("route=needs_review");
	});
});
