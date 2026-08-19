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
	/** FLY-846: override to defer/hang the close (gate ③ race test). */
	closeQaRunnerImpl?: () => Promise<void> | void;
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
	// FLY-827: codex-hold side effects, in call order.
	const codexQueues: { execId: string }[] = [];
	const codexAlerts: { execId: string; sha: string }[] = [];
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
		alertShipAttemptFailed: ({ reason }) => {
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
			if (opts?.closeQaRunnerImpl) return opts.closeQaRunnerImpl();
		},
		queueCodexInstruction: ({ session }) => {
			codexQueues.push({ execId: session.execution_id });
		},
		alertCodexGateBlocked: ({ session, sha }) => {
			codexAlerts.push({ execId: session.execution_id, sha });
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
		codexQueues,
		codexAlerts,
		counters,
	};
}

async function setup(opts?: {
	policy?: QaPolicyDecision;
	startImpl?: (
		req: StartRequest,
	) => Promise<{ executionId: string; issueId: string }>;
	hasInflightImpl?: (issueId: string, role: string) => boolean;
	createQaIssueImpl?: (args: {
		parent: { issue_id: string };
		prHeadSha: string;
	}) => Promise<QaIssueRef | undefined> | QaIssueRef | undefined;
	retestWakeOk?: boolean;
	env?: Record<string, string | undefined>;
	closeQaRunnerImpl?: () => Promise<void> | void;
	/** Deterministic clock seam. */
	now?: () => number;
	ensureShipRelevantDiff?: (session: { execution_id: string }) => Promise<void>;
}) {
	const store = await StateStore.create(":memory:");
	const f = fakeEffects({
		createQaIssueImpl: opts?.createQaIssueImpl,
		retestWakeOk: opts?.retestWakeOk,
		closeQaRunnerImpl: opts?.closeQaRunnerImpl,
	});
	const startCalls: StartRequest[] = [];
	const start = vi.fn(async (req: StartRequest) => {
		startCalls.push(req);
		if (opts?.startImpl) return opts.startImpl(req);
		return {
			executionId: req.successorExecutionId ?? `qa-${startCalls.length}`,
			issueId: req.issueId,
		};
	});
	const hasInflight = vi.fn(
		(issueId: string, role: string) =>
			opts?.hasInflightImpl?.(issueId, role) ?? false,
	);
	const coord = new AutoQaCoordinator({
		store,
		startDispatcher: { start, hasInflightForRole: hasInflight },
		resolveQaPolicy: () => opts?.policy ?? { enabled: true },
		effects: f.effects,
		// FLY-827: these tests validate the QA pipeline, which is orthogonal to the
		// codex hard gate. Run with the gate OFF so onMainAwaitingReview's codex
		// check short-circuits (satisfied) and the QA behavior is unchanged — this
		// IS the byte-compat guarantee. Codex-gate behavior has its own test file.
		env: opts?.env ?? { FLYWHEEL_CODEX_HARD_GATE: "0" },
		now: opts?.now,
		ensureShipRelevantDiff: opts?.ensureShipRelevantDiff,
	});
	return {
		store,
		coord,
		start,
		hasInflight,
		startCalls,
		posts: f.posts,
		postTexts: () => f.posts.map((p) => p.text),
		wakes: f.wakes,
		alerts: f.alerts,
		createCalls: f.createCalls,
		stamps: f.stamps,
		retests: f.retests,
		closes: f.closes,
		codexQueues: f.codexQueues,
		codexAlerts: f.codexAlerts,
		counters: f.counters,
	};
}

/**
 * Create an awaiting_review session. pr_head_sha is written via
 * setReviewBinding (FLY-191) — same as production — EXCEPT for the FLY-846
 * `binding: "null"` shape (a session whose completion never went through the
 * HTTP binding path, e.g. DirectEventSink-only: pr_head_sha set, qid NULL),
 * which upsertSession persists directly.
 *
 * FLY-846 evidence knobs (defaults preserve the pre-FLY-846 genuine shape:
 * real qid + pr_number 42):
 *   - binding: "qid" (real questionId) | "unbound" (sentinel) | "null" (no qid)
 *   - prNumber: null omits pr_number entirely
 */
function awaitingMain(
	store: StateStore,
	o: {
		id?: string;
		role?: string;
		prHeadSha?: string | null;
		status?: string;
		issueId?: string;
		issueIdentifier?: string;
		issueTitle?: string;
		binding?: "qid" | "unbound" | "null";
		prNumber?: number | null;
	} = {},
) {
	const id = o.id ?? "main-1";
	const prHeadSha = o.prHeadSha === undefined ? SHA : o.prHeadSha;
	const binding = o.binding ?? "qid";
	store.upsertSession({
		execution_id: id,
		issue_id: o.issueId ?? "FLY-1",
		project_name: "proj",
		status: o.status ?? "awaiting_review",
		session_role: o.role ?? "main",
		issue_title: o.issueTitle ?? "Test issue",
		issue_identifier: o.issueIdentifier ?? "FLY-1",
		issue_labels: JSON.stringify(["engineer"]),
		branch: "fly-1",
		...(o.prNumber === null ? {} : { pr_number: o.prNumber ?? 42 }),
	});
	if (binding === "null") {
		// pr_head_sha set, review_question_id left NULL — the DirectEventSink-only
		// completion shape (patchSessionMetadata owns pr_head_sha on that path).
		if (prHeadSha) {
			store.patchSessionMetadata(id, { pr_head_sha: prHeadSha });
		}
	} else {
		store.setReviewBinding(id, {
			questionId: binding === "qid" ? `q-${id}` : null,
			prHeadSha,
		});
	}
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

	it("FLY-1251: materializes the exact-head ship-diff snapshot before a policy-off run can reach the founder", async () => {
		const ensureShipRelevantDiff = vi.fn(async () => {});
		const s2 = await setup({
			policy: { enabled: false, reason: "no-qa" },
			ensureShipRelevantDiff,
		});
		const main = awaitingMain(s2.store);

		await s2.coord.onMainAwaitingReview(main);

		expect(ensureShipRelevantDiff).toHaveBeenCalledOnce();
		expect(ensureShipRelevantDiff).toHaveBeenCalledWith(
			expect.objectContaining({
				execution_id: "main-1",
				pr_head_sha: SHA,
				pr_number: 42,
			}),
		);
		expect(s2.start).not.toHaveBeenCalled();
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

	it("exempts an engine-owned main carrier instead of creating a separate QA issue", async () => {
		const ensureShipRelevantDiff = vi.fn(async () => {});
		const s2 = await setup({ ensureShipRelevantDiff });
		vi.spyOn(s2.store, "isWorkflowEngineOwnedExecution").mockReturnValue(true);
		const main = awaitingMain(s2.store);

		await s2.coord.onMainAwaitingReview(main);

		expect(ensureShipRelevantDiff).toHaveBeenCalledOnce();
		expect(s2.createCalls).toEqual([]);
		expect(s2.start).not.toHaveBeenCalled();
		expect(s2.store.getSession("main-1")?.qa_required).toBe(0);
		expect(s2.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
	});

	it("alerts when an immutable required snapshot already wedged an engine-owned carrier", async () => {
		const main = awaitingMain(s.store);
		vi.spyOn(s.store, "isWorkflowEngineOwnedExecution").mockReturnValue(true);
		s.store.setQaRequiredSnapshot({
			executionId: "main-1",
			required: 1,
			reason: "backfill:code_pr_no_record",
		});

		await s.coord.onMainAwaitingReview(main);

		expect(s.createCalls).toEqual([]);
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getSession("main-1")?.qa_required).toBe(1);
		expect(s.alerts).toEqual([
			expect.stringMatching(/engine-owned.*qa_required=1.*no auto-QA record/i),
		]);
	});

	it("ignores a non-main session role", async () => {
		const qa = awaitingMain(s.store, { id: "qa-x", role: "qa" });
		await s.coord.onMainAwaitingReview(qa);
		expect(s.start).not.toHaveBeenCalled();
	});

	it("initial dispatcher spawn failure queues the one clean retry instead of stranding", async () => {
		let attempts = 0;
		const s2 = await setup({
			startImpl: async (req) => {
				attempts += 1;
				if (attempts === 1) throw new Error("admission deferred");
				return {
					executionId: req.successorExecutionId ?? "missing-successor",
					issueId: req.issueId,
				};
			},
		});
		const main = awaitingMain(s2.store);
		await s2.coord.onMainAwaitingReview(main);
		expect(s2.store.getAutoQaRecord("main-1", SHA)).toMatchObject({
			status: "retry_pending",
			auto_retry_count: 1,
		});
		expect(s2.alerts.some((a) => a.includes("automatic retry queued"))).toBe(
			true,
		);

		await s2.coord.sweepOrphanedQaRecords();
		expect(s2.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(attempts).toBe(2);
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

	it("a NEW head after the QA already ENDED queues bounded clean recovery in the SAME QA issue", async () => {
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

		// No retest wake (QA dead) → event-like detection claims recovery; it does
		// not synchronously spawn in the handoff path.
		expect(s.retests.length).toBe(0);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.createCalls.length).toBe(1); // QA issue reused, not re-created
		let rec = s.store.getAutoQaRecord("main-1", SHA2);
		expect(rec?.status).toBe("retry_pending");

		await s.coord.sweepOrphanedQaRecords();
		expect(s.start).toHaveBeenCalledTimes(2);
		rec = s.store.getAutoQaRecord("main-1", SHA2);
		expect(rec?.status).toBe("running");
		expect(rec?.auto_retry_count).toBe(1);
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
		expect(s.store.getAutoQaRecord("main-1", SHA2)?.status).toBe(
			"retry_pending",
		); // held on the new head → no founder leak
		await s.coord.sweepOrphanedQaRecords();
		expect(s.store.getAutoQaRecord("main-1", SHA2)?.status).toBe("running");
		expect(s.start).toHaveBeenCalledTimes(2); // clean recovery into same QA issue
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

describe("AutoQaCoordinator.manualSpawnQa (FLY-1251)", () => {
	it("bypasses auto policy but uses the standard server-owned QA spawn chain", async () => {
		const s = await setup({ policy: { enabled: false, reason: "no-qa" } });
		awaitingMain(s.store);

		await expect(s.coord.manualSpawnQa("main-1", SHA)).resolves.toMatchObject({
			status: "spawned",
		});
		expect(s.start).toHaveBeenCalledOnce();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toMatchObject({
			status: "running",
			enrollment_source: "manual",
			qa_execution_id: "qa-1",
		});
		const audit = s.store
			.getEventsByExecution("main-1")
			.find((event) => event.event_type === "manual_qa_enrolled");
		expect(audit).toMatchObject({
			event_id: `manual-qa-enrolled-main-1-${SHA}-qa-1`,
			source: "bridge.auto-qa-coordinator",
		});
	});

	it("rejects a stale requested head without creating evidence", async () => {
		const s = await setup();
		awaitingMain(s.store);
		await expect(s.coord.manualSpawnQa("main-1", SHA2)).resolves.toEqual({
			status: "rejected",
			reason: "head_mismatch",
		});
		expect(s.start).not.toHaveBeenCalled();
	});

	it.each(["running", "awaiting_retest", "passed"] as const)(
		"returns an idempotent conflict for an existing %s record",
		async (status) => {
			const s = await setup();
			awaitingMain(s.store);
			s.store.claimAutoQaRecord({
				parentExecutionId: "main-1",
				targetPrHeadSha: SHA,
				issueId: "FLY-1",
				projectName: "proj",
			});
			s.store.setAutoQaStatus("main-1", SHA, status, {});

			await expect(s.coord.manualSpawnQa("main-1", SHA)).resolves.toEqual({
				status: "existing",
				recordStatus: status,
			});
			expect(s.start).not.toHaveBeenCalled();
		},
	);

	it("revives a stuck row only when its prior QA runner is confirmed dead", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaQaExecutionId("main-1", SHA, "qa-dead");
		s.store.setAutoQaStatus("main-1", SHA, "stuck", {});

		await expect(s.coord.manualSpawnQa("main-1", SHA)).resolves.toMatchObject({
			status: "spawned",
		});
		expect(s.start).toHaveBeenCalledOnce();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toMatchObject({
			status: "running",
			enrollment_source: "manual",
			qa_execution_id: "qa-1",
		});
	});

	it("does not revive a stuck row while its QA runner is still live", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaQaExecutionId("main-1", SHA, "qa-live");
		s.store.setAutoQaStatus("main-1", SHA, "stuck", {});
		s.store.upsertSession({
			execution_id: "qa-live",
			issue_id: "qa-issue",
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});

		await expect(s.coord.manualSpawnQa("main-1", SHA)).resolves.toEqual({
			status: "existing",
			recordStatus: "stuck",
		});
		expect(s.start).not.toHaveBeenCalled();
	});

	it("auto-vs-manual admission races converge to one QA runner", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);

		await Promise.all([
			s.coord.onMainAwaitingReview(main),
			s.coord.manualSpawnQa("main-1", SHA),
		]);

		expect(s.start).toHaveBeenCalledOnce();
		expect(s.store.listAutoQaRecordsByParent("main-1")).toHaveLength(1);
	});
});

describe("AutoQaCoordinator.reconcileOnStartup", () => {
	it("lost-event: dead QA is detected and clean-retried once with a durable successor id", async () => {
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
		const rec = s.store.getAutoQaRecord("main-1", SHA);
		expect(rec?.status).toBe("running");
		expect(rec?.auto_retry_count).toBe(1);
		expect(rec?.qa_execution_id).toBe(rec?.retry_attempt_id);
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(s.startCalls[1]).toMatchObject({
			successorExecutionId: rec?.retry_attempt_id,
			shareParentBranch: false,
		});
		expect(s.alerts.some((a) => a.includes("automatic retry queued"))).toBe(
			true,
		);
		expect(s.counters.shipReady).toBe(0);
	});

	it("inflight hard gate defers respawn until the old dispatcher releases the QA role", async () => {
		let inflight = true;
		const s = await setup({ hasInflightImpl: () => inflight });
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: QA_ISSUE.issueId,
			project_name: "proj",
			status: "failed",
			session_role: "qa",
		});

		await s.coord.sweepOrphanedQaRecords();
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe(
			"retry_pending",
		);
		expect(s.start).toHaveBeenCalledTimes(1);

		inflight = false;
		await s.coord.sweepOrphanedQaRecords();
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
	});

	it("retry_starting adopts an already-live pre-bound successor without launching a duplicate", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaIssue("main-1", SHA, QA_ISSUE);
		s.store.setAutoQaQaExecutionId("main-1", SHA, "qa-dead");
		s.store.markDeadAutoQaExecution("main-1", SHA, "qa-dead");
		s.store.claimAutoQaRetryLaunch("main-1", SHA, "qa-successor");
		s.store.upsertSession({
			execution_id: "qa-successor",
			issue_id: QA_ISSUE.issueId,
			project_name: "proj",
			status: "running",
			session_role: "qa",
		});

		await s.coord.sweepOrphanedQaRecords();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toMatchObject({
			status: "running",
			qa_execution_id: "qa-successor",
			retry_attempt_id: "qa-successor",
		});
	});

	it("retry_starting re-drives the same durable id and concurrent sweeps are single-flight", async () => {
		let release!: () => void;
		const launched = new Promise<void>((resolve) => {
			release = resolve;
		});
		const s = await setup({
			startImpl: async (req) => {
				await launched;
				return {
					executionId: req.successorExecutionId ?? "unexpected",
					issueId: req.issueId,
				};
			},
		});
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaIssue("main-1", SHA, QA_ISSUE);
		s.store.setAutoQaQaExecutionId("main-1", SHA, "qa-dead");
		s.store.markDeadAutoQaExecution("main-1", SHA, "qa-dead");
		s.store.claimAutoQaRetryLaunch("main-1", SHA, "qa-durable-attempt");

		const first = s.coord.sweepOrphanedQaRecords();
		const second = s.coord.sweepOrphanedQaRecords();
		await vi.waitFor(() => expect(s.start).toHaveBeenCalledTimes(1));
		expect(s.startCalls[0]?.successorExecutionId).toBe("qa-durable-attempt");
		release();
		await Promise.all([first, second]);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.qa_execution_id).toBe(
			"qa-durable-attempt",
		);
	});

	it("a replacement QA death exhausts recovery and never starts QA3", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		s.store.upsertSession({
			execution_id: "qa-1",
			issue_id: QA_ISSUE.issueId,
			project_name: "proj",
			status: "failed",
			session_role: "qa",
		});
		await s.coord.sweepOrphanedQaRecords();
		const replacement = s.store.getAutoQaRecord("main-1", SHA)?.qa_execution_id;
		expect(replacement).toBeTruthy();
		s.store.upsertSession({
			execution_id: replacement!,
			issue_id: QA_ISSUE.issueId,
			project_name: "proj",
			status: "terminated",
			session_role: "qa",
		});

		await s.coord.sweepOrphanedQaRecords();
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("stuck");
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(s.alerts.some((a) => a.includes("automatic retry exhausted"))).toBe(
			true,
		);
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

describe("AutoQaCoordinator.onQaSessionFailed", () => {
	it("owns an auto-QA failure, claims retry + alerts, but never spawns in the event hook", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);

		expect(await s.coord.onQaSessionFailed("qa-1")).toEqual({
			owned: true,
			transition: "retry_pending",
		});
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe(
			"retry_pending",
		);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.alerts.some((a) => a.includes("automatic retry queued"))).toBe(
			true,
		);
	});

	it("consumes duplicate and historical auto-QA failures without falling through", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);
		await s.coord.onQaSessionFailed("qa-1");
		const alertsAfterClaim = s.alerts.length;

		expect(await s.coord.onQaSessionFailed("qa-1")).toEqual({
			owned: true,
			transition: "noop",
		});
		expect(s.alerts).toHaveLength(alertsAfterClaim);

		s.store.setAutoQaStatus("main-1", SHA, "passed", {});
		expect(await s.coord.onQaSessionFailed("qa-1")).toEqual({
			owned: true,
			transition: "noop",
		});
	});

	it("returns owned=false for DAG workflow/non-auto QA", async () => {
		const s = await setup();
		expect(await s.coord.onQaSessionFailed("phase-qa")).toEqual({
			owned: false,
			transition: "noop",
		});
	});
});

describe("AutoQaCoordinator.reconcileOnStartup — FLY-869 A-1b qa_required backfill", () => {
	it("awaiting_review + matching auto_qa_record (no forward-path snapshot) → required=1", async () => {
		const s = await setup();
		awaitingMain(s.store); // qa_required starts NULL
		// Low-level record claim (does NOT set the forward-path qa_required snapshot).
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(s.store.getSession("main-1")?.qa_required).toBeUndefined();
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(1);
	});

	it("awaiting_review + auto-QA policy OFF (no record) → required=0 (exempt)", async () => {
		const s = await setup({
			policy: { enabled: false, reason: "no_qa_label" },
		});
		awaitingMain(s.store);
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
	});

	it("awaiting_review + no review evidence (no PR + unbound qid) → required=0 (exempt)", async () => {
		const s = await setup();
		awaitingMain(s.store, { binding: "unbound", prNumber: null });
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
	});

	it("awaiting_review + code PR + policy ON + NO record → required=1 (fail-closed; A-3 will spawn)", async () => {
		const s = await setup();
		awaitingMain(s.store); // default: bound qid + pr 42 = review evidence
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(1);
	});

	it("engine-owned awaiting_review + NO record → required=0 and no orphan auto-QA", async () => {
		const s = await setup();
		vi.spyOn(s.store, "isWorkflowEngineOwnedExecution").mockReturnValue(true);
		awaitingMain(s.store);

		await s.coord.reconcileOnStartup();

		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
		expect(s.start).not.toHaveBeenCalled();
		expect(s.createCalls).toEqual([]);
	});

	it("an existing auto-QA record remains required even if the parent is engine-owned", async () => {
		const s = await setup();
		vi.spyOn(s.store, "isWorkflowEngineOwnedExecution").mockReturnValue(true);
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});

		await s.coord.reconcileOnStartup();

		expect(s.store.getSession("main-1")?.qa_required).toBe(1);
	});

	it("approved_to_ship + code PR + policy ON + NO record → required=0 (grandfather, no strand)", async () => {
		const s = await setup();
		awaitingMain(s.store, { status: "approved_to_ship" });
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
	});

	it("idempotent: an existing snapshot is NOT overwritten (immutable IS NULL guard)", async () => {
		const s = await setup();
		awaitingMain(s.store); // code PR that backfill would otherwise set to 1
		// Pre-seed an explicit 0 — a later backfill must NOT flip it to 1.
		s.store.setQaRequiredSnapshot({
			executionId: "main-1",
			required: 0,
			reason: "pre_existing",
		});
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
	});

	it("does NOT touch a `running` session (snapshot happens later at onMainAwaitingReview)", async () => {
		const s = await setup();
		awaitingMain(s.store, { status: "running" });
		await s.coord.reconcileOnStartup();
		expect(s.store.getSession("main-1")?.qa_required).toBeUndefined();
	});
});

// ─────────────────────────── FLY-827 Codex hard gate ─────────────────────────

function codexEvent(
	over: Partial<QaResultEvent["payload"]> & { execution_id?: string } = {},
): QaResultEvent {
	const { execution_id, ...payload } = over;
	return {
		event_id: "codex-evt-1",
		execution_id: execution_id ?? "qa-runner-x",
		issue_id: "FLY-1",
		project_name: "proj",
		event_type: "codex_review_result",
		payload: {
			reviewType: "code",
			status: "APPROVED",
			prHeadSha: SHA,
			targetExecutionId: "main-1",
			...payload,
		},
	};
}

describe("FLY-827 AutoQaCoordinator codex hard gate (gate ON)", () => {
	async function gateOnSetup() {
		// env = {} → FLYWHEEL_CODEX_HARD_GATE undefined → gate ON.
		return setup({ env: {} });
	}

	// FLY-863 (Annie 2026-07-04): a routine codex-hold — the normal,
	// self-recovering first step nearly every PR passes through before Codex
	// has even run — must stay SILENT (no thread post, no Lead alert).
	it("codex NOT approved → does NOT spawn QA; re-queues instruction, stays SILENT (no thread post, no alert)", async () => {
		const s = await gateOnSetup();
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main);

		// No QA runner, no auto_qa_record.
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		// Self-heal action still fires; the loud bundle does not.
		expect(s.codexQueues).toEqual([{ execId: "main-1" }]);
		expect(s.codexAlerts).toEqual([]);
		expect(s.postTexts().some((t) => t.includes("Codex code review"))).toBe(
			false,
		);
	});

	it("codex approved for this head → spawns QA normally", async () => {
		const s = await gateOnSetup();
		const main = awaitingMain(s.store);
		s.store.recordCodexReviewApproved({
			executionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		await s.coord.onMainAwaitingReview(main);

		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		expect(s.codexQueues).toEqual([]);
	});

	it("codex_skip session bypasses the gate → spawns QA without a record", async () => {
		const s = await gateOnSetup();
		awaitingMain(s.store); // creates main-1 (return unused; re-read after patch below)
		s.store.patchSessionMetadata("main-1", { codex_skip: 1 });
		const refreshed = s.store.getSession("main-1");
		if (!refreshed) throw new Error("no session");
		await s.coord.onMainAwaitingReview(refreshed);
		expect(s.start).toHaveBeenCalledTimes(1);
	});

	it("onCodexReviewResult records approval + re-drives QA (complete-before-report race, codexReleased)", async () => {
		const s = await gateOnSetup();
		// Parent already reached awaiting_review while codex-held (no record yet).
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main); // codex-held, no spawn
		expect(s.start).not.toHaveBeenCalled();

		// Codex verdict arrives → record approved + re-drive → QA spawns.
		await s.coord.onCodexReviewResult(codexEvent());
		expect(s.store.isCodexCodeReviewApproved("main-1", SHA)).toBe(true);
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
	});

	it("onCodexReviewResult ignores non-APPROVED / non-code / bad sha / unknown exec (no record)", async () => {
		const s = await gateOnSetup();
		awaitingMain(s.store);
		await s.coord.onCodexReviewResult(codexEvent({ status: "CHANGES" }));
		await s.coord.onCodexReviewResult(codexEvent({ reviewType: "design" }));
		await s.coord.onCodexReviewResult(codexEvent({ prHeadSha: "nothex" }));
		await s.coord.onCodexReviewResult(
			codexEvent({ targetExecutionId: "no-such-exec" }),
		);
		expect(s.store.isCodexCodeReviewApproved("main-1", SHA)).toBe(false);
		expect(s.start).not.toHaveBeenCalled();
	});

	it("fix-loop new head: existing QA owner + new head + codex NOT approved → codex-hold, NO retest wake (MED-8)", async () => {
		const s = await gateOnSetup();
		// Head A: codex approved → QA spawns + owner record created.
		const mainA = awaitingMain(s.store);
		s.store.recordCodexReviewApproved({
			executionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		await s.coord.onMainAwaitingReview(mainA);
		expect(s.start).toHaveBeenCalledTimes(1);

		// New head B (implementer pushed a fix), codex NOT yet approved for B.
		s.store.setReviewBinding("main-1", { questionId: "q2", prHeadSha: SHA2 });
		const mainB = s.store.getSession("main-1");
		if (!mainB) throw new Error("no session");
		await s.coord.onMainAwaitingReview(mainB);

		// No retest wake, owner record NOT retargeted to B; codex-hold instead.
		// The new head's hold is also routine and stays silent.
		expect(s.retests).toEqual([]);
		expect(s.codexAlerts.some((a) => a.sha === SHA2)).toBe(false);
		expect(s.store.getAutoQaRecord("main-1", SHA2)).toBeUndefined();

		// Codex approves B → the gate is now satisfied for B and a re-drive proceeds
		// PAST the codex hold into the QA path (a fresh spawn here since the mock QA
		// runner has no live session — the point is the gate no longer blocks B).
		await s.coord.onCodexReviewResult(codexEvent({ prHeadSha: SHA2 }));
		expect(s.store.isCodexCodeReviewApproved("main-1", SHA2)).toBe(true);
		expect(s.store.getAutoQaRecord("main-1", SHA2)?.status).toBe(
			"retry_pending",
		);
		await s.coord.sweepOrphanedQaRecords();
		expect(s.start).toHaveBeenCalledTimes(2);
	});

	it("codex-hold re-queue fires ONCE per head — a repeated reconcile is a no-op (R1 MED-1); routine hold stays silent throughout (FLY-863)", async () => {
		const s = await gateOnSetup();
		const main = awaitingMain(s.store);
		// Live path: first hold re-queues the instruction; no thread/alert.
		await s.coord.onMainAwaitingReview(main);
		expect(s.codexQueues).toHaveLength(1);
		expect(s.codexAlerts).toHaveLength(0);
		expect(
			s.postTexts().filter((t) => t.includes("Codex code review")),
		).toHaveLength(0);

		// Reconcile (restart replay) for the same head → NO new re-queue, still silent.
		await s.coord.reconcileCodexHolds();
		await s.coord.reconcileCodexHolds();
		expect(s.codexQueues).toHaveLength(1);
		expect(s.codexAlerts).toHaveLength(0);
		expect(
			s.postTexts().filter((t) => t.includes("Codex code review")),
		).toHaveLength(0);
	});

	it("reconcileCodexHolds re-queues for an awaiting_review session still lacking codex (fresh, no prior notify), stays silent (FLY-863)", async () => {
		const s = await gateOnSetup();
		awaitingMain(s.store); // awaiting_review, no codex record, never went through onMainAwaitingReview
		await s.coord.reconcileCodexHolds();
		expect(s.codexQueues).toHaveLength(1);
		expect(s.codexAlerts).toHaveLength(0);
	});

	it("Lead follow-up: skips auto-QA when a normal runner is re-dispatched onto a QA issue itself (no QA-of-QA, #828 guard)", async () => {
		const s = await setup(); // guard runs BEFORE the codex gate — gate state is irrelevant
		// Register a QA issue exactly as FLY-643 would (claim record + set qa_issue_id).
		s.store.claimAutoQaRecord({
			parentExecutionId: "parent-x",
			targetPrHeadSha: SHA,
			issueId: "FLY-parent",
			projectName: "proj",
		});
		s.store.setAutoQaIssue("parent-x", SHA, {
			issueId: "qa-issue-uuid",
			issueIdentifier: "QA-1",
		});
		// A NORMAL (main-role) runner re-dispatched ON that QA issue.
		s.store.upsertSession({
			execution_id: "renorm-1",
			issue_id: "qa-issue-uuid",
			project_name: "proj",
			status: "awaiting_review",
			session_role: "main",
			branch: "b",
			pr_number: 9,
		});
		s.store.setReviewBinding("renorm-1", { questionId: "q", prHeadSha: SHA });
		const sess = s.store.getSession("renorm-1");
		if (!sess) throw new Error("no session");
		await s.coord.onMainAwaitingReview(sess);
		// No auto-QA spawned, no record claimed on the QA issue.
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getAutoQaRecord("renorm-1", SHA)).toBeUndefined();
	});
});

// FLY-863: the ONLY place the codex-hold thread-post + Lead alert now fire —
// once a head has sat unresolved past the stuck-duration threshold. A routine
// hold (covered above) never reaches here.
describe("AutoQaCoordinator FLY-846 spawn gates", () => {
	let s: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		s = await setup();
	});

	const SHA3 = "c".repeat(40);

	describe("gate ⓪ — coordinator-level status guard", () => {
		it("a row no longer awaiting_review (approved_to_ship) never spawns, even with full evidence (DirectEventSink evidence-only straggler)", async () => {
			const main = awaitingMain(s.store, { status: "approved_to_ship" });
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.createCalls.length).toBe(0);
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
			expect(s.alerts).toEqual([]);
		});

		it("re-reads the ROW: a STALE session snapshot saying awaiting_review cannot spawn once the row moved to approved_to_ship (Codex R1 LOW-2)", async () => {
			// Snapshot taken while genuinely awaiting_review...
			const staleSnapshot = awaitingMain(s.store);
			expect(staleSnapshot.status).toBe("awaiting_review");
			// ...then the row moves on (approval landed).
			s.store.upsertSession({
				execution_id: "main-1",
				issue_id: "FLY-1",
				project_name: "proj",
				status: "approved_to_ship",
			});
			await s.coord.onMainAwaitingReview(staleSnapshot);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		});
	});

	describe("gate ① — never QA a QA issue", () => {
		it("skips a main session whose issue title carries the QA · prefix (FLY-828/845 shape)", async () => {
			const main = awaitingMain(s.store, {
				issueTitle: "QA · FLY-793 — [pipeline] 三段式",
			});
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.createCalls.length).toBe(0);
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
			expect(s.alerts).toEqual([]);
		});

		it("skips when the issue_id matches a record's qa_issue_id (title lost/retitled)", async () => {
			s.store.claimAutoQaRecord({
				parentExecutionId: "other-main",
				targetPrHeadSha: SHA2,
				issueId: "FLY-793",
				projectName: "proj",
			});
			s.store.setAutoQaIssue("other-main", SHA2, {
				issueId: "qa-824-uuid",
				issueIdentifier: "FLY-824",
				issueTitle: "QA · FLY-793 — x",
			});
			const main = awaitingMain(s.store, {
				issueId: "qa-824-uuid",
				issueIdentifier: "FLY-999",
				issueTitle: "retitled — no prefix",
			});
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		});

		it("skips when the issue_identifier matches a record's qa_issue_identifier", async () => {
			s.store.claimAutoQaRecord({
				parentExecutionId: "other-main",
				targetPrHeadSha: SHA2,
				issueId: "FLY-818",
				projectName: "proj",
			});
			s.store.setAutoQaIssue("other-main", SHA2, {
				issueId: "qa-839-uuid",
				issueIdentifier: "FLY-839",
				issueTitle: "QA · FLY-818 — x",
			});
			const main = awaitingMain(s.store, {
				issueId: "some-other-uuid",
				issueIdentifier: "FLY-839",
				issueTitle: "retitled — no prefix",
			});
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		});
	});

	describe("gate ② — only a genuine review-pass spawns", () => {
		it("no qid (NULL) + no pr_number → skip, no record, no alert (FLY-842 body-kill shape)", async () => {
			const main = awaitingMain(s.store, { binding: "null", prNumber: null });
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.createCalls.length).toBe(0);
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
			expect(s.alerts).toEqual([]);
		});

		it("unbound sentinel qid + no pr_number → skip (sentinel is NOT evidence)", async () => {
			const main = awaitingMain(s.store, {
				binding: "unbound",
				prNumber: null,
			});
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
		});

		it("real qid alone (no pr_number) → spawn", async () => {
			const main = awaitingMain(s.store, { prNumber: null });
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).toHaveBeenCalledTimes(1);
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		});

		it("pr_number alone (unbound qid) → spawn (LEARN checkpoint-less shape)", async () => {
			const main = awaitingMain(s.store, { binding: "unbound" });
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).toHaveBeenCalledTimes(1);
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		});

		it("retest path is protected too: a new head WITHOUT evidence neither retargets nor wakes", async () => {
			// Owner record exists from an earlier round; the parent row carries no
			// review evidence (constructed directly — the defensive case).
			s.store.claimAutoQaRecord({
				parentExecutionId: "main-1",
				targetPrHeadSha: SHA,
				issueId: "FLY-1",
				projectName: "proj",
			});
			const main2 = awaitingMain(s.store, {
				prHeadSha: SHA2,
				binding: "null",
				prNumber: null,
			});
			await s.coord.onMainAwaitingReview(main2, { freshTransition: false });
			expect(s.retests).toEqual([]);
			expect(s.start).not.toHaveBeenCalled();
			// Record NOT retargeted — still on the old head.
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
			expect(s.store.getAutoQaRecord("main-1", SHA2)).toBeUndefined();
		});
	});

	describe("gate ③ — one issue, one active QA", () => {
		function foreignRecord(
			o: {
				status?: "running" | "awaiting_retest" | "stuck";
				qaExec?: string;
			} = {},
		) {
			s.store.claimAutoQaRecord({
				parentExecutionId: "other-main",
				targetPrHeadSha: SHA2,
				issueId: "FLY-1",
				projectName: "proj",
			});
			if (o.qaExec) {
				s.store.setAutoQaQaExecutionId("other-main", SHA2, o.qaExec);
			}
			if (o.status && o.status !== "running") {
				s.store.setAutoQaStatus("other-main", SHA2, o.status, {});
			}
		}

		it("foreign ACTIVE record whose parent still owns it (awaiting_review + same head) → skip + Lead alert, no new record", async () => {
			foreignRecord();
			awaitingMain(s.store, { id: "other-main", prHeadSha: SHA2 });
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
			expect(s.alerts.length).toBe(1);
			// The foreign record is untouched.
			expect(s.store.getAutoQaRecord("other-main", SHA2)?.status).toBe(
				"running",
			);
		});

		it("foreign parent awaiting_review but on a DIFFERENT head (moved on) → supersede + proceed", async () => {
			foreignRecord();
			awaitingMain(s.store, { id: "other-main", prHeadSha: SHA3 });
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.store.getAutoQaRecord("other-main", SHA2)?.status).toBe(
				"superseded",
			);
			expect(s.start).toHaveBeenCalledTimes(1);
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
			expect(s.alerts).toEqual([]);
		});

		it("foreign parent TERMINAL + its QA still alive → supersede + close old QA once + proceed (FLY-696→842/852 replay)", async () => {
			foreignRecord({ qaExec: "other-qa" });
			awaitingMain(s.store, {
				id: "other-main",
				prHeadSha: SHA2,
				status: "terminated",
			});
			s.store.upsertSession({
				execution_id: "other-qa",
				issue_id: "qa-issue-uuid-old",
				project_name: "proj",
				status: "running",
				session_role: "qa",
			});
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.store.getAutoQaRecord("other-main", SHA2)?.status).toBe(
				"superseded",
			);
			expect(s.closes).toEqual([{ qaExec: "other-qa" }]);
			expect(s.start).toHaveBeenCalledTimes(1);
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
		});

		it("foreign parent session MISSING → supersede + proceed (no close when no QA session)", async () => {
			foreignRecord({ status: "awaiting_retest" });
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.store.getAutoQaRecord("other-main", SHA2)?.status).toBe(
				"superseded",
			);
			expect(s.closes).toEqual([]);
			expect(s.start).toHaveBeenCalledTimes(1);
		});

		it("a stuck foreign record blocks while its parent still owns it", async () => {
			foreignRecord({ status: "stuck" });
			awaitingMain(s.store, { id: "other-main", prHeadSha: SHA2 });
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).not.toHaveBeenCalled();
			expect(s.alerts.length).toBe(1);
		});

		it("foreign passed/superseded records never block a new QA", async () => {
			s.store.claimAutoQaRecord({
				parentExecutionId: "p-passed",
				targetPrHeadSha: SHA2,
				issueId: "FLY-1",
				projectName: "proj",
			});
			s.store.setAutoQaStatus("p-passed", SHA2, "passed", {});
			s.store.claimAutoQaRecord({
				parentExecutionId: "p-superseded",
				targetPrHeadSha: SHA3,
				issueId: "FLY-1",
				projectName: "proj",
			});
			s.store.setAutoQaStatus("p-superseded", SHA3, "superseded", {});
			const main = awaitingMain(s.store);
			await s.coord.onMainAwaitingReview(main);
			expect(s.start).toHaveBeenCalledTimes(1);
			expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
			expect(s.store.getAutoQaRecord("p-passed", SHA2)?.status).toBe("passed");
		});

		it("gate③ hang-proof (Codex R2 HIGH-1): a NEVER-resolving stale-QA close does not block the new spawn", async () => {
			// closeRunner's Terminal path can hang with no timeout — the detached
			// cleanup must leave the spawn critical path untouched.
			const s2 = await setup({
				closeQaRunnerImpl: () => new Promise<void>(() => {}),
			});
			s2.store.claimAutoQaRecord({
				parentExecutionId: "other-main",
				targetPrHeadSha: SHA2,
				issueId: "FLY-1",
				projectName: "proj",
			});
			s2.store.setAutoQaQaExecutionId("other-main", SHA2, "other-qa");
			awaitingMain(s2.store, {
				id: "other-main",
				prHeadSha: SHA2,
				status: "terminated",
			});
			s2.store.upsertSession({
				execution_id: "other-qa",
				issue_id: "qa-issue-uuid-old",
				project_name: "proj",
				status: "running",
				session_role: "qa",
			});

			const mainA = awaitingMain(s2.store);
			// Must RESOLVE (and spawn) despite the hung close.
			await s2.coord.onMainAwaitingReview(mainA);
			expect(s2.start).toHaveBeenCalledTimes(1);
			expect(s2.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
			// The close was still ATTEMPTED once (detached).
			expect(s2.closes).toEqual([{ qaExec: "other-qa" }]);
		});

		it("race (Codex R1 HIGH-1): the new claim is visible BEFORE the stale-QA close awaits — a concurrent same-issue parent cannot double-spawn", async () => {
			let releaseClose!: () => void;
			const closeGate = new Promise<void>((resolve) => {
				releaseClose = resolve;
			});
			const s2 = await setup({ closeQaRunnerImpl: () => closeGate });

			// Stale foreign record (parent terminated) with a still-live QA runner.
			s2.store.claimAutoQaRecord({
				parentExecutionId: "other-main",
				targetPrHeadSha: SHA2,
				issueId: "FLY-1",
				projectName: "proj",
			});
			s2.store.setAutoQaQaExecutionId("other-main", SHA2, "other-qa");
			awaitingMain(s2.store, {
				id: "other-main",
				prHeadSha: SHA2,
				status: "terminated",
			});
			s2.store.upsertSession({
				execution_id: "other-qa",
				issue_id: "qa-issue-uuid-old",
				project_name: "proj",
				status: "running",
				session_role: "qa",
			});

			// Parent A reaches review; its gate ③ supersedes the stale record,
			// claims, then BLOCKS on the deferred close.
			const mainA = awaitingMain(s2.store);
			const p1 = s2.coord.onMainAwaitingReview(mainA);
			await vi.waitFor(() => {
				expect(s2.closes.length).toBe(1);
			});

			// While A's close is still in flight, parent B on the SAME issue
			// completes. It must observe A's already-durable claim (owned) — not a
			// "no active record" gap — and skip + alert.
			const mainB = awaitingMain(s2.store, {
				id: "main-2",
				prHeadSha: "d".repeat(40),
			});
			await s2.coord.onMainAwaitingReview(mainB);

			releaseClose();
			await p1;

			// Exactly ONE spawn (A's); B was blocked by A's live claim.
			expect(s2.start).toHaveBeenCalledTimes(1);
			expect(s2.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
			expect(
				s2.store.getAutoQaRecord("main-2", "d".repeat(40)),
			).toBeUndefined();
			expect(s2.alerts.length).toBe(1);
			expect(s2.store.getAutoQaRecord("other-main", SHA2)?.status).toBe(
				"superseded",
			);
		});
	});
});

// ─────────────────────── FLY-869 A-3 orphan sweep ─────────────────────────────
describe("FLY-869 A-3 orphan sweep (reconcileOnStartup)", () => {
	it("awaiting_review main with NO auto_qa_record → re-drives → QA spawns", async () => {
		const s = await setup(); // codex gate off, policy enabled
		awaitingMain(s.store); // genuine review evidence, no record
		await s.coord.reconcileOnStartup();
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.store.getAutoQaRecord("main-1", SHA)?.status).toBe("running");
	});

	it("skips a session that ALREADY has a record (owned by sweeps 1-4, not an orphan)", async () => {
		const s = await setup();
		awaitingMain(s.store);
		s.store.claimAutoQaRecord({
			parentExecutionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1",
			projectName: "proj",
		});
		s.store.setAutoQaStatus("main-1", SHA, "passed", { notifiedAt: true });
		await s.coord.reconcileOnStartup();
		expect(s.start).not.toHaveBeenCalled();
	});

	it("EXCLUDES a merge_block (parked merged-but-unapproved) session — never QA it", async () => {
		const s = await setup();
		awaitingMain(s.store); // no record
		s.store.setMergeBlock({
			executionId: "main-1",
			reason: "merge_without_approval:x/y",
			head: SHA,
		});
		await s.coord.reconcileOnStartup();
		expect(s.start).not.toHaveBeenCalled();
	});

	it("does NOT spawn for a policy-exempt orphan (snapshot 0, no QA)", async () => {
		const s = await setup({
			policy: { enabled: false, reason: "no_qa_label" },
		});
		awaitingMain(s.store);
		await s.coord.reconcileOnStartup();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getSession("main-1")?.qa_required).toBe(0);
	});
});

// ──────────────── FLY-869 B merge_without_approval loud alert ─────────────────
describe("FLY-869 B alertMergeWithoutApproval", () => {
	it("fires the loud pipeline-error Lead alert with the given reason", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.alertMergeWithoutApproval(
			main,
			"runner self-merged, no approval",
		);
		expect(s.alerts).toContain("runner self-merged, no approval");
	});

	// FLY-869 × FLY-863 boundary (Lead requirement): the 869 loud alert is
	// reserved for a REAL violation (merged-without-approval). It must NOT re-noise
	// the routine codex hold that FLY-863 deliberately silenced — a normal
	// awaiting_review session whose Codex review simply hasn't APPROVED yet posts
	// no thread + fires NO Lead alert.
	it("does NOT fire on a routine codex hold (863's silenced normal state stays silent)", async () => {
		const s = await setup({ env: {} }); // codex hard gate ON, no approval
		const main = awaitingMain(s.store);
		await s.coord.onMainAwaitingReview(main); // routine codex hold
		// 863: routine hold posts no thread + fires no Lead pipeline alert.
		expect(s.posts).toEqual([]);
		expect(s.alerts).toEqual([]);
		// 869 loud alert did not spawn QA or park anything either.
		expect(s.start).not.toHaveBeenCalled();
	});

	// Codex R1 #3: a parked (merge_block) session that receives a Codex APPROVED verdict
	// must NOT be QA'd back toward ship — the live entry consumes the merge_block
	// suppressor, not only the A-3 orphan sweep.
	it("a Codex approval on a PARKED merge_block session does NOT spawn QA (held)", async () => {
		const s = await setup(); // codex gate off — isolate the merge_block guard
		awaitingMain(s.store); // awaiting_review main
		s.store.setMergeBlock({
			executionId: "main-1",
			reason: "merge_without_approval:x/y",
			head: SHA,
		});
		// A same-head Codex approval re-drives onMainAwaitingReview(codexReleased) —
		// which must early-return on merge_block_reason, never spawning QA.
		await s.coord.onCodexReviewResult(codexEvent());
		expect(s.start).not.toHaveBeenCalled();
		expect(s.store.getAutoQaRecord("main-1", SHA)).toBeUndefined();
	});
});

describe("FLY-1505 alertShipAttemptFailed", () => {
	it("routes the factual reason through the dedicated ship-attempt effect", async () => {
		const s = await setup();
		const main = awaitingMain(s.store);
		await s.coord.alertShipAttemptFailed(
			main,
			"blocked completion deflected; approval preserved",
		);
		expect(s.alerts).toContain(
			"blocked completion deflected; approval preserved",
		);
	});
});
