import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commDbPath: "",
	sendRunnerWake: vi.fn(async () => ({ ok: true })),
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
	probeRunnerProcessLiveness: async () => "alive",
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
		projects: [],
		store: {
			getActiveSessions: () => [session],
		} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as GatePollerConfig["runtimeRegistry"],
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
});
