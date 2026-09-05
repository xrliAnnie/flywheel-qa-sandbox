import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { RESIDENT_GRACE_MS } from "../bridge/resident-hold.js";
import { StateStore } from "../StateStore.js";

const T0 = Date.parse("2026-09-04T00:00:00.000Z");
const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

async function fixture(vendor: "claude" | "codex") {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2268",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	const admitted = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "repair-any-name",
		executionId: "exec-1",
		attempt: 1,
		family: "review_verdict",
		expiresAt: "2026-09-04T01:00:00.000Z",
		absoluteDeadlineAt: "2026-09-04T02:00:00.000Z",
		now: "2026-09-04T00:00:00.000Z",
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-2268",
		project_name: "flywheel",
		status: "running",
		adapter_type: vendor === "codex" ? "codex-tmux" : "claude-tmux",
	});
	const entered = store.enterResidentHold({
		executionId: "exec-1",
		activationId: "activation:exec-1:run-1:repair-any-name:1",
		nodeId: "repair-any-name",
		boundarySeq: 1,
		nowMs: T0,
	});
	if (!entered.ok) throw new Error(entered.reason);
	const nowMs = T0 + RESIDENT_GRACE_MS + 1;
	const now = new Date(nowMs).toISOString();
	store.expireResidentHoldsTx(now);
	const commDb = new CommDB(":memory:");
	commDbs.push(commDb);
	return { store, commDb, now, nowMs };
}

function operations(
	store: StateStore,
	commDb: CommDB,
	residentExpiry?: {
		terminateClaude(
			executionId: string,
		): Promise<{ ok: boolean; error?: string }>;
		probeClaude(executionId: string): Promise<"alive" | "dead_pin" | "absent">;
	},
) {
	return new DeliveryOperations({
		store,
		commDb,
		projectName: "flywheel",
		resolveRecipient: () => null,
		resolveAlertIdentity: () => ({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		}),
		...(residentExpiry ? { residentExpiry } : {}),
	});
}

describe("FLY-2268 resident expiry driver", () => {
	it("uses its exact Codex shutdown request and converges after runtime ACK", async () => {
		const { store, commDb, now, nowMs } = await fixture("codex");
		commDb.requestRunnerShutdown("exec-1", "older-requested", nowMs - 3);
		commDb.requestRunnerShutdown("exec-1", "older-failed", nowMs - 2);
		commDb.finishRunnerShutdown(
			"exec-1",
			"older-failed",
			{ ok: false, error: "old failure" },
			nowMs - 1,
		);
		const runner = operations(store, commDb);
		const requestId = "resident-expiry:exec-1:r1";

		expect(await runner.runResidentExpiryPass(now)).toEqual({
			examined: 1,
			requested: 1,
			projected: 0,
			failed: 0,
		});
		expect(commDb.getRunnerShutdownRequest("exec-1", requestId)?.state).toBe(
			"requested",
		);
		expect(
			commDb.getRunnerShutdownRequest("exec-1", "older-failed")
				?.settlement_reason,
		).toBe(`superseded:${requestId}`);
		expect(store.listPendingResidentExpiryOperations()[0]?.state).toBe(
			"applied",
		);

		expect(
			commDb.finishAllPendingRunnerShutdowns("exec-1", { ok: true }, nowMs + 1),
		).toBe(2);
		expect(
			await runner.runResidentExpiryPass(new Date(nowMs + 2).toISOString()),
		).toMatchObject({ examined: 1, requested: 0, projected: 1, failed: 0 });
		expect(store.getResidentHold("exec-1")).toMatchObject({
			state: "closed",
			closed_reason: "expired",
		});
		expect(
			await runner.runResidentExpiryPass(new Date(nowMs + 3).toISOString()),
		).toEqual({ examined: 0, requested: 0, projected: 0, failed: 0 });
	});

	it("fails an incompatible legacy CommDB schema instead of retrying forever", async () => {
		const { store, commDb, now } = await fixture("codex");
		vi.spyOn(commDb, "settleFailedRunnerShutdowns").mockImplementation(() => {
			throw new Error("no such column: settlement_reason");
		});
		const runner = operations(store, commDb);

		expect(await runner.runResidentExpiryPass(now)).toEqual({
			examined: 1,
			requested: 0,
			projected: 0,
			failed: 1,
		});
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);
	});

	it("terminates a Claude pane and projects only after process-dead proof", async () => {
		const { store, commDb, now } = await fixture("claude");
		const terminateClaude = vi.fn(async () => ({ ok: true }));
		const probeClaude = vi.fn(async () => "dead_pin" as const);
		const runner = operations(store, commDb, {
			terminateClaude,
			probeClaude,
		});

		expect(await runner.runResidentExpiryPass(now)).toMatchObject({
			examined: 1,
			requested: 1,
			projected: 1,
			failed: 0,
		});
		expect(terminateClaude).toHaveBeenCalledOnce();
		expect(probeClaude).toHaveBeenCalledOnce();
		expect(store.getResidentHold("exec-1")?.state).toBe("closed");
	});
});
