/**
 * FLY-859 — /events qa_result routing split. A THREE-STAGE QA phase's verdict
 * (reporting session `session_role='qa' && chat_thread_role='qa'`) goes to the
 * PhaseOrchestrator (durable intent + fix-loop); everything else falls through
 * to AutoQaCoordinator.onQaResult byte-for-byte. Drives the real createBridgeApp
 * HTTP handler with a real StateStore and a real PhaseOrchestrator whose intent
 * store is the ACTUAL session_params column (patchSessionParams), so the durable
 * verdict intent is proven end-to-end, not mocked.
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import type { AutoQaCoordinator } from "../bridge/auto-qa-coordinator.js";
import {
	PhaseOrchestrator,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../bridge/phase-orchestrator.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { patchSessionParams } from "../bridge/proofshot-session.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	} as BridgeConfig;
}

describe("event-route qa_result split (FLY-859)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let fixStarts: Array<Record<string, unknown>>;
	let autoQaVerdicts: number;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	async function postEvent(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
	}

	function readIntent(execId: string): ThreeStageVerdictIntent | undefined {
		return store.getSessionParams(execId)?.three_stage_verdict as
			| ThreeStageVerdictIntent
			| undefined;
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		fixStarts = [];
		autoQaVerdicts = 0;

		// Real orchestrator over the REAL store — the same wiring plugin.ts uses.
		const orchestrator = new PhaseOrchestrator({
			startDispatcher: {
				start: async (req) => {
					fixStarts.push(req as unknown as Record<string, unknown>);
					return { executionId: "fix-exec-1" };
				},
			},
			effects: {
				capturePhaseHeadSha: async () => "f".repeat(40),
				closePhaseRunner: async () => {},
				alertLeadPipelineError: async () => {},
				// FLY-887: keep-alive effects (unused here — this suite pins the
				// LEGACY close-and-respawn FLY-859 flow via keepAliveEnabled=false).
				probePhaseAlive: async () => "alive",
				probeGhostTmux: async () => "absent",
				parkPhaseRunner: async () => {},
				wakePhaseRunner: async () => ({ ok: true }),
				assertPhaseWorktreeReady: async () => ({ ok: true }),
			},
			resolveThreeStage: () => ({ enabled: true }),
			resolveLeadId: () => "test-lead",
			listStrandedDesignPhases: () => [],
			listStrandedImplementPhases: () => [],
			listPhaseSessionRows: () => [],
			// FLY-887: this suite asserts the LEGACY FAIL flow (close + spawn +
			// intent.closed), which is exactly the keep-alive=OFF byte-compat path.
			keepAliveEnabled: () => false,
			getAlivePhaseSession: () => undefined,
			grantTurn: () => {},
			// FLY-921 Fix C: empty belt — this suite never exercises the reconcile.
			turnBelt: {
				listTurns: () => [],
				getTurn: () => null,
				deleteTurn: () => {},
				getSessionForTurnHolder: () => undefined,
				getPhaseSessionsForIssue: () => [],
			},
			qaVerdicts: {
				getSession: (id) =>
					store.getSession(id) as unknown as PhaseSession | undefined,
				readIntent,
				patchIntent: (id, patch) => {
					patchSessionParams(store, id, (cur) => ({
						...cur,
						three_stage_verdict: {
							...((cur.three_stage_verdict as Record<string, unknown>) ?? {}),
							...patch,
						},
					}));
				},
				countImplementPhases: (issueId) =>
					store.countSessionsByIssueAndChatThreadRole(issueId, "implement"),
				recordFixRound: () => 1,
				getActiveImplementSession: () => undefined,
				listVerdictEventCandidates: () =>
					store.getThreeStageQaSessionsWithVerdictEvents() as unknown as PhaseSession[],
				getLatestQaResultEvent: (id) =>
					store.getLatestQaResultEventForExecution(id),
				listStrandedPassCandidates: () =>
					store.getStrandedThreeStageQaPassSessions() as unknown as PhaseSession[],
				postIssueThread: async () => {},
				hasGateResponse: () => false,
			},
		});

		// The auto-QA holder only needs onQaResult observability here.
		const autoQaSpy = {
			onQaResult: async () => {
				autoQaVerdicts += 1;
			},
		} as unknown as AutoQaCoordinator;

		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				autoQaCoordinator: { current: autoQaSpy },
				phaseOrchestrator: { current: orchestrator },
			},
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		vi.restoreAllMocks();
	});

	function seedQaPhaseSession(execId: string, issueId = "FLY-851") {
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			project_name: "flywheel",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
		});
	}

	function seedAutoQaSession(execId: string) {
		store.upsertSession({
			execution_id: execId,
			issue_id: "QA-ISSUE",
			project_name: "flywheel",
			status: "running",
			session_role: "qa",
			chat_thread_role: "main",
		});
	}

	function qaResultEvent(
		execId: string,
		status: string,
		eventId = `evt-${status}-${execId}`,
	) {
		return {
			event_id: eventId,
			execution_id: execId,
			issue_id: "FLY-851",
			project_name: "flywheel",
			event_type: "qa_result",
			payload: {
				status,
				targetExecutionId: execId,
				qaExecutionId: execId,
				summary: "routing test",
			},
		};
	}

	it("three-stage QA PASS → intent persisted in session_params; auto-QA never invoked", async () => {
		seedQaPhaseSession("qa-phase-1");
		const res = await postEvent(qaResultEvent("qa-phase-1", "pass", "ev-pass"));
		expect(res.status).toBe(200);
		expect(readIntent("qa-phase-1")).toMatchObject({
			status: "pass",
			event_id: "ev-pass",
		});
		expect(autoQaVerdicts).toBe(0);
		expect(fixStarts).toHaveLength(0);
	});

	it("three-stage QA FAIL → Implement-fix dispatched (durable intent complete); auto-QA never invoked", async () => {
		seedQaPhaseSession("qa-phase-2");
		// one prior implement phase exists (the initial one)
		store.upsertSession({
			execution_id: "impl-1",
			issue_id: "FLY-851",
			project_name: "flywheel",
			status: "completed",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		const res = await postEvent(qaResultEvent("qa-phase-2", "fail", "ev-fail"));
		expect(res.status).toBe(200);
		expect(fixStarts).toHaveLength(1);
		expect(fixStarts[0]).toMatchObject({
			issueId: "FLY-851",
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: "f".repeat(40),
		});
		expect(readIntent("qa-phase-2")).toMatchObject({
			status: "fail",
			event_id: "ev-fail",
			closed: true,
			fixExecId: "fix-exec-1",
		});
		expect(autoQaVerdicts).toBe(0);
	});

	it("duplicate event_id → deduped upstream; the fix-loop runs exactly once", async () => {
		seedQaPhaseSession("qa-phase-3");
		await postEvent(qaResultEvent("qa-phase-3", "fail", "ev-dup"));
		const second = await postEvent(
			qaResultEvent("qa-phase-3", "fail", "ev-dup"),
		);
		expect(second.status).toBe(200);
		expect((await second.json()).duplicate).toBe(true);
		expect(fixStarts).toHaveLength(1);
	});

	it("auto-QA verdict (role qa, chat_thread_role main) → falls through to AutoQaCoordinator byte-for-byte", async () => {
		seedAutoQaSession("autoqa-1");
		await postEvent(qaResultEvent("autoqa-1", "pass"));
		expect(autoQaVerdicts).toBe(1);
		expect(readIntent("autoqa-1")).toBeUndefined();
		expect(fixStarts).toHaveLength(0);
	});

	it("unknown reporting session → falls through to AutoQaCoordinator (existing behavior)", async () => {
		await postEvent(qaResultEvent("ghost-exec", "pass"));
		expect(autoQaVerdicts).toBe(1);
	});
});
