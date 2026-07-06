/**
 * FLY-108 Integration: dual session_completed path through Bridge.
 *
 * Covers:
 *   Scenario A (Variant A normal): `needs_review → approve → auto_approve+merged`
 *     - 1st session_completed → awaiting_review (spy not called)
 *     - approve action via applyTransition → approved_to_ship
 *     - 2nd session_completed (auto_approve+merged) → completed (spy called 1x)
 *     - 3rd session_completed with NEW event_id → spy STILL 1x (atomic claim)
 *
 *   Scenario B (Variant B — docs-only compressed pipeline):
 *     - session_started → running
 *     - session_completed (auto_approve+merged) → running → completed (spy 1x)
 *
 * Notes:
 * - vi.mock replaces runPostShipFinalization with a spy so we observe invocation
 *   count without wiring Discord/fetch stubs.
 * - transitionOpts is wired so FSM transitions happen; post-ship gate runs.
 */
import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock post-ship-finalization. Keep isPostApproveShipComplete real so the
// gate logic matches production; only runPostShipFinalization is spied.
const runPostShipSpy = vi.fn(async () => {});
vi.mock("../bridge/post-ship-finalization.js", async () => {
	const actual = await vi.importActual<
		typeof import("../bridge/post-ship-finalization.js")
	>("../bridge/post-ship-finalization.js");
	return {
		...actual,
		runPostShipFinalization: (...args: unknown[]) => runPostShipSpy(...args),
	};
});

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

describe("FLY-108 Integration: dual session_completed through Bridge", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		// FLY-869: these FSM-mapping tests bypass the new merge/QA ship gates (the
		// approval gate is covered by ship-eligibility + dedicated integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		runPostShipSpy.mockClear();
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		transitionOpts = { store, fsm, executor };
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
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	async function postEvent(body: Record<string, unknown>) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
		return res;
	}

	it("Scenario A: needs_review → approve → auto_approve+merged fires post-ship exactly once", async () => {
		const execId = "exec-scenarioA";
		const issueId = "issue-scenarioA";

		// 1. session_started → running
		const startRes = await postEvent({
			event_id: "evtA-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-A1", issueTitle: "Scenario A" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. session_completed (needs_review) → awaiting_review
		const needsRes = await postEvent({
			event_id: "evtA-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(needsRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("awaiting_review");
		expect(runPostShipSpy).not.toHaveBeenCalled();

		// 3. approve action → approved_to_ship (simulate via applyTransition)
		const approveResult = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "action:approve",
			},
		);
		expect(approveResult.ok).toBe(true);
		expect(store.getSession(execId)!.status).toBe("approved_to_ship");

		// 4. session_completed (auto_approve + landingStatus.merged) → completed
		const mergedRes = await postEvent({
			event_id: "evtA-merged",
			execution_id: execId,
			issue_id: issueId,
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
		expect(mergedRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);

		// 5. Second session_completed with NEW event_id from terminal state
		// → FSM rejects completed→completed, no second call. (In prod, Runner
		// retries would hit event_id dedup; this tests the FSM rejection path.)
		const dupRes = await postEvent({
			event_id: "evtA-merged-dup",
			execution_id: execId,
			issue_id: issueId,
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
		expect(dupRes.status).toBe(200);
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});

	// FLY-115 v1.24.5 (FLY-120): production approve path uses `flywheel-comm
	// respond` to insert the gate response directly into CommDB; the Bridge's
	// approveExecution action is never invoked, so existingStatus stays at
	// `running`. The Runner then resumes, merges the PR, rewrites
	// land-status.json to `status: "merged"`, and fires session_completed
	// with route=needs_review. Pre-FLY-120 the Bridge mapped this to
	// `awaiting_review` and skipped post-ship cleanup (Codex Round 1 HIGH).
	// This scenario pins the fixed mapping end-to-end through the HTTP path.
	it("Scenario C (FLY-120): respond-path → Runner self-merges → needs_review+merged fires post-ship once", async () => {
		const execId = "exec-scenarioC";
		const issueId = "issue-scenarioC";

		// 1. session_started → running.
		const startRes = await postEvent({
			event_id: "evtC-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-C1", issueTitle: "Scenario C" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. NO approve action — gate response went via flywheel-comm respond
		//    so existingStatus stays "running".

		// 3. Runner self-merged + rewrote land-status.json → fires
		//    session_completed with route=needs_review + landingStatus.merged.
		const mergedRes = await postEvent({
			event_id: "evtC-merged",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					landingStatus: {
						status: "merged",
						prNumber: 7,
						mergeCommitSha: "deadbeef",
					},
					changedFilePaths: ["fix.ts"],
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 3,
					linesRemoved: 0,
				},
			},
		});
		expect(mergedRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});

	// FLY-115 v1.24.5 (Codex R2 HIGH regression guard): the natural completion
	// path — Annie :cool: → Lead approveExecution flips session to
	// approved_to_ship → Runner ships → emits `session_completed` with
	// `decision.route = undefined`. Pre-Codex-R2 the strict-route guard at
	// event-route.ts:333 dropped this payload (early return before the
	// approved_to_ship short-circuit), so the Lead never saw the terminal
	// transition and post-ship cleanup never fired. Sister parity case in
	// DirectEventSink.test.ts:822-841 ("DOES trigger finalization when
	// approved_to_ship → completed (normal ship path)"); both sinks must agree.
	it("Scenario D (Codex R2): approved_to_ship + route=undefined → completed fires post-ship once", async () => {
		const execId = "exec-scenarioD";
		const issueId = "issue-scenarioD";

		// 1. session_started → running.
		const startRes = await postEvent({
			event_id: "evtD-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-D1", issueTitle: "Scenario D" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. needs_review → awaiting_review (must seed the FSM path so the
		//    transition to approved_to_ship is legal).
		const needsRes = await postEvent({
			event_id: "evtD-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(needsRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("awaiting_review");

		// 3. approve action → approved_to_ship (Annie :cool: path).
		const approveResult = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "action:approve",
			},
		);
		expect(approveResult.ok).toBe(true);
		expect(store.getSession(execId)!.status).toBe("approved_to_ship");
		expect(runPostShipSpy).not.toHaveBeenCalled();

		// 4. Runner ships PR and emits session_completed with no decision route
		//    (natural completion) and NO merged landing evidence. FLY-208 5a:
		//    completes (unstick) but finalization is SUPPRESSED — merge
		//    evidence is now required (Codex design R2 #1); the evidence-gap
		//    marker is persisted for FLY-210 to finish cleanup later.
		const completeRes = await postEvent({
			event_id: "evtD-complete",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			// decision.route deliberately undefined to mirror DirectEventSink.test.ts:832.
			payload: { decision: { reasoning: "natural completion" }, evidence: {} },
		});
		expect(completeRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).not.toHaveBeenCalled();
		const dParams = JSON.parse(
			store.getSession(execId)!.session_params ?? "{}",
		) as { fly208_evidence_gap?: { route?: string | null } };
		expect(dParams.fly208_evidence_gap).toBeTruthy();
	});

	it("Scenario D2 (FLY-208): approved_to_ship + route=undefined + MERGED landing → completed + post-ship fires once", async () => {
		const execId = "exec-scenarioD2";
		const issueId = "issue-scenarioD2";
		await postEvent({
			event_id: "evtD2-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-D2", issueTitle: "Scenario D2" },
		});
		await postEvent({
			event_id: "evtD2-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(store.getSession(execId)!.status).toBe("awaiting_review");
		expect(
			applyTransition(transitionOpts, execId, "approved_to_ship", {
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "action:approve",
			}).ok,
		).toBe(true);

		const completeRes = await postEvent({
			event_id: "evtD2-complete",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { reasoning: "natural completion" },
				evidence: { landingStatus: { status: "merged", prNumber: 42 } },
			},
		});
		expect(completeRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});

	it("Scenario D3 (FLY-208 5a): approved_to_ship + route=needs_review + NOT merged → completed with evidence-gap (no FSM reject, no finalization)", async () => {
		// The LEARN-12 incident shape: ratify flipped the session to
		// approved_to_ship, the Runner re-sent complete with needs_review and a
		// landing signal stuck at ready_to_merge (sub never injects the
		// rewrite instruction). Pre-FLY-208 this mapped to awaiting_review,
		// the FSM rejected approved_to_ship → awaiting_review, and the session
		// was permanently stuck (close_runner protects approved_to_ship).
		const execId = "exec-scenarioD3";
		const issueId = "issue-scenarioD3";
		await postEvent({
			event_id: "evtD3-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-D3", issueTitle: "Scenario D3" },
		});
		await postEvent({
			event_id: "evtD3-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(
			applyTransition(transitionOpts, execId, "approved_to_ship", {
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "runner_gate_response",
			}).ok,
		).toBe(true);

		const completeRes = await postEvent({
			event_id: "evtD3-complete",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { landingStatus: { status: "ready_to_merge", prNumber: 16 } },
			},
		});
		expect(completeRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).not.toHaveBeenCalled();
		const d3Params = JSON.parse(
			store.getSession(execId)!.session_params ?? "{}",
		) as { fly208_evidence_gap?: { landing_status?: string | null } };
		expect(d3Params.fly208_evidence_gap?.landing_status).toBe("ready_to_merge");
	});

	// FLY-115 v1.24.5 (Codex R3 HIGH regression guard): the pre-R3 status
	// mapping had `if (isPostApproveShip)` before the route checks, which
	// incorrectly mapped `approved_to_ship + route="blocked"` (ship failed)
	// to `completed` and ran post-ship cleanup on a failure. Mirrors
	// DirectEventSink.test.ts:798-820 ("does NOT trigger finalization when
	// approved_to_ship → blocked (ship failed)"). With the R3 fix the
	// route="blocked" branch wins, status mapping resolves to "blocked",
	// the FSM rejects approved_to_ship → blocked (only `completed`/`failed`/
	// `terminated` are allowed transitions out of approved_to_ship per
	// workflow-fsm.ts:131), `transitionRejected` is set, and the
	// post-ship-finalization gate's `!transitionRejected` guard keeps
	// `runPostShipFinalization` from firing. Pre-R3 the mapping resolved to
	// "completed" which the FSM accepted, and the cleanup ran on a failed
	// ship — that's the bug this scenario locks down.
	it("Scenario E (Codex R3): approved_to_ship + route=blocked → no post-ship", async () => {
		const execId = "exec-scenarioE";
		const issueId = "issue-scenarioE";

		// 1. session_started → running.
		const startRes = await postEvent({
			event_id: "evtE-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-E1", issueTitle: "Scenario E" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. needs_review → awaiting_review (seed FSM path so the transition to
		//    approved_to_ship is legal).
		const needsRes = await postEvent({
			event_id: "evtE-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(needsRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("awaiting_review");

		// 3. approve action → approved_to_ship.
		const approveResult = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "action:approve",
			},
		);
		expect(approveResult.ok).toBe(true);
		expect(store.getSession(execId)!.status).toBe("approved_to_ship");
		expect(runPostShipSpy).not.toHaveBeenCalled();

		// 4. Runner reports ship FAILED via session_completed with
		//    route="blocked". The R3 fix routes through the `route==="blocked"`
		//    branch (status="blocked") instead of the natural-completion
		//    fallback. FLY-208 5a: the FSM now ALLOWS approved_to_ship →
		//    blocked (the missing edge was the same stuck-state family as the
		//    LEARN-12 incident — the rejection used to leave the session in
		//    approved_to_ship forever with close_runner protecting it). The
		//    regression guard stands: failed ship must NEVER trigger Runner
		//    tmux teardown / chat thread archive — now via status="blocked"
		//    (≠ completed) gating finalization out, not via an FSM rejection.
		const blockedRes = await postEvent({
			event_id: "evtE-blocked",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "blocked", reasoning: "ship gate failed" },
				evidence: {},
			},
		});
		expect(blockedRes.status).toBe(200);
		// FLY-208: ship failure lands in "blocked" (human-unblockable:
		// deferred/shelved/terminated exits) instead of being silently
		// swallowed by an FSM rejection.
		expect(store.getSession(execId)!.status).toBe("blocked");
		// Failed ship still never triggers finalization.
		expect(runPostShipSpy).not.toHaveBeenCalled();
	});

	it("Scenario B: docs-only compressed pipeline — running → completed fires post-ship once", async () => {
		const execId = "exec-scenarioB";
		const issueId = "issue-scenarioB";

		// 1. session_started → running
		const startRes = await postEvent({
			event_id: "evtB-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-B1", issueTitle: "Scenario B" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. session_completed (auto_approve + merged) → running → completed
		const mergedRes = await postEvent({
			event_id: "evtB-merged",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					landingStatus: { status: "merged", prNumber: 99 },
					changedFilePaths: ["docs.md"],
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 5,
					linesRemoved: 0,
				},
			},
		});
		expect(mergedRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});
});
