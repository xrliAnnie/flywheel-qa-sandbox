import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpsert } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

const BASE = Date.parse("2026-08-12T12:00:00.000Z");

function failedSession(
	executionId: string,
	startedAtMs: number,
	lifetimeMs: number,
	overrides: Partial<SessionUpsert> = {},
): SessionUpsert {
	return {
		execution_id: executionId,
		issue_id: "issue-uuid",
		issue_identifier: "FLY-1718",
		project_name: "flywheel",
		status: "failed",
		session_role: "main",
		started_at: new Date(startedAtMs).toISOString(),
		last_activity_at: new Date(startedAtMs + lifetimeMs).toISOString(),
		...overrides,
	};
}

function evaluate(
	store: StateStore,
	successorExecutionId: string,
	nowMs = BASE,
) {
	return store.evaluateDoaBackoff({
		projectName: "flywheel",
		lifecycleRootUuid: "issue-uuid",
		issueKeys: ["issue-uuid", "FLY-1718"],
		issueId: "issue-uuid",
		role: "main",
		leadId: "flywheel-eng-lead",
		successorExecutionId,
		nowMs,
		thresholdMs: 60_000,
		leaseMs: 10 * 60_000,
	});
}

describe("StateStore DOA re-dispatch backoff", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("counts only failed predecessors with lifetime strictly below 60 seconds", () => {
		store.upsertSession(failedSession("failed-59", BASE - 59_000, 59_000));
		const first = evaluate(store, "successor-1");
		expect(first).toMatchObject({
			ok: false,
			status: "backoff",
			count: 1,
			predecessorExecutionId: "failed-59",
			nextEligibleAtMs: BASE + 60_000,
		});

		store.resetDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: "issue-uuid",
			role: "main",
			actor: "test",
			reason: "boundary",
			nowMs: BASE + 1,
		});
		store.upsertSession(
			failedSession("failed-60", BASE + 1_000, 60_000, {
				issue_id: "issue-60",
				issue_identifier: "FLY-60",
			}),
		);
		const boundary = store.evaluateDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: "issue-60",
			issueKeys: ["issue-60", "FLY-60"],
			issueId: "issue-60",
			role: "main",
			leadId: "flywheel-eng-lead",
			successorExecutionId: "successor-60",
			nowMs: BASE + 61_000,
			thresholdMs: 60_000,
			leaseMs: 600_000,
		});
		expect(boundary).toMatchObject({ ok: true, status: "allow", count: 0 });
	});

	it("uses 1m/2m/4m/8m delays, counts a predecessor once, and fences owners", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		expect(evaluate(store, "successor-1")).toMatchObject({
			ok: false,
			status: "backoff",
			count: 1,
			nextEligibleAtMs: BASE + 60_000,
		});
		expect(evaluate(store, "successor-1", BASE + 30_000)).toMatchObject({
			ok: false,
			status: "backoff",
			count: 1,
		});

		const reserved = evaluate(store, "successor-1", BASE + 60_000);
		expect(reserved).toMatchObject({
			ok: true,
			status: "reserved",
			count: 1,
			ownerExecutionId: "successor-1",
		});
		expect(evaluate(store, "successor-1", BASE + 61_000)).toMatchObject({
			ok: true,
			status: "reserved",
			ownerExecutionId: "successor-1",
		});
		expect(evaluate(store, "successor-2", BASE + 61_000)).toMatchObject({
			ok: false,
			status: "reserved",
			ownerExecutionId: "successor-1",
		});

		store.insertLaunchClaim({
			executionId: "successor-1",
			rootUuid: "issue-uuid",
			project: "flywheel",
			role: "main",
		});
		store.bindWorktreeOnce(
			"successor-1",
			{ path: "/tmp/wt", branch: "flywheel-FLY-1718", generation: "g1" },
			{ issueId: "issue-uuid", projectName: "flywheel" },
		);
		expect(store.activateLaunchAndSettleDoa("successor-1")).toEqual({
			ok: true,
		});

		store.upsertSession(failedSession("successor-1", BASE + 60_000, 20_000));
		const second = evaluate(store, "successor-2", BASE + 80_000);
		expect(second).toMatchObject({
			ok: false,
			status: "backoff",
			count: 2,
			nextEligibleAtMs: BASE + 80_000 + 120_000,
		});
	});

	it("does not let an unsettled failed attempt advance the generation", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "unsettled", BASE);
		evaluate(store, "unsettled", BASE + 60_000);
		store.closeLaunchAndReleaseDoa("unsettled", BASE + 61_000);
		store.upsertSession(failedSession("unsettled", BASE + 60_000, 10_000));

		const retry = evaluate(store, "real-successor", BASE + 70_000);
		expect(retry).toMatchObject({
			ok: true,
			status: "reserved",
			count: 1,
			predecessorExecutionId: "failed-1",
		});
	});

	it("resets the lane after a newer healthy or non-failed predecessor", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "successor", BASE);
		store.upsertSession({
			...failedSession("manual-success", BASE + 1_000, 90_000),
			status: "completed",
		});
		expect(evaluate(store, "next", BASE + 91_000)).toMatchObject({
			ok: true,
			status: "allow",
			count: 0,
			reason: "predecessor_not_doa",
		});
		expect(
			store.getDoaBackoffLedger("flywheel", "issue-uuid", "main"),
		).toBeUndefined();
	});

	it("keeps an expired reservation fenced when its owner has a worktree binding", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "owner", BASE);
		evaluate(store, "owner", BASE + 60_000);
		store.bindWorktreeOnce(
			"owner",
			{ path: "/tmp/owner", branch: "flywheel-FLY-1718", generation: "g1" },
			{ issueId: "issue-uuid", projectName: "flywheel" },
		);

		expect(evaluate(store, "contender", BASE + 11 * 60_000)).toMatchObject({
			ok: false,
			status: "reserved",
			ownerExecutionId: "owner",
			reason: "bound_owner_fenced",
		});
	});

	it("renews the current owner at commit and refuses an owner that lost its lease", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "old-owner", BASE);
		evaluate(store, "old-owner", BASE + 60_000);
		store.insertLaunchClaim({
			executionId: "old-owner",
			rootUuid: "issue-uuid",
			project: "flywheel",
			role: "main",
		});
		expect(
			store.verifyAndRenewDoaReleaseOwner("old-owner", BASE + 61_000, 600_000),
		).toEqual({ ok: true });
		expect(
			store.getDoaBackoffLedger("flywheel", "issue-uuid", "main"),
		).toMatchObject({ releaseLeaseExpiresAtMs: BASE + 661_000 });

		const contenderTime = BASE + 662_000;
		expect(evaluate(store, "new-owner", contenderTime)).toMatchObject({
			ok: true,
			status: "reserved",
			ownerExecutionId: "new-owner",
		});
		expect(
			store.verifyAndRenewDoaReleaseOwner("old-owner", contenderTime, 600_000),
		).toEqual({ ok: false, reason: "doa_reservation_lost" });
		store.bindWorktreeOnce(
			"old-owner",
			{ path: "/tmp/old", branch: "flywheel-FLY-1718", generation: "old" },
			{ issueId: "issue-uuid", projectName: "flywheel" },
		);
		expect(store.activateLaunchAndSettleDoa("old-owner")).toEqual({
			ok: false,
			reason: "doa_reservation_lost",
		});
	});

	it("does not fence an admission-exempt execution behind another lane owner", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "reserved-owner", BASE);
		expect(evaluate(store, "reserved-owner", BASE + 60_000)).toMatchObject({
			ok: true,
			status: "reserved",
			ownerExecutionId: "reserved-owner",
		});

		store.insertLaunchClaim({
			executionId: "auto-qa-exempt",
			rootUuid: "issue-uuid",
			project: "flywheel",
			role: "main",
		});
		store.bindWorktreeOnce(
			"auto-qa-exempt",
			{
				path: "/tmp/auto-qa",
				branch: "flywheel-FLY-1718-qa",
				generation: "auto-qa",
			},
			{ issueId: "issue-uuid", projectName: "flywheel" },
		);

		expect(
			store.verifyAndRenewDoaReleaseOwner(
				"auto-qa-exempt",
				BASE + 61_000,
				600_000,
			),
		).toEqual({ ok: true });
		expect(store.activateLaunchAndSettleDoa("auto-qa-exempt")).toEqual({
			ok: true,
		});
		expect(store.getLaunchClaim("auto-qa-exempt")).toMatchObject({
			state: "active",
		});
		expect(
			store.getDoaBackoffLedger("flywheel", "issue-uuid", "main"),
		).toMatchObject({
			releaseState: "reserved",
			releaseOwnerExecutionId: "reserved-owner",
		});
	});

	it("moves the fifth settled DOA failure to needs_lead with one durable alert", () => {
		let now = BASE;
		let predecessor = "failed-1";
		store.upsertSession(failedSession(predecessor, now - 30_000, 30_000));

		for (let count = 1; count <= 4; count += 1) {
			const successor = `successor-${count}`;
			const blocked = evaluate(store, successor, now);
			expect(blocked).toMatchObject({ count, status: "backoff" });
			now = blocked.nextEligibleAtMs!;
			const release = evaluate(store, successor, now);
			expect(release).toMatchObject({
				ok: true,
				status: "reserved",
			});
			store.insertLaunchClaim({
				executionId: successor,
				rootUuid: "issue-uuid",
				project: "flywheel",
				role: "main",
			});
			store.bindWorktreeOnce(
				successor,
				{
					path: `/tmp/${successor}`,
					branch: "flywheel-FLY-1718",
					generation: `g${count}`,
				},
				{ issueId: "issue-uuid", projectName: "flywheel" },
			);
			store.activateLaunchAndSettleDoa(successor);
			store.upsertSession(failedSession(successor, now, 10_000));
			predecessor = successor;
			now += 10_000;
		}

		expect(evaluate(store, "successor-5", now)).toMatchObject({
			ok: false,
			status: "needs_lead",
			count: 5,
			predecessorExecutionId: predecessor,
		});
		expect(evaluate(store, "successor-5b", now + 1)).toMatchObject({
			ok: false,
			status: "needs_lead",
			count: 5,
		});
		store.upsertSession({
			...failedSession("manual-success", now + 2, 90_000),
			status: "completed",
		});
		expect(
			evaluate(store, "successor-after-success", now + 90_002),
		).toMatchObject({
			ok: false,
			status: "needs_lead",
			count: 5,
		});
		const alerts = store.listPendingDoaBackoffAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({
			projectName: "flywheel",
			lifecycleRootUuid: "issue-uuid",
			role: "main",
			leadId: "flywheel-eng-lead",
			count: 5,
		});
		expect(store.markDoaBackoffAlertDelivered(alerts[0]!.alertId, now)).toBe(
			true,
		);
		expect(store.listPendingDoaBackoffAlerts()).toEqual([]);
	});

	it("resets a lane and writes the operator receipt in the same transaction", () => {
		store.upsertSession(failedSession("failed-1", BASE - 30_000, 30_000));
		evaluate(store, "successor-1");

		const result = store.resetDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: "issue-uuid",
			role: "main",
			actor: "master-api-token",
			reason: "operator investigated predecessor",
			nowMs: BASE + 1,
		});
		expect(result).toMatchObject({ reset: true, previousCount: 1 });
		expect(
			store.getDoaBackoffLedger("flywheel", "issue-uuid", "main"),
		).toMatchObject({ count: 0, state: "active", releaseState: "none" });
		expect(evaluate(store, "operator-successor", BASE + 1)).toMatchObject({
			ok: true,
			status: "reserved",
			count: 0,
			ownerExecutionId: "operator-successor",
		});
		expect(store.listDoaBackoffResetReceipts()).toEqual([
			expect.objectContaining({
				actor: "master-api-token",
				reason: "operator investigated predecessor",
				previousCount: 1,
			}),
		]);
	});
});
