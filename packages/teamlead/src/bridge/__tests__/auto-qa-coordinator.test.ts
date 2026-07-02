import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	AutoQaCoordinator,
	type AutoQaSideEffects,
	type QaIssueRef,
	type QaPolicyDecision,
	type QaResultEvent,
} from "../auto-qa-coordinator.js";
import type { StartRequest } from "../retry-dispatcher.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

// FLY-643: the separate QA·FLY-XX Linear issue the fake createQaIssue returns.
const QA_ISSUE: QaIssueRef = {
	issueId: "qa-issue-uuid",
	issueIdentifier: "FLY-700",
	issueTitle: "QA · FLY-1 — Test issue",
	issueUrl: "https://linear.app/x/issue/FLY-700",
};

function fakeEffects(opts?: {
	createQaIssueImpl?: (args: {
		parent: { issue_id: string };
		prHeadSha: string;
	}) => Promise<QaIssueRef | undefined> | QaIssueRef | undefined;
	retestWakeOk?: boolean;
}) {
	const posts: { text: string; issueId: string }[] = [];
	const wakes: { summary: string }[] = [];
	const alerts: string[] = [];
	const createCalls: { issueId: string; prHeadSha: string }[] = [];
	// FLY-630 ②: parent-thread badge stamps (issueId + stage), in call order.
	const stamps: { issueId: string; stage: string }[] = [];
	// FLY-752: retest wakes + QA closes, in call order.
	const retests: { qaExec: string; newSha: string }[] = [];
	const closes: { qaExec: string }[] = [];
	const counters = { shipReady: 0 };
	const effects: AutoQaSideEffects = {
		postThread: ({ session, text }) => {
			posts.push({ text, issueId: session.issue_id });
		},
		createQaIssue: (args) => {
			createCalls.push({
				issueId: args.parent.issue_id,
				prHeadSha: args.prHeadSha,
			});
			if (opts?.createQaIssueImpl) return opts.createQaIssueImpl(args);
			return QA_ISSUE;
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
		stampIssueStage: ({ session, stage }) => {
			stamps.push({ issueId: session.issue_id, stage });
		},
		retestWakeQa: ({ qaSession, newSha }) => {
			retests.push({ qaExec: qaSession.execution_id, newSha });
			return { ok: opts?.retestWakeOk ?? true };
		},
		closeQaRunner: ({ qaSession }) => {
			closes.push({ qaExec: qaSession.execution_id });
		},
	};
	return {
		effects,
		posts,
		wakes,
		alerts,
		createCalls,
		stamps,
		retests,
		closes,
		counters,
	};
}

async function setup(opts?: {
	policy?: QaPolicyDecision;
	startImpl?: (
		req: StartRequest,
	) => Promise<{ executionId: string; issueId: string }>;
	createQaIssueImpl?: (args: {
		parent: { issue_id: string };
		prHeadSha: string;
	}) => Promise<QaIssueRef | undefined> | QaIssueRef | undefined;
	retestWakeOk?: boolean;
}) {
	const store = await StateStore.create(":memory:");
	const f = fakeEffects({
		createQaIssueImpl: opts?.createQaIssueImpl,
		retestWakeOk: opts?.retestWakeOk,
	});
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
		postTexts: () => f.posts.map((p) => p.text),
		wakes: f.wakes,
		alerts: f.alerts,
		createCalls: f.createCalls,
		stamps: f.stamps,
		retests: f.retests,
		closes: f.closes,
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

	it("FLY-643: creates a separate QA issue + spawns the QA runner ON it (pinned to the reviewed commit) + claims a held record + posts 🧪 to the parent thread", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);

		// A separate QA Linear issue was created for the parent + reviewed head.
		expect(s.createCalls).toEqual([{ issueId: "FLY-1", prHeadSha: SHA }]);

		expect(s.start).toHaveBeenCalledTimes(1);
		const req = s.startCalls[0];
		expect(req.sessionRole).toBe("qa");
		expect(req.agentName).toBe("qa");
		expect(req.startPoint).toBe(SHA);
		// Spawned on the SEPARATE QA issue, NOT the parent (FLY-1).
		expect(req.issueId).toBe("qa-issue-uuid");
		expect(req.issueIdentifier).toBe("FLY-700");
		// Backend pinned to the transported Claude lane (FLY-643).
		expect(req.ignoreRunnerLabelSelection).toBe(true);
		// QA context points back at the PARENT being verified.
		expect(req.qaContext).toEqual({
			parentExecutionId: "main-1",
			prHeadSha: SHA,
			prNumber: 42,
			branch: "fly-1",
			parentIssueIdentifier: "FLY-1",
			parentIssueUrl: undefined,
		});

		const rec = s.store.getAutoQaRecord("main-1", SHA);
		expect(rec?.status).toBe("running");
		expect(rec?.qa_execution_id).toBe("qa-1");
		// The record carries the separate QA issue (durable for reconcile re-use).
		expect(rec?.qa_issue_id).toBe("qa-issue-uuid");
		expect(rec?.qa_issue_identifier).toBe("FLY-700");

		// 🧪 started goes to the PARENT thread (FYI for the founder), referencing
		// the separate QA issue.
		const started = s.posts.find((p) => p.text.includes("🧪"));
		expect(started).toBeDefined();
		expect(started?.issueId).toBe("FLY-1");
		expect(started?.text).toContain("FLY-700");

		// FLY-630 ②: the PARENT thread badge reflects the issue's real pipeline
		// stage — QA is running, so it is stamped to "test" (🧪QA), not left frozen
		// on the implementer's approve stage (⏳待批).
		expect(s.stamps).toContainEqual({ issueId: "FLY-1", stage: "test" });
	});

	it("FLY-643: createQaIssue failure → record stuck + Lead alert, no QA spawn (fail-closed)", async () => {
		const s2 = await setup({ createQaIssueImpl: () => undefined });
		const main = awaitingMain(s2.store);
		await s2.coord.onMainAwaitingReview(main);
		expect(s2.start).not.toHaveBeenCalled();
		expect(s2.store.getAutoQaRecord("main-1", SHA)?.status).toBe("stuck");
		expect(
			s2.alerts.some((a) => a.includes("could not create the QA issue")),
		).toBe(true);
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

	// ── FLY-752: fix-loop reuse ──

	it("a NEW head after a FAIL RE-TESTS the SAME QA runner (retest_wake) — never a fresh QA2", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		// Give the record a live QA runner + simulate its FAIL → awaiting_retest.
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: "qa-issue-uuid",
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});
		s.store.setAutoQaStatus("main-1", SHA, "awaiting_retest", {});

		// Implementer pushes a new head + re-requests review.
		const main2 = awaitingMain(s.store, { prHeadSha: SHA2 });
		await s.coord.onMainAwaitingReview(main2, { freshTransition: false });

		// NO fresh spawn — the SAME QA is re-woken to re-test the new head.
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.retests).toEqual([{ qaExec: "qa-1", newSha: SHA2 }]);
		// One row, retargeted to the new head, running, marker cleared (wake ok).
		expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		const rec = s.store.getAutoQaRecord("main-1", SHA2);
		expect(rec?.status).toBe("running");
		expect(rec?.qa_execution_id).toBe("qa-1");
		expect(rec?.retest_wake_pending_at).toBeFalsy();
	});

	it("a NEW head after the QA already ENDED (prior PASS closed it) → re-spawn into the SAME QA issue", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		// QA passed + was closed → its session is terminal (completed).
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: "qa-issue-uuid",
			project_name: "proj",
			status: "completed",
			session_role: "qa",
		});
		s.store.setAutoQaStatus("main-1", SHA, "passed", { notifiedAt: true });

		const main2 = awaitingMain(s.store, { prHeadSha: SHA2 });
		await s.coord.onMainAwaitingReview(main2, { freshTransition: false });

		// No retest wake (QA dead) → re-spawn, reusing the SAME QA issue (no new create).
		expect(s.retests.length).toBe(0);
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(s.createCalls.length).toBe(1); // QA issue reused, not re-created
		const rec = s.store.getAutoQaRecord("main-1", SHA2);
		expect(rec?.status).toBe("running");
	});

	it("retest wake that does NOT land → founder HELD, durable marker kept, Lead alerted (never released)", async () => {
		const s2 = await setup({ retestWakeOk: false });
		const main = awaitingMain(s2.store);
		await s2.coord.onMainAwaitingReview(main);
		s2.store.upsertSession({
			execution_id: "qa-1",
			issue_id: "qa-issue-uuid",
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});
		s2.store.setAutoQaStatus("main-1", SHA, "awaiting_retest", {});
		const main2 = awaitingMain(s2.store, { prHeadSha: SHA2 });
		await s2.coord.onMainAwaitingReview(main2, { freshTransition: false });

		const rec = s2.store.getAutoQaRecord("main-1", SHA2);
		// held (running, != passed) + durable marker retained for reconcile.
		expect(rec?.status).toBe("running");
		expect(rec?.retest_wake_pending_at).toBeTruthy();
		expect(s2.alerts.some((a) => a.includes("retest wake failed"))).toBe(true);
	});

	it("Q3(b): no owner record + NOT a fresh review-pass (parked-for-founder) → SKIP, no spawn", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main, { freshTransition: false });
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
	});

	it("legacy `failed` owner, SAME head → held no-op (no spawn, no leak)", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		s.store.setAutoQaStatus("main-1", SHA, "failed", {}); // legacy terminal FAIL
		await s.coord.onMainAwaitingReview(main, { freshTransition: false });
		// No second spawn; the failed record still holds the founder.
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("failed");
	});

	it("legacy `failed` owner, NEW head → retarget + re-drive (reuse QA issue), holds founder", async () => {
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		// Legacy: QA runner already ended, record is terminal `failed`.
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: "qa-issue-uuid",
			project_name: "proj",
			status: "completed",
			session_role: "qa",
		});
		s.store.setAutoQaStatus("main-1", SHA, "failed", {});
		const main2 = awaitingMain(s.store, { prHeadSha: SHA2 });
		await s.coord.onMainAwaitingReview(main2, { freshTransition: false });
		const rec = s.store.getAutoQaRecord("main-1", SHA2);
		expect(rec?.status).toBe("running"); // held on the new head → no founder leak
		expect(s.start).toHaveBeenCalledTimes(2); // re-spawn into same QA issue
	});
});

describe("AutoQaCoordinator.onQaResult", () => {
	let s: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		s = await setup();
	});

	// FLY-643: the QA runner now lives on its OWN separate QA issue, not FLY-1.
	function qaSession(store: StateStore, issueId = "qa-issue-uuid") {
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: issueId,
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

	it("PASS → record passed + founder ship-ready + QA runner CLOSED (cleanup) + notified_at stamped", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(verdict({ status: "pass" }));
		const rec = s.store.getAutoQaRecord("main-1", SHA);
		expect(rec?.status).toBe("passed");
		expect(rec?.notified_at).toBeTruthy();
		expect(s.counters.shipReady).toBe(1);
		expect(s.wakes.length).toBe(0);
		// FLY-752: QA passed → the QA runner is auto-closed (cmux/thread/pin cleanup).
		expect(s.closes).toEqual([{ qaExec: "qa-1" }]);
		// FLY-630 ②: QA green → parent thread re-stamped to "approve" (⏳待批) — now
		// genuinely awaiting the founder.
		expect(s.stamps).toContainEqual({ issueId: "FLY-1", stage: "approve" });
	});

	it("FAIL → record awaiting_retest (QA parked, NOT closed) + implementer woken; founder NOT notified; 🔴 to QA thread not parent", async () => {
		await primeRunningQa();
		await s.coord.onQaResult(
			verdict({ status: "fail", summary: "button broken" }),
		);
		// FLY-752: FAIL → non-terminal awaiting_retest; QA is reused, NOT closed.
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe(
			"awaiting_retest",
		);
		expect(s.closes.length).toBe(0);
		expect(s.counters.shipReady).toBe(0);
		expect(s.wakes[0]?.summary).toContain("button broken");
		// 🔴 goes to the QA issue's OWN thread, NOT the parent thread (the founder
		// watches the parent; a non-green QA must not surface there).
		const failPost = s.posts.find((p) => p.text.includes("🔴"));
		expect(failPost).toBeDefined();
		expect(failPost?.issueId).toBe("qa-issue-uuid");
		expect(
			s.posts.some((p) => p.text.includes("🔴") && p.issueId === "FLY-1"),
		).toBe(false);
		// FLY-630 ②: QA failed → parent thread re-stamped to "implement" (🔨实现中) —
		// the implementer is being woken to fix, not a stale 🧪QA.
		expect(s.stamps).toContainEqual({ issueId: "FLY-1", stage: "implement" });
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

	it("claimed-but-unspawned (crash before QA issue created) → reconcile creates the QA issue + spawns", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		await s.coord.reconcileOnStartup();
		// No qa_issue_id yet → reconcile creates one + spawns on it.
		expect(s.createCalls.length).toBe(1);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.startCalls[0]?.issueId).toBe("qa-issue-uuid");
		expect(s.store.getAutoQaRecord("main-1", SHA)?.qa_execution_id).toBe(
			"qa-1",
		);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.qa_issue_id).toBe(
			"qa-issue-uuid",
		);
	});

	it("FLY-643: claimed + QA issue already created (crash AFTER create, before spawn) → reconcile re-uses it, does NOT create a duplicate", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		// Simulate the crash window: the QA issue was created + persisted, but the
		// runner spawn never completed (qa_execution_id still null).
		s.store.setAutoQaIssue("main-1", SHA, {
			issueId: "existing-qa-issue",
			issueIdentifier: "FLY-701",
		});
		await s.coord.reconcileOnStartup();
		// MUST NOT create a second QA issue — re-uses the persisted one.
		expect(s.createCalls.length).toBe(0);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.startCalls[0]?.issueId).toBe("existing-qa-issue");
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
