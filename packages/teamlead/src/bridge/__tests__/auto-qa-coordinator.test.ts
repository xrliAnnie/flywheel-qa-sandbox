import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	AutoQaCoordinator,
	type AutoQaSideEffects,
	type QaPolicyDecision,
	type QaResultEvent,
} from "../auto-qa-coordinator.js";
import type { StartRequest } from "../retry-dispatcher.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function fakeEffects() {
	const posts: string[] = [];
	const wakes: { summary: string }[] = [];
	const alerts: string[] = [];
	const counters = { shipReady: 0 };
	const effects: AutoQaSideEffects = {
		postThread: ({ text }) => {
			posts.push(text);
		},
		notifyShipReady: () => {
			counters.shipReady += 1;
		},
		feedbackWakeMain: ({ summary }) => {
			wakes.push({ summary });
		},
		alertLeadPipelineError: ({ reason }) => {
			alerts.push(reason);
		},
	};
	return { effects, posts, wakes, alerts, counters };
}

async function setup(opts?: {
	policy?: QaPolicyDecision;
	startImpl?: (
		req: StartRequest,
	) => Promise<{ executionId: string; issueId: string }>;
}) {
	const store = await StateStore.create(":memory:");
	const f = fakeEffects();
	const startCalls: StartRequest[] = [];
	const start = vi.fn(async (req: StartRequest) => {
		startCalls.push(req);
		if (opts?.startImpl) return opts.startImpl(req);
		return { executionId: `qa-${startCalls.length}`, issueId: req.issueId };
	});
	const coord = new AutoQaCoordinator({
		store,
		startDispatcher: { start },
		resolveQaPolicy: () => opts?.policy ?? { enabled: true },
		effects: f.effects,
	});
	return {
		store,
		coord,
		start,
		startCalls,
		posts: f.posts,
		wakes: f.wakes,
		alerts: f.alerts,
		counters: f.counters,
	};
}

/**
 * Create an awaiting_review session. pr_head_sha is NOT persisted by
 * upsertSession (FLY-191: it is written by setReviewBinding) — set it the same
 * way production does.
 */
function awaitingMain(
	store: StateStore,
	o: { id?: string; role?: string; prHeadSha?: string | null } = {},
) {
	const id = o.id ?? "main-1";
	store.upsertSession({
		execution_id: id,
		issue_id: "FLY-1",
		project_name: "proj",
		status: "awaiting_review",
		session_role: o.role ?? "main",
		issue_title: "Test issue",
		issue_identifier: "FLY-1",
		issue_labels: JSON.stringify(["engineer"]),
		branch: "fly-1",
		pr_number: 42,
	});
	const prHeadSha = o.prHeadSha === undefined ? SHA : o.prHeadSha;
	store.setReviewBinding(id, { questionId: `q-${id}`, prHeadSha });
	const s = store.getSession(id);
	if (!s) throw new Error("session not found");
	return s;
}

describe("AutoQaCoordinator.onMainAwaitingReview", () => {
	let s: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		s = await setup();
	});

	it("spawns an independent QA runner pinned to the reviewed commit + claims a held record + posts 🧪", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);

		expect(s.start).toHaveBeenCalledTimes(1);
		const req = s.startCalls[0];
		expect(req.sessionRole).toBe("qa");
		expect(req.agentName).toBe("qa");
		expect(req.startPoint).toBe(SHA);
		expect(req.issueId).toBe("FLY-1");
		expect(req.qaContext).toEqual({
			parentExecutionId: "main-1",
			prHeadSha: SHA,
			prNumber: 42,
			branch: "fly-1",
		});

		const rec = s.store.getAutoQaRecord("main-1", SHA);
		expect(rec?.status).toBe("running");
		expect(rec?.qa_execution_id).toBe("qa-1");
		expect(s.posts.some((p) => p.includes("🧪"))).toBe(true);
	});

	it("dedups a repeated awaiting_review for the SAME head — exactly one QA spawn", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		await s.coord.onMainAwaitingReview(main);
		expect(s.start).toHaveBeenCalledTimes(1);
	});

	it("FAIL-CLOSED: missing pr_head_sha → no spawn, Lead alert, no held record (never QA origin/main)", async () => {
		const main = awaitingMain(s.store, { prHeadSha: null });
		await s.coord.onMainAwaitingReview(main);
		expect(s.start).not.toHaveBeenCalled();
		expect(s.alerts.length).toBe(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
	});

	it("skips when policy is disabled (byte-compat opt-in)", async () => {
		const s2 = await setup({
			policy: { enabled: false, reason: "qa.auto false" },
		});
		const main = awaitingMain(s2.store);
		await s2.coord.onMainAwaitingReview(main);
		expect(s2.start).not.toHaveBeenCalled();
		expect(s2.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
	});

	it("ignores a non-main session role", async () => {
		const qa = awaitingMain(s.store, { id: "qa-x", role: "qa" });
		await s.coord.onMainAwaitingReview(qa);
		expect(s.start).not.toHaveBeenCalled();
	});

	it("spawn failure → record stuck + Lead alert (never a held parent with no QA)", async () => {
		const s2 = await setup({
			startImpl: async () => {
				throw new Error("admission deferred");
			},
		});
		const main = awaitingMain(s2.store);
		await s2.coord.onMainAwaitingReview(main);
		expect(s2.store.getAutoQaRecord("main-1", SHA)?.status).toBe("stuck");
		expect(s2.alerts.some((a) => a.includes("spawn failed"))).toBe(true);
	});

	it("a new reviewed head supersedes the old record + spawns fresh QA", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		const main2 = awaitingMain(s.store, { prHeadSha: SHA2 });
		await s.coord.onMainAwaitingReview(main2);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("superseded");
		expect(s.store.getAutoQaRecord("main-1", SHA2)?.status).toBe("running");
		expect(s.start).toHaveBeenCalledTimes(2);
	});
});

describe("AutoQaCoordinator.onQaResult", () => {
	let s: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		s = await setup();
	});

	function qaSession(store: StateStore) {
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});
	}

	function verdict(
		over: Partial<QaResultEvent["payload"]> = {},
	): QaResultEvent {
		return {
			event_id: "evt-1",
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "proj",
			event_type: "qa_result",
			payload: {
				status: "pass",
				targetExecutionId: "main-1",
				qaExecutionId: "qa-1",
				prHeadSha: SHA,
				summary: "all good",
				...over,
			},
		};
	}

	async function primeRunningQa() {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		qaSession(s.store);
	}

	it("PASS → record passed + founder ship-ready notification released + notified_at stamped", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(verdict({ status: "pass" }));
		const rec = s.store.getAutoQaRecord("main-1", SHA);
		expect(rec?.status).toBe("passed");
		expect(rec?.notified_at).toBeTruthy();
		expect(s.counters.shipReady).toBe(1);
		expect(s.wakes.length).toBe(0);
	});

	it("FAIL → record failed + implementer woken with report; founder NOT notified", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(
			verdict({ status: "fail", summary: "button broken" }),
		);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("failed");
		expect(s.counters.shipReady).toBe(0);
		expect(s.wakes[0]?.summary).toContain("button broken");
		expect(s.posts.some((p) => p.includes("🔴"))).toBe(true);
	});

	it("drops a STALE verdict (verdict head != parent current head)", async () => {
		await primeRunningQa();
		awaitingMain(s.store, { prHeadSha: SHA2 });
		await s.coord.onQaResult(verdict({ prHeadSha: SHA }));
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(s.counters.shipReady).toBe(0);
	});

	it("rejects a verdict from a non-QA / foreign session", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(verdict({ qaExecutionId: "main-1" }));
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(s.counters.shipReady).toBe(0);
		expect(s.alerts.length).toBe(1);
	});

	it("rejects a verdict from a DIFFERENT QA session on the same issue (bound to the record's qa_execution_id)", async () => {
		await primeRunningQa();
		// A rogue/stale QA session on the SAME issue — but NOT the one this record
		// spawned (qa-1). It must not be able to release the parent's gate.
		s.store.upsertSession({
			execution_id: "qa-rogue",
			issue_id: "FLY-1",
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});
		await s.coord.onQaResult(verdict({ qaExecutionId: "qa-rogue" }));
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(s.counters.shipReady).toBe(0);
		expect(s.alerts.length).toBe(1);
	});

	it("rejects a verdict missing prHeadSha (fail-closed — no silent release)", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(verdict({ prHeadSha: undefined }));
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(s.counters.shipReady).toBe(0);
	});

	it("is idempotent — a duplicate verdict does not re-release / re-wake", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(verdict({ status: "pass" }));
		await s.coord.onQaResult(verdict({ status: "pass" }));
		expect(s.counters.shipReady).toBe(1);
	});

	it("never auto-releases a STUCK record — a late/replayed PASS is ignored (lost-verdict stays Lead-only)", async () => {
		await primeRunningQa();
		// reconcile already flagged this as stuck (QA died without a verdict)
		s.store.setAutoQaStatus("main-1", SHA, "stuck", {});
		await s.coord.onQaResult(verdict({ status: "pass" }));
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("stuck");
		expect(s.counters.shipReady).toBe(0);
	});

	it("ignores a verdict once the parent is no longer awaiting_review (moot)", async () => {
		await primeRunningQa();
		// parent moved on after QA started (e.g. approved / merged / completed)
		s.store.upsertSession({
			execution_id: "main-1",
			issue_id: "FLY-1",
			project_name: "proj",
			status: "completed",
			session_role: "main",
		});
		await s.coord.onQaResult(verdict({ status: "pass" }));
		expect(s.counters.shipReady).toBe(0);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
	});
});

describe("AutoQaCoordinator.reconcileOnStartup", () => {
	it("lost-event: QA session ended but no verdict → record stuck + Lead alert (never auto-release)", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "proj",
			status: "completed",
			session_role: "qa",
		});
		await s.coord.reconcileOnStartup();
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("stuck");
		expect(s.alerts.some((a) => a.includes("stuck"))).toBe(true);
		expect(s.counters.shipReady).toBe(0);
	});

	it("claimed-but-unspawned (crash mid-spawn) → reconcile spawns", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		await s.coord.reconcileOnStartup();
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.qa_execution_id).toBe(
			"qa-1",
		);
	});

	it("passed-but-unnotified → reconcile re-notifies the founder once", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaStatus("main-1", SHA, "passed", {});
		await s.coord.reconcileOnStartup();
		expect(s.counters.shipReady).toBe(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.notified_at).toBeTruthy();
	});
});
