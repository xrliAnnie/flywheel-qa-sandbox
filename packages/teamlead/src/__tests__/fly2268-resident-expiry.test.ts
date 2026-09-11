import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { RESIDENT_GRACE_MS } from "../bridge/resident-hold.js";
import { StateStore } from "../StateStore.js";

const T0 = Date.parse("2026-09-04T00:00:00.000Z");
const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function fixture(vendor: "claude" | "codex", storePath = ":memory:") {
	const store = await StateStore.create(storePath);
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
		probeTarget(
			executionId: string,
		): Promise<"alive" | "dead_pin" | "absent" | "indeterminate">;
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

	it("projects a requested Codex shutdown with absent registry and absent target", async () => {
		const { store, commDb, now } = await fixture("codex");
		const probeTarget = vi.fn(async () => "absent" as const);
		const runner = operations(store, commDb, {
			terminateClaude: vi.fn(async () => ({ ok: true })),
			probeTarget,
		});
		expect(await runner.runResidentExpiryPass(now)).toMatchObject({
			requested: 1,
			projected: 1,
			failed: 0,
		});
		expect(probeTarget).toHaveBeenCalledWith("exec-1");
		expect(store.getResidentHold("exec-1")?.state).toBe("closed");
	});

	it.each(["absent", "dead_pin"] as const)(
		"projects a missing shutdown with a nonrunning registry and %s target",
		async (liveness) => {
			const { store, commDb, now } = await fixture("codex");
			store.applyResidentExpiry({
				operationId: "resident-expiry:exec-1:r1",
				now,
			});
			commDb.registerSession("exec-1", "pane-1", "flywheel");
			commDb.updateSessionStatus("exec-1", "completed");
			const probeTarget = vi.fn(async () => liveness);
			const runner = operations(store, commDb, {
				terminateClaude: vi.fn(async () => ({ ok: true })),
				probeTarget,
			});
			expect(await runner.runResidentExpiryPass(now)).toMatchObject({
				projected: 1,
				failed: 0,
			});
			expect(probeTarget).toHaveBeenCalledOnce();
			expect(
				await operations(store, commDb).runResidentExpiryPass(now),
			).toEqual({
				examined: 0,
				requested: 0,
				projected: 0,
				failed: 0,
			});
		},
	);

	it("does not probe or project while the Codex registry is running", async () => {
		const { store, commDb, now } = await fixture("codex");
		commDb.registerSession("exec-1", "pane-1", "flywheel");
		const probeTarget = vi.fn(async () => "absent" as const);
		expect(
			await operations(store, commDb, {
				terminateClaude: vi.fn(async () => ({ ok: true })),
				probeTarget,
			}).runResidentExpiryPass(now),
		).toMatchObject({ projected: 0, failed: 0 });
		expect(probeTarget).not.toHaveBeenCalled();
		expect(store.listPendingResidentExpiryOperations()[0]?.state).toBe(
			"applied",
		);
	});

	it.each(["alive", "indeterminate"] as const)(
		"keeps Codex expiry pending for a nonrunning registry with %s target",
		async (liveness) => {
			const { store, commDb, now } = await fixture("codex");
			commDb.registerSession("exec-1", "pane-1", "flywheel");
			commDb.updateSessionStatus("exec-1", "completed");
			const probeTarget = vi.fn(async () => liveness);
			expect(
				await operations(store, commDb, {
					terminateClaude: vi.fn(async () => ({ ok: true })),
					probeTarget,
				}).runResidentExpiryPass(now),
			).toMatchObject({ projected: 0, failed: 0 });
			expect(probeTarget).toHaveBeenCalledOnce();
			expect(store.listPendingResidentExpiryOperations()[0]?.state).toBe(
				"applied",
			);
		},
	);

	it.each(["codex", "claude"] as const)(
		"defers a %s probe exception and retries applied state after database reopen",
		async (vendor) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2478-expiry-"));
			tempDirs.push(dir);
			const storePath = join(dir, "teamlead.db");
			const { store, commDb, now } = await fixture(vendor, storePath);
			const failed = vi.spyOn(store, "markResidentExpiryFailed");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const terminateClaude = vi.fn(async () => ({ ok: true }));
			const probeTarget = vi
				.fn<() => Promise<"absent">>()
				.mockRejectedValueOnce(new Error("tmux transient timeout"))
				.mockResolvedValue("absent");
			expect(
				await operations(store, commDb, {
					terminateClaude,
					probeTarget,
				}).runResidentExpiryPass(now),
			).toMatchObject({ projected: 0, failed: 0 });
			expect(store.listPendingResidentExpiryOperations()[0]?.state).toBe(
				"applied",
			);
			expect(failed).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalled();
			store.close();
			stores.splice(stores.indexOf(store), 1);
			const reopened = await StateStore.create(storePath);
			stores.push(reopened);
			expect(reopened.listPendingResidentExpiryOperations()[0]?.state).toBe(
				"applied",
			);
			expect(
				await operations(reopened, commDb, {
					terminateClaude,
					probeTarget,
				}).runResidentExpiryPass(now),
			).toMatchObject({ requested: 0, projected: 1, failed: 0 });
			expect(terminateClaude).toHaveBeenCalledTimes(
				vendor === "claude" ? 1 : 0,
			);
		},
	);

	it("defers a Codex registry read exception without probing or failing", async () => {
		const { store, commDb, now } = await fixture("codex");
		const failed = vi.spyOn(store, "markResidentExpiryFailed");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(commDb, "getSession").mockImplementation(() => {
			throw new Error("database busy");
		});
		const probeTarget = vi.fn(async () => "absent" as const);
		expect(
			await operations(store, commDb, {
				terminateClaude: vi.fn(async () => ({ ok: true })),
				probeTarget,
			}).runResidentExpiryPass(now),
		).toMatchObject({ projected: 0, failed: 0 });
		expect(store.listPendingResidentExpiryOperations()[0]?.state).toBe(
			"applied",
		);
		expect(failed).not.toHaveBeenCalled();
		expect(probeTarget).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});

	it("retains explicit Codex shutdown failure even if the target is absent", async () => {
		const { store, commDb, now, nowMs } = await fixture("codex");
		await operations(store, commDb).runResidentExpiryPass(now);
		commDb.finishRunnerShutdown(
			"exec-1",
			"resident-expiry:exec-1:r1",
			{ ok: false, error: "shutdown rejected" },
			nowMs + 1,
		);
		const probeTarget = vi.fn(async () => "absent" as const);
		expect(
			await operations(store, commDb, {
				terminateClaude: vi.fn(async () => ({ ok: true })),
				probeTarget,
			}).runResidentExpiryPass(now),
		).toMatchObject({ projected: 0, failed: 1 });
		expect(probeTarget).not.toHaveBeenCalled();
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);
	});

	it("fails Claude expiry when effects are missing", async () => {
		const { store, commDb, now } = await fixture("claude");
		const failed = vi.spyOn(store, "markResidentExpiryFailed");
		expect(
			await operations(store, commDb).runResidentExpiryPass(now),
		).toMatchObject({ projected: 0, failed: 1 });
		expect(failed).toHaveBeenCalledWith(
			expect.objectContaining({
				error: "claude_resident_expiry_effects_missing",
			}),
		);
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
		const probeTarget = vi.fn(async () => "dead_pin" as const);
		const runner = operations(store, commDb, {
			terminateClaude,
			probeTarget,
		});

		expect(await runner.runResidentExpiryPass(now)).toMatchObject({
			examined: 1,
			requested: 1,
			projected: 1,
			failed: 0,
		});
		expect(terminateClaude).toHaveBeenCalledOnce();
		expect(probeTarget).toHaveBeenCalledOnce();
		expect(store.getResidentHold("exec-1")?.state).toBe("closed");
	});
});
