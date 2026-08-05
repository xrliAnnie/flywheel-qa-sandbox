import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commDbPath: "",
	sendRunnerWake: vi.fn(async () => ({ ok: true })),
	liveness: "alive" as "alive" | "absent",
	serverStartTime: "1722700001",
	alert: vi.fn(async () => ({ sent: true })),
}));

vi.mock("../session-capture.js", () => ({
	defaultGetCommDbPath: () => mocks.commDbPath,
}));

vi.mock("../runner-wake.js", () => ({
	sendRunnerWake: (...args: unknown[]) => mocks.sendRunnerWake(...args),
}));

vi.mock("../tmux-lookup.js", () => ({
	lookupTmuxTarget: () => ({
		kind: "found",
		target: { tmuxWindow: "runner-flywheel:@1505" },
	}),
	probeRunnerProcessLiveness: async () => mocks.liveness,
	discoverTmuxTargetByExecutionId: async () => ({ kind: "missing" }),
	probeTmuxServerStartTime: async () => ({
		kind: "found",
		startTime: mocks.serverStartTime,
	}),
}));

import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const HEAD = "a".repeat(40);

type PrivatePoller = {
	staleApprovedShipReconcilePass(): Promise<void>;
};

function staleSession(sessionParams?: string) {
	return {
		execution_id: "exec-1505",
		issue_id: "FLY-1505",
		project_name: "flywheel",
		status: "approved_to_ship",
		review_question_id: "11111111-1111-1111-1111-111111111111",
		pr_head_sha: HEAD,
		last_activity_at: new Date(Date.now() - 10 * 60_000)
			.toISOString()
			.replace("T", " ")
			.replace("Z", ""),
		session_params: sessionParams,
	};
}

function makePoller(session: ReturnType<typeof staleSession>): GatePoller {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/flywheel",
				leads: [
					{
						agentId: "flywheel-eng-lead",
						chatChannel: "thread",
						match: { labels: [] },
					},
				],
			},
		],
		store: {
			getActiveSessions: () => [session],
			getSession: () => session,
			insertEvent: vi.fn(() => true),
		} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as GatePollerConfig["runtimeRegistry"],
		leadAlertSink: { alert: mocks.alert },
	});
}

describe("FLY-1505 GatePoller same-head ship-attempt suppression", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly1505-gate-poller-"));
		mocks.commDbPath = join(tmp, "flywheel", "comm.db");
		mkdirSync(dirname(mocks.commDbPath), { recursive: true });
		new CommDB(mocks.commDbPath).close();
		mocks.sendRunnerWake.mockClear();
		mocks.alert.mockClear();
		mocks.liveness = "alive";
		mocks.serverStartTime = "1722700001";
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reads the real session_params JSON seam and does not auto-wake the failed current head", async () => {
		const session = staleSession(
			JSON.stringify({
				fly1505_ship_attempt_failed: {
					head_sha: HEAD,
					attempt_count: 1,
					review_question_id: "11111111-1111-1111-1111-111111111111",
				},
			}),
		);
		await (
			makePoller(session) as unknown as PrivatePoller
		).staleApprovedShipReconcilePass();
		expect(mocks.sendRunnerWake).not.toHaveBeenCalled();
	});

	it("re-enables recovery when the founder opened a fresh approval binding on the same head", async () => {
		const session = staleSession(
			JSON.stringify({
				fly1505_ship_attempt_failed: {
					head_sha: HEAD,
					attempt_count: 1,
					review_question_id: "old-review-question",
				},
			}),
		);
		await (
			makePoller(session) as unknown as PrivatePoller
		).staleApprovedShipReconcilePass();
		expect(mocks.sendRunnerWake).toHaveBeenCalledOnce();
	});

	it("keeps the existing fail-open re-wake for a markerless stranded approval", async () => {
		await (
			makePoller(staleSession()) as unknown as PrivatePoller
		).staleApprovedShipReconcilePass();
		expect(mocks.sendRunnerWake).toHaveBeenCalledOnce();
	});

	it("classifies superseded-generation absence as dead once and stops re-wake noise", async () => {
		mocks.liveness = "absent";
		const session = staleSession(
			JSON.stringify({
				pane_loss_generation: {
					socket_path: "/tmp/tmux-501/default",
					server_start_time: "1722700000",
				},
			}),
		);
		const poller = makePoller(session) as unknown as PrivatePoller;

		await poller.staleApprovedShipReconcilePass();
		await poller.staleApprovedShipReconcilePass();

		expect(mocks.sendRunnerWake).not.toHaveBeenCalled();
		expect(mocks.alert).toHaveBeenCalledOnce();
	});

	it("keeps same-generation absence fail-open to the idempotent re-wake", async () => {
		mocks.liveness = "absent";
		mocks.serverStartTime = "1722700000";
		const session = staleSession(
			JSON.stringify({
				pane_loss_generation: {
					socket_path: "/tmp/tmux-501/default",
					server_start_time: "1722700000",
				},
			}),
		);

		await (
			makePoller(session) as unknown as PrivatePoller
		).staleApprovedShipReconcilePass();

		expect(mocks.sendRunnerWake).toHaveBeenCalledOnce();
		expect(mocks.alert).not.toHaveBeenCalled();
	});

	it("never classifies a Codex tmux absence as dead", async () => {
		mocks.liveness = "absent";
		const session = {
			...staleSession(),
			adapter_type: "codex-tmux",
		};

		await (
			makePoller(session) as unknown as PrivatePoller
		).staleApprovedShipReconcilePass();

		expect(mocks.sendRunnerWake).toHaveBeenCalledOnce();
		expect(mocks.alert).not.toHaveBeenCalled();
	});
});
