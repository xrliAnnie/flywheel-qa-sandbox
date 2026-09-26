import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { ReviewRequestCoordinator } from "../review-request-coordinator.js";

const stores: StateStore[] = [];
const coordinators: ReviewRequestCoordinator[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const c of coordinators.splice(0)) c.stop();
	for (const s of stores.splice(0)) s.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});
async function fixture(
	overrides: Record<string, unknown> = {},
	path = ":memory:",
) {
	const store = await StateStore.create(path);
	stores.push(store);
	let now = Date.parse("2026-09-26T00:00:10.000Z");
	store.insertCodexReviewJob({
		requestId: "r",
		executionId: "e",
		projectName: "p",
		questionId: "q",
		reviewType: "code",
	});
	store.claimCodexReviewJobRunning("r");
	store.recordCodexReviewAttemptIntent({
		requestId: "r",
		attemptGeneration: 1,
		reviewerSessionUuid: "s",
		ownerBootId: "old",
		reviewerStartedAt: new Date(now - 10_000).toISOString(),
		configuredTimeoutMs: 60_000,
	});
	store.retireCodexReviewJob({
		requestId: "r",
		expectedGeneration: 1,
		retiredAt: new Date(now).toISOString(),
	});
	const deliver = vi.fn(async () => ({ accepted: true }));
	const probe = vi.fn(async () => ({
		state: "unknown",
		reason: "test_unknown",
	}));
	const round = vi.fn();
	const setTimer = vi.fn(() => 1);
	const clearTimer = vi.fn();
	const coordinator = new ReviewRequestCoordinator({
		store,
		now: () => now,
		commDbPathFor: () => "unused",
		openCommDb: () => {
			throw new Error("not used");
		},
		reviewRound: round,
		deliverRecoveryNotice: deliver,
		probeRetiredAttempt: probe,
		setTimer,
		clearTimer,
		...overrides,
	});
	coordinators.push(coordinator);
	return {
		store,
		coordinator,
		deliver,
		probe,
		round,
		setTimer,
		clearTimer,
		now,
		advance: () => {
			now += 30_000;
		},
	};
}
it("retries failed delivery without spawning and does not act a notice on transport ACK", async () => {
	const h = await fixture();
	h.deliver.mockRejectedValueOnce(new Error("offline"));
	await h.coordinator.runRecoveryPass();
	expect(h.store.listPendingReviewRecoveryNotices()).toHaveLength(1);
	h.advance();
	await h.coordinator.runRecoveryPass();
	expect(h.deliver).toHaveBeenCalledTimes(2);
	expect(h.store.listPendingReviewRecoveryNotices()).toHaveLength(0);
	expect(
		h.store.listActionableReviewRecoveryNotices({
			executionId: "e",
			projectName: "p",
		}),
	).toHaveLength(1);
	expect(h.round).not.toHaveBeenCalled();
});

function diskPath() {
	const dir = mkdtempSync(join(tmpdir(), "review-pass-fairness-"));
	directories.push(dir);
	return join(dir, "state.db");
}

function retire(
	store: StateStore,
	id: string,
	now: number,
	timeoutMs = 300_000,
) {
	store.insertCodexReviewJob({
		requestId: id,
		executionId: "e",
		projectName: "p",
		questionId: `q-${id}`,
		reviewType: "code",
	});
	store.claimCodexReviewJobRunning(id);
	store.recordCodexReviewAttemptIntent({
		requestId: id,
		attemptGeneration: 1,
		reviewerSessionUuid: `session-${id}`,
		ownerBootId: "old",
		reviewerStartedAt: new Date(now).toISOString(),
		configuredTimeoutMs: timeoutMs,
	});
	store.retireCodexReviewJob({
		requestId: id,
		expectedGeneration: 1,
		retiredAt: new Date(now).toISOString(),
	});
}

function actedNotice(store: StateStore, now: number) {
	retire(store, "acted", now);
	store.transitionCodexReviewRecovery({
		requestId: "acted",
		attemptGeneration: 1,
		expectedState: "retired",
		state: "held",
		nextProbeAt: new Date(now + 300_000).toISOString(),
	});
}

async function reopen(store: StateStore, path: string) {
	stores.splice(stores.indexOf(store), 1);
	store.close();
	const restored = await StateStore.create(path);
	stores.push(restored);
	return restored;
}

it("reserves time for acted and pending notices beside a slow probe, including after persisted restart", async () => {
	const path = diskPath();
	const events: string[] = [];
	const releases: Array<(value: { state: "absent" }) => void> = [];
	const probe = vi.fn(async (job: { request_id: string }) => {
		events.push(`probe:${job.request_id}`);
		return new Promise<{ state: "absent" }>((resolve) => {
			releases.push(resolve);
		});
	});
	const mark = vi.fn(() => {
		events.push("acted");
		throw new Error("retry projection");
	});
	const deliver = vi.fn(async () => {
		events.push("deliver");
		return { accepted: false };
	});
	const overrides = {
		probeRetiredAttempt: probe,
		markRecoveryNoticeActed: mark,
		deliverRecoveryNotice: deliver,
		recoveryClock: () => Date.now(),
	};
	const h = await fixture(overrides, path);
	actedNotice(h.store, h.now);
	vi.useFakeTimers();
	vi.setSystemTime(h.now);
	let pass = h.coordinator.runRecoveryPass();
	await vi.advanceTimersByTimeAsync(5_000);
	await pass;
	expect(events).toEqual(["probe:r", "acted", "deliver"]);
	releases[0]!({ state: "absent" });
	await Promise.resolve();
	expect(h.store.getCodexReviewAttempt("r", 1)?.recovery_state).toBe("retired");
	expect(h.store.getCodexReviewAttempt("r", 1)?.next_probe_at).toBe(
		new Date(h.now + 30_000).toISOString(),
	);
	h.coordinator.stop();
	const store = await reopen(h.store, path);
	const coordinator = new ReviewRequestCoordinator({
		store,
		commDbPathFor: () => "unused",
		openCommDb: () => {
			throw new Error("unused");
		},
		now: () => h.now + 30_000,
		setTimer: () => 1,
		clearTimer: () => {},
		...overrides,
	});
	coordinators.push(coordinator);
	pass = coordinator.runRecoveryPass();
	await vi.advanceTimersByTimeAsync(5_000);
	await pass;
	expect(events).toEqual([
		"probe:r",
		"acted",
		"deliver",
		"probe:r",
		"acted",
		"deliver",
	]);
	expect(store.getCodexReviewAttempt("r", 1)?.deadline_at).toBe(
		"2026-09-26T00:01:00.000Z",
	);
}, 20_000);

it("persists cross-kind order when a synchronous acted projection consumes the remaining time", async () => {
	const path = diskPath();
	let elapsed = 0;
	const events: string[] = [];
	const mark = vi.fn(() => {
		events.push("acted");
		elapsed += 5_000;
		throw new Error("slow projection");
	});
	const deliver = vi.fn(async () => {
		events.push("deliver");
		return { accepted: true };
	});
	const probe = vi.fn(async () => {
		events.push("probe");
		return { state: "unknown" as const };
	});
	const overrides = {
		markRecoveryNoticeActed: mark,
		deliverRecoveryNotice: deliver,
		probeRetiredAttempt: probe,
		recoveryClock: () => elapsed,
	};
	const h = await fixture(overrides, path);
	actedNotice(h.store, h.now);
	await h.coordinator.runRecoveryPass();
	expect(events).toEqual(["probe", "acted"]);
	h.coordinator.stop();
	const store = await reopen(h.store, path);
	const coordinator = new ReviewRequestCoordinator({
		store,
		commDbPathFor: () => "unused",
		openCommDb: () => {
			throw new Error("unused");
		},
		now: () => h.now + 30_000,
		setTimer: () => 1,
		clearTimer: () => {},
		...overrides,
	});
	coordinators.push(coordinator);
	await coordinator.runRecoveryPass();
	expect(events).toEqual(["probe", "acted", "probe", "deliver", "acted"]);
	expect(store.listPendingReviewRecoveryNotices()).toHaveLength(0);
}, 20_000);

it("shares the 100-item budget across kinds and resumes durable cursors after restart with expiry first", async () => {
	const path = diskPath();
	const probes: string[] = [];
	const deliveries: string[] = [];
	const order: string[] = [];
	const probe = vi.fn(async (job: { request_id: string }) => {
		probes.push(job.request_id);
		order.push(job.request_id);
		return { state: "unknown" as const };
	});
	const mark = vi.fn((notice: { request_id: string }) => {
		order.push("acted");
		if (notice.request_id === "acted") throw new Error("retry projection");
	});
	const deliver = vi.fn(
		async (notice: { request_id: string; stage: string }) => {
			deliveries.push(`${notice.request_id}:${notice.stage}`);
			order.push("notice");
			return { accepted: false };
		},
	);
	const overrides = {
		probeRetiredAttempt: probe,
		markRecoveryNoticeActed: mark,
		deliverRecoveryNotice: deliver,
		recoveryClock: () => 0,
	};
	const h = await fixture(overrides, path);
	h.store.runInTransaction(() => {
		for (let index = 0; index < 99; index++)
			retire(h.store, `live-${String(index).padStart(3, "0")}`, h.now);
		retire(h.store, "zz-expired", h.now - 60_000, 1_000);
		actedNotice(h.store, h.now);
	});
	await h.coordinator.runRecoveryPass();
	expect(order[0]).toBe("zz-expired");
	expect(mark).toHaveBeenCalledWith(
		expect.objectContaining({ request_id: "acted" }),
	);
	expect(deliveries.length).toBeGreaterThan(0);
	expect(probes.length).toBeGreaterThan(0);
	expect(
		probes.length + mark.mock.calls.length + deliveries.length,
	).toBeLessThanOrEqual(100);
	const firstProbes = [...probes];
	const firstDeliveries = [...deliveries];
	const firstActed = mark.mock.calls.length;
	h.coordinator.stop();
	const store = await reopen(h.store, path);
	const coordinator = new ReviewRequestCoordinator({
		store,
		commDbPathFor: () => "unused",
		openCommDb: () => {
			throw new Error("unused");
		},
		now: () => h.now + 30_000,
		setTimer: () => 1,
		clearTimer: () => {},
		...overrides,
	});
	coordinators.push(coordinator);
	await coordinator.runRecoveryPass();
	expect(probes.length).toBeGreaterThan(firstProbes.length);
	expect(new Set(probes).size).toBe(probes.length);
	expect(deliveries.length).toBeGreaterThan(firstDeliveries.length);
	expect(new Set(deliveries).size).toBe(deliveries.length);
	expect(
		probes.length -
			firstProbes.length +
			mark.mock.calls.length -
			firstActed +
			deliveries.length -
			firstDeliveries.length,
	).toBeLessThanOrEqual(100);
	// Untouched durable rows take precedence over retries; after the finite
	// backlog drains, the failed acted projection gets its next attempt too.
	await coordinator.runRecoveryPass();
	expect(
		mark.mock.calls.filter(([notice]) => notice.request_id === "acted"),
	).toHaveLength(2);
}, 20_000);
it("single-flights recovery and stops late probes without transition or timer", async () => {
	let release!: (value: { state: string }) => void;
	const probe = vi.fn(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const h = await fixture({ probeRetiredAttempt: probe });
	const first = h.coordinator.runRecoveryPass();
	const second = h.coordinator.runRecoveryPass();
	await Promise.resolve();
	expect(probe).toHaveBeenCalledTimes(1);
	h.coordinator.stop();
	release({ state: "absent" });
	await Promise.all([first, second]);
	expect(h.store.getCodexReviewAttempt("r", 1)?.recovery_state).toBe("retired");
	expect(h.setTimer).not.toHaveBeenCalled();
	expect(h.round).not.toHaveBeenCalled();
});
it("original budget expiry with unknown ownership terminalizes once instead of renewing or spawning", async () => {
	const h = await fixture({
		now: () => Date.parse("2026-09-26T00:02:00.000Z"),
	});
	await h.coordinator.runRecoveryPass();
	await h.coordinator.runRecoveryPass();
	expect(h.store.getCodexReviewAttempt("r", 1)).toMatchObject({
		recovery_state: "operator_required",
		deadline_at: "2026-09-26T00:01:00.000Z",
	});
	expect(h.probe).toHaveBeenCalledTimes(1);
	expect(h.round).not.toHaveBeenCalled();
});
it("advances a durable delivery cursor before a slow first notice consumes the pass", async () => {
	let elapsed = 0;
	const h = await fixture({ recoveryClock: () => elapsed });
	for (const id of ["a", "z"]) {
		h.store.insertCodexReviewJob({
			requestId: id,
			executionId: "e",
			projectName: "p",
			questionId: id,
			reviewType: "code",
		});
		h.store.claimCodexReviewJobRunning(id);
		h.store.retireCodexReviewJob({ requestId: id, expectedGeneration: 1 });
	}
	const attempted: string[] = [];
	h.deliver.mockImplementation(async (notice: any) => {
		attempted.push(notice.request_id);
		elapsed += 5_000;
		throw new Error("offline");
	});
	await h.coordinator.runRecoveryPass();
	h.advance();
	await h.coordinator.runRecoveryPass();
	expect(new Set(attempted).size).toBe(2);
	expect(h.round).not.toHaveBeenCalled();
});
it("persists termination ownership before signalling so a restart cannot signal twice", async () => {
	const terminate = vi.fn(async () => ({
		state: "unknown",
		reason: "post_signal_unknown",
	}));
	const h = await fixture({
		now: () => Date.parse("2026-09-26T00:02:00Z"),
		probeRetiredAttempt: async () => ({ state: "alive" }),
		terminateRetiredAttempt: terminate,
	});
	expect(
		h.store.claimCodexReviewTermination({
			requestId: "r",
			attemptGeneration: 1,
		}),
	).toBe(true);
	await h.coordinator.runRecoveryPass();
	expect(terminate).not.toHaveBeenCalled();
	expect(h.store.getCodexReviewAttempt("r", 1)?.recovery_state).toBe(
		"operator_required",
	);
});
it("settles cancellation even when the operation synchronously stops its coordinator", async () => {
	const h = await fixture({ recoveryIoTimeoutMs: 10 });
	h.probe.mockImplementation(() => {
		h.coordinator.stop();
		return new Promise(() => {});
	});
	await h.coordinator.runRecoveryPass();
	expect(h.setTimer).not.toHaveBeenCalled();
});
it("retries acted projection receipts after an interrupted CommDB update without waking or spawning", async () => {
	const mark = vi.fn();
	mark.mockImplementationOnce(() => {
		throw new Error("commdb unavailable");
	});
	const h = await fixture({ markRecoveryNoticeActed: mark });
	h.store.transitionCodexReviewRecovery({
		requestId: "r",
		attemptGeneration: 1,
		expectedState: "retired",
		state: "held",
		nextProbeAt: new Date(h.now + 30000).toISOString(),
	});
	await h.coordinator.runRecoveryPass();
	expect(mark).toHaveBeenCalledTimes(1);
	h.advance();
	await h.coordinator.runRecoveryPass();
	expect(mark).toHaveBeenCalledTimes(2);
	await h.coordinator.runRecoveryPass();
	expect(mark).toHaveBeenCalledTimes(2);
	expect(h.deliver).not.toHaveBeenCalled();
	expect(h.round).not.toHaveBeenCalled();
});
