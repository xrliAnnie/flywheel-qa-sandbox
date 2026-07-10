/**
 * FLY-1050 — terminate-action wiring pins for the QA-loss re-drive. A
 * terminate of a three-stage QA row must fire the orchestrator's scoped
 * `reconcileQaLoss` (then the scoped belt reconcile) — terminate previously
 * notified the orchestrator of NOTHING (the FLY-967 strand). Pinned on BOTH
 * router mounts (/actions dashboard alias + /api/actions — the FLY-175
 * dual-mount lesson) and on the cleanupPending shape (success:false +
 * cleanupPending:true — the FSM row is terminal either way, Codex R1 #2).
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import type { PhaseOrchestrator } from "../bridge/phase-orchestrator.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// The cleanupPending shape needs a found-but-unkillable tmux target; the happy
// path needs a hermetic "gone" lookup (no real CommDB reads). Both are module
// state toggled per test.
let lookupMode: "gone" | "found-unkillable" = "gone";
vi.mock("../bridge/tmux-lookup.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../bridge/tmux-lookup.js")>();
	return {
		...actual,
		lookupTmuxTarget: vi.fn(() =>
			lookupMode === "gone"
				? { kind: "gone" as const }
				: {
						kind: "found" as const,
						target: { tmuxWindow: "t:@9", sessionName: "t" },
					},
		),
		killCmuxLinkedSession: vi.fn(async () => ({ killed: true })),
		killTmuxWindow: vi.fn(async () => ({
			killed: false,
			error: "tmux kill exploded",
		})),
	};
});

const testProjects: ProjectEntry[] = [
	{
		projectName: "fly1050-proj",
		projectRoot: "/tmp/fly1050-proj",
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

describe("terminate → QA-loss re-drive wiring (FLY-1050)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let qaLossCalls: Array<Record<string, unknown>>;
	let callOrder: string[];

	async function postAction(mount: string, body: Record<string, unknown>) {
		return fetch(`${baseUrl}${mount}/terminate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		lookupMode = "gone";
		store = await StateStore.create(":memory:");
		qaLossCalls = [];
		callOrder = [];

		const fakeOrchestrator = {
			onPhaseComplete: vi.fn(async () => {}),
			reconcileQaLoss: vi.fn(async (scope: Record<string, unknown>) => {
				qaLossCalls.push(scope);
				callOrder.push("qaLoss");
			}),
			reconcileTurnBelt: vi.fn(async () => {
				callOrder.push("belt");
			}),
		} as unknown as PhaseOrchestrator;

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
				phaseOrchestrator: { current: fakeOrchestrator },
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
		store.close();
	});

	function seedSession(execId: string, role: string, status = "running") {
		store.upsertSession({
			execution_id: execId,
			issue_id: "FLY-967",
			project_name: "fly1050-proj",
			status,
			session_role: role,
			chat_thread_role: role === "main" ? "main" : role,
		});
	}

	it("dashboard mount /actions: terminating a three-stage QA row fires reconcileQaLoss, then the belt", async () => {
		seedSession("qa-exec-1", "qa");
		const res = await postAction("/actions", { execution_id: "qa-exec-1" });
		expect(res.status).toBe(200);
		expect(store.getSession("qa-exec-1")!.status).toBe("terminated");
		// fire-and-forget → wait for the async chain
		await vi.waitFor(() => {
			expect(qaLossCalls).toHaveLength(1);
			expect(callOrder).toEqual(["qaLoss", "belt"]);
		});
		expect(qaLossCalls[0]).toMatchObject({
			issueId: "FLY-967",
			terminalExecId: "qa-exec-1",
		});
	});

	it("API mount /api/actions (FLY-175 dual-mount): same trigger", async () => {
		seedSession("qa-exec-2", "qa");
		const res = await postAction("/api/actions", { execution_id: "qa-exec-2" });
		expect(res.status).toBe(200);
		await vi.waitFor(() => {
			expect(qaLossCalls).toHaveLength(1);
		});
		expect(qaLossCalls[0]).toMatchObject({ terminalExecId: "qa-exec-2" });
	});

	it("cleanupPending (success:false + cleanupPending:true) STILL triggers — the FSM row is terminal", async () => {
		lookupMode = "found-unkillable";
		seedSession("qa-exec-3", "qa");
		const res = await postAction("/actions", { execution_id: "qa-exec-3" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cleanupPending).toBe(true);
		expect(store.getSession("qa-exec-3")!.status).toBe("terminated");
		await vi.waitFor(() => {
			expect(qaLossCalls).toHaveLength(1);
			expect(qaLossCalls[0]).toMatchObject({ terminalExecId: "qa-exec-3" });
		});
	});

	it("terminating a non-qa phase row does NOT fire reconcileQaLoss", async () => {
		seedSession("impl-exec-1", "implement");
		const res = await postAction("/actions", { execution_id: "impl-exec-1" });
		expect(res.status).toBe(200);
		// give any stray async chain a beat, then assert silence
		await new Promise((r) => setTimeout(r, 50));
		expect(qaLossCalls).toHaveLength(0);
	});

	it("terminating a main-role session does NOT fire reconcileQaLoss (byte-compat)", async () => {
		seedSession("main-exec-1", "main");
		const res = await postAction("/actions", { execution_id: "main-exec-1" });
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));
		expect(qaLossCalls).toHaveLength(0);
	});
});
