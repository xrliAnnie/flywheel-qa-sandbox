/**
 * FLY-1099 §4 — deferred founder approvals: capture support (2×2 truth table
 * via the handler's DeferralSupport) + the rebind pass state machine
 * (TTL / identity / gate_gone / head drift / hold recheck / write outcomes,
 * incl. the R4 #2 conflicting_prior_feedback terminal via the REAL
 * writeGateResponseAndRunPostWrite + a spy production hook — Codex R5 #1
 * demands the real writer, not a faked already_answered result).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	deferredApprovalTtlMs,
	headDriftText,
	heldReplyText,
	makeDeferralSupport,
	mergeBlockPointerText,
	type RebindCommDb,
	runDeferredApprovalRebindPass,
	ttlExpiredText,
} from "../approval-signal/deferred-approval.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FOUNDER = "F-1";

afterEach(() => {
	delete process.env.FLYWHEEL_DEFERRED_FOUNDER_APPROVAL;
	delete process.env.FLYWHEEL_HELD_DECLINED_REPLY;
	vi.restoreAllMocks();
});

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

/** Minimal writable-CommDB fake for the rebind write (real writer drives it). */
function fakeCommDb(opts: {
	pending?: boolean;
	priorResponse?: { content: string; from_agent: string };
}) {
	const state = {
		responses: new Map<string, { content: string; from_agent: string }>(),
		closed: false,
	};
	if (opts.priorResponse) state.responses.set("Q-1", opts.priorResponse);
	const db: RebindCommDb = {
		isQuestionPending: () => opts.pending !== false,
		getMessageById: (id: string) =>
			({ id, checkpoint: "approve_to_ship", from_agent: "E-1" }) as never,
		getResponse: (qid: string) => state.responses.get(qid) as never,
		insertResponse: (qid: string, from: string, content: string) => {
			if (state.responses.has(qid)) {
				throw new Error("UNIQUE constraint failed: messages.parent_id");
			}
			state.responses.set(qid, { content, from_agent: from });
		},
		close: () => {
			state.closed = true;
		},
	} as unknown as RebindCommDb;
	return { db, state };
}

interface SessionState {
	status?: string;
	review_question_id?: string | null;
	pr_head_sha?: string | null;
	pr_number?: number | null;
}

async function rebindHarness(opts: {
	session?: SessionState;
	expiresInSeconds?: number;
	decision?: "approve" | "reject";
	content?: string;
	priorResponse?: { content: string; from_agent: string };
	pending?: boolean;
	held?: boolean;
	founderId?: string;
	hookFlips?: boolean;
	guardResult?:
		| { kind: "continue"; prState: "open" }
		| { kind: "suppress_merged"; cleanupComplete: boolean }
		| { kind: "retry_later"; reason: "unknown" | "missing_binding" }
		| { kind: "terminal_unavailable"; reason: "unknown_exhausted" };
}) {
	const store = await freshStore();
	const sessionState: SessionState = opts.session ?? {
		status: "awaiting_review",
		review_question_id: "Q-1",
		pr_head_sha: SHA_A,
		pr_number: 42,
	};
	store.deferFounderApproval({
		questionId: "Q-1",
		msgId: "100",
		executionId: "E-1",
		issueId: "FLY-1",
		projectName: "proj",
		prHeadSha: SHA_A,
		threadId: "T-1",
		decision: opts.decision ?? "approve",
		content: opts.content ?? "ship",
		authorUserId: FOUNDER,
		founderIdAtCapture: FOUNDER,
		ttlSeconds: opts.expiresInSeconds ?? 2700,
	});
	const { db, state } = fakeCommDb({
		pending: opts.pending,
		priorResponse: opts.priorResponse,
	});
	const hook = vi.fn(() => {
		if (
			opts.hookFlips !== false &&
			(opts.decision ?? "approve") === "approve"
		) {
			sessionState.status = "approved_to_ship"; // production FSM flip
		}
		return { ok: true };
	});
	const reactImpl = vi.fn(async () => ({ ok: true, status: 204 }));
	const deps = {
		store: Object.assign(store, {
			getSession: () => sessionState,
		}) as unknown as Parameters<
			typeof runDeferredApprovalRebindPass
		>[0]["store"],
		canonicalFounderId: () => opts.founderId ?? FOUNDER,
		holdReasonFor: () => (opts.held ? ("codex_pending" as const) : null),
		openCommDb: () => db,
		onResponseWritten: hook as never,
		resolveBotToken: () => "bot-token",
		reactImpl: reactImpl as never,
		nowMs: () => Date.now(),
		mergedGateGuard: opts.guardResult
			? vi.fn().mockResolvedValue(opts.guardResult)
			: undefined,
		resolveProjectRoot: () => "/repo",
	};
	return { store, sessionState, deps, hook, reactImpl, commState: state };
}

describe("rebind pass — guard chain", () => {
	it("MERGED before TTL notice stays silent", async () => {
		const { store, deps, hook } = await rebindHarness({
			expiresInSeconds: 1,
			guardResult: { kind: "suppress_merged", cleanupComplete: true },
		});
		deps.nowMs = () => Date.now() + 10_000;
		await runDeferredApprovalRebindPass(deps);
		expect(store.getFounderAction("ttl-notice-Q-1-100")).toBeUndefined();
		expect(hook).not.toHaveBeenCalled();
	});

	it("transient UNKNOWN keeps the row active and emits no notice", async () => {
		const { store, deps, hook } = await rebindHarness({
			expiresInSeconds: 1,
			guardResult: { kind: "retry_later", reason: "unknown" },
		});
		deps.nowMs = () => Date.now() + 10_000;
		await runDeferredApprovalRebindPass(deps);
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(store.getFounderAction("ttl-notice-Q-1-100")).toBeUndefined();
		expect(hook).not.toHaveBeenCalled();
	});

	it("missing PR binding preserves the captured decision for a later rebind", async () => {
		const { store, deps, hook } = await rebindHarness({
			session: {
				status: "awaiting_review",
				review_question_id: "Q-1",
				pr_head_sha: SHA_A,
				pr_number: null,
			},
			guardResult: { kind: "retry_later", reason: "missing_binding" },
		});
		await runDeferredApprovalRebindPass(deps);
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(
			store.getDeferredApproval("Q-1", "100")?.invalidated_reason,
		).toBeUndefined();
		expect(hook).not.toHaveBeenCalled();
	});

	it("terminal UNKNOWN invalidates silently instead of retrying forever", async () => {
		const { store, deps, hook } = await rebindHarness({
			expiresInSeconds: 1,
			guardResult: {
				kind: "terminal_unavailable",
				reason: "unknown_exhausted",
			},
		});
		deps.nowMs = () => Date.now() + 10_000;
		await runDeferredApprovalRebindPass(deps);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"merged_guard_terminal",
		);
		expect(store.getFounderAction("ttl-notice-Q-1-100")).toBeUndefined();
		expect(hook).not.toHaveBeenCalled();
	});

	it("TTL expired → invalidate ttl_expired + notice intent + audit; never writes", async () => {
		const { store, deps, hook } = await rebindHarness({ expiresInSeconds: 1 });
		deps.nowMs = () => Date.now() + 10_000;
		await runDeferredApprovalRebindPass(deps);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"ttl_expired",
		);
		expect(store.getFounderAction("ttl-notice-Q-1-100")?.status).toBe(
			"pending",
		);
		expect(hook).not.toHaveBeenCalled();
	});

	it("founder identity changed since capture → invalidate silently (audit only, R1 #3)", async () => {
		const { store, deps } = await rebindHarness({ founderId: "F-NEW" });
		await runDeferredApprovalRebindPass(deps);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"founder_identity_changed",
		);
		expect(store.getFounderAction("ttl-notice-Q-1-100")).toBeUndefined();
	});

	it("gate answered/moved elsewhere → gate_gone (silent)", async () => {
		const { store, deps } = await rebindHarness({ pending: false });
		await runDeferredApprovalRebindPass(deps);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"gate_gone",
		);
	});

	it("head drift → invalidate head_drift + 明文 notice (founder must re-confirm)", async () => {
		const { store, deps } = await rebindHarness({
			session: {
				status: "awaiting_review",
				review_question_id: "Q-1",
				pr_head_sha: SHA_B,
			},
		});
		await runDeferredApprovalRebindPass(deps);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"head_drift",
		);
		expect(store.getFounderAction("head-drift-notice-Q-1-100")?.status).toBe(
			"pending",
		);
	});

	it("hold still present → SKIP (stays active, TTL bounds it); zero writes", async () => {
		const { store, deps, hook } = await rebindHarness({ held: true });
		await runDeferredApprovalRebindPass(deps);
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(hook).not.toHaveBeenCalled();
	});

	it("kill-switch FLYWHEEL_DEFERRED_FOUNDER_APPROVAL=0 → whole pass inert", async () => {
		process.env.FLYWHEEL_DEFERRED_FOUNDER_APPROVAL = "0";
		const { store, deps, hook } = await rebindHarness({});
		await runDeferredApprovalRebindPass(deps);
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(hook).not.toHaveBeenCalled();
	});
});

describe("rebind pass — write outcomes (今晚场景镜像 + R2 #1/R4 #2)", () => {
	it("passes the deferred route source and authority seam to the shared writer", async () => {
		const { deps } = await rebindHarness({});
		const cardAuthority = vi.fn().mockReturnValue({ ok: true });
		const writeImpl = vi
			.fn()
			.mockResolvedValue({ written: true, retrySafe: true });
		Object.assign(deps, { cardAuthority, writeImpl });

		await runDeferredApprovalRebindPass(deps as never);

		expect(writeImpl).toHaveBeenCalledOnce();
		expect(writeImpl.mock.calls[0]![0]).toMatchObject({
			source: "deferred",
			cardAuthority,
		});
	});

	it("硬要求③代码级: hold clear → writes {approved:true} via the REAL writer, hook flips FSM, consume + ✅ upgrade + rebound notice", async () => {
		const { store, deps, hook, reactImpl, commState } = await rebindHarness({});
		await runDeferredApprovalRebindPass(deps);
		// the gate now has the founder's structured approval
		expect(commState.responses.get("Q-1")?.content).toBe('{"approved": true}');
		expect(commState.responses.get("Q-1")?.from_agent).toBe(FOUNDER);
		expect(hook).toHaveBeenCalledOnce();
		// consumed + rebound notice + ✅ upgrade
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
		expect(store.getFounderAction("rebound-notice-Q-1-100")?.status).toBe(
			"pending",
		);
		expect(reactImpl).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: "100", emoji: "✅" }),
		);
	});

	it("R2 #1: response written but hook does NOT flip → stays ACTIVE (no consume, no ✅, no '已生效')", async () => {
		const { store, deps, reactImpl } = await rebindHarness({
			hookFlips: false,
		});
		await runDeferredApprovalRebindPass(deps);
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(store.getFounderAction("rebound-notice-Q-1-100")).toBeUndefined();
		expect(reactImpl).not.toHaveBeenCalled();
	});

	it("reject rebind: full feedback response + feedback_wake intent committed WITH consume (R3 #1 b')", async () => {
		const { store, deps, commState } = await rebindHarness({
			decision: "reject",
			content: "改这三处:A、B、C",
		});
		await runDeferredApprovalRebindPass(deps);
		const resp = JSON.parse(commState.responses.get("Q-1")?.content ?? "{}");
		expect(resp.approved).toBe(false);
		expect(resp.feedback).toBe("改这三处:A、B、C"); // FULL original text
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
		const wake = store.getFounderAction("feedback-wake-Q-1-100");
		expect(wake?.status).toBe("pending");
		expect(JSON.parse(wake?.payload ?? "{}").feedback).toBe("改这三处:A、B、C");
	});

	it("R4 #2 + R5 #1: prior SAME-direction reject with DIFFERENT feedback → conflicting_prior_feedback terminal, ZERO hook / ZERO wake (real writer + spy hook)", async () => {
		const { store, deps, hook } = await rebindHarness({
			decision: "reject",
			content: "新的不同反馈",
			priorResponse: {
				content: JSON.stringify({ approved: false, feedback: "旧反馈" }),
				from_agent: FOUNDER,
			},
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).not.toHaveBeenCalled(); // the guard refused BEFORE the hook
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"conflicting_prior_feedback",
		);
		expect(store.getFounderAction("feedback-wake-Q-1-100")).toBeUndefined();
		// double-excerpt audit
		const events = store.getEventsByExecution("E-1");
		const conflict = events.find(
			(e) => e.event_type === "conflicting_prior_feedback",
		);
		expect(conflict?.payload).toMatchObject({
			stored: expect.stringContaining("旧反馈"),
		});
	});

	it("prior response by ANOTHER actor → gate_gone (audit carries the actor), zero hook", async () => {
		const { store, deps, hook } = await rebindHarness({
			priorResponse: {
				content: '{"approved": true}',
				from_agent: "someone-else",
			},
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).not.toHaveBeenCalled();
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"gate_gone",
		);
	});

	it("exact-match canonical approve retry → hook re-runs (convergence), consume on flip", async () => {
		const { store, deps, hook } = await rebindHarness({
			priorResponse: { content: '{"approved": true}', from_agent: FOUNDER },
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).toHaveBeenCalledOnce(); // already_answered path re-runs the hook
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
	});
});

describe("capture support — 2×2 truth table (§4.4)", () => {
	async function captureHarness(holdReason: "codex_pending" | "merge_block") {
		const store = await freshStore();
		const support = makeDeferralSupport({
			store,
			holdReasonFor: () => holdReason,
			ctx: { issueId: "FLY-1", threadId: "T-1", projectName: "proj" },
		});
		return { store, support };
	}

	it("ON/ON: defer lands the row + the 已存着 held_reply notice atomically", async () => {
		const { store, support } = await captureHarness("codex_pending");
		support.defer({
			questionId: "Q-1",
			msgId: "100",
			executionId: "E-1",
			prHeadSha: SHA_A,
			decision: "approve",
			content: "ship",
			authorUserId: FOUNDER,
			founderIdAtCapture: FOUNDER,
			holdReason: "codex_pending",
		});
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		const notice = store.getFounderAction("held-reply-Q-1-100");
		expect(notice?.status).toBe("pending");
		expect(JSON.parse(notice?.payload ?? "{}").text).toBe(
			heldReplyText(
				"approve",
				"codex_pending",
				Math.round(deferredApprovalTtlMs() / 60_000),
			),
		);
	});

	it("ON/OFF: defer WITHOUT the thread notice (reply flag off)", async () => {
		process.env.FLYWHEEL_HELD_DECLINED_REPLY = "0";
		const { store, support } = await captureHarness("codex_pending");
		support.defer({
			questionId: "Q-1",
			msgId: "100",
			executionId: "E-1",
			prHeadSha: SHA_A,
			decision: "approve",
			content: "ship",
			authorUserId: FOUNDER,
			founderIdAtCapture: FOUNDER,
			holdReason: "codex_pending",
		});
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(store.getFounderAction("held-reply-Q-1-100")).toBeUndefined();
	});

	it("queueHeldNotice(merge_block) lands the recovery pointer text", async () => {
		const { store, support } = await captureHarness("merge_block");
		support.queueHeldNotice({
			questionId: "Q-1",
			msgId: "100",
			executionId: "E-1",
			kind: "merge_block",
			holdReason: "merge_block",
		});
		const notice = store.getFounderAction("held-reply-Q-1-100");
		expect(JSON.parse(notice?.payload ?? "{}").text).toBe(
			mergeBlockPointerText(),
		);
	});

	it("flag faces read env per call", async () => {
		const { support } = await captureHarness("codex_pending");
		expect(support.deferredEnabled()).toBe(true);
		process.env.FLYWHEEL_DEFERRED_FOUNDER_APPROVAL = "0";
		expect(support.deferredEnabled()).toBe(false);
		expect(support.heldReplyEnabled()).toBe(true);
		process.env.FLYWHEEL_HELD_DECLINED_REPLY = "0";
		expect(support.heldReplyEnabled()).toBe(false);
	});
});

describe("founder-facing texts", () => {
	it("TTL / head-drift texts distinguish 批准 vs 反馈", () => {
		expect(ttlExpiredText({ msg_id: "100", decision: "approve" })).toContain(
			"批准已过期",
		);
		expect(headDriftText({ msg_id: "100", decision: "reject" })).toContain(
			"反馈作废",
		);
	});
});

describe("Codex code R1 HIGH-1: answered-but-unflipped gate stays REBINDABLE", () => {
	it("prior founder approval + FSM stuck (awaiting_review) → rebind re-runs the hook → flip → consume (not gate_gone)", async () => {
		// The convergence-park shape: response durable, gate no longer pending,
		// session binding intact. The rebind pass must NOT classify gate_gone.
		const { store, deps, hook } = await rebindHarness({
			pending: false, // answered → out of getPendingQuestions/isQuestionPending
			priorResponse: { content: '{"approved": true}', from_agent: FOUNDER },
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).toHaveBeenCalledOnce(); // already_answered path re-ran the hook
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
		expect(
			store.getDeferredApproval("Q-1", "100")?.invalidated_reason,
		).toBeUndefined();
	});

	it("parked APPROVE whose flip already landed (crash between flip and consume) → consume, not gate_gone", async () => {
		const { store, deps, hook } = await rebindHarness({
			pending: false,
			priorResponse: { content: '{"approved": true}', from_agent: FOUNDER },
			session: {
				status: "approved_to_ship", // flip already happened
				review_question_id: "Q-1",
				pr_head_sha: SHA_A,
			},
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).not.toHaveBeenCalled(); // postcondition already met — no write
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
		expect(store.getFounderAction("rebound-notice-Q-1-100")?.status).toBe(
			"pending",
		);
	});
});

describe("Codex code R1 fixes — capture support additions", () => {
	it("parkForConvergence lands the durable row WITHOUT a held_reply notice", async () => {
		const store = await freshStore();
		const support = makeDeferralSupport({
			store,
			holdReasonFor: () => null,
			ctx: { issueId: "FLY-1", threadId: "T-1", projectName: "proj" },
		});
		support.parkForConvergence({
			questionId: "Q-1",
			msgId: "100",
			executionId: "E-1",
			prHeadSha: SHA_A,
			decision: "approve",
			content: "ship",
			authorUserId: FOUNDER,
			founderIdAtCapture: FOUNDER,
			reason: "FSM not flipped",
		});
		expect(store.listActiveDeferredApprovals()).toHaveLength(1);
		expect(store.getFounderAction("held-reply-Q-1-100")).toBeUndefined();
		const events = store.getEventsByExecution("E-1");
		expect(
			events.some(
				(e) => e.event_type === "founder_approval_parked_convergence",
			),
		).toBe(true);
	});

	it("queueFeedbackWake commits the durable feedback_wake intent (HIGH-2 b')", async () => {
		const store = await freshStore();
		const support = makeDeferralSupport({
			store,
			holdReasonFor: () => null,
			ctx: { issueId: "FLY-1", threadId: "T-1", projectName: "proj" },
		});
		support.queueFeedbackWake({
			questionId: "Q-1",
			msgId: "100",
			executionId: "E-1",
			feedback: "完整修改意见",
		});
		const row = store.getFounderAction("feedback-wake-Q-1-100");
		expect(row?.kind).toBe("feedback_wake");
		expect(JSON.parse(row?.payload ?? "{}").feedback).toBe("完整修改意见");
	});
});

describe("Codex code R2 HIGH: parked REJECT converges via the rebind exact-response path", () => {
	it("prior reject response (exact reconstruction) → hook re-runs → consume commits the feedback_wake intent atomically", async () => {
		const { store, deps, hook } = await rebindHarness({
			decision: "reject",
			content: "改 A/B/C",
			pending: false, // answered → out of the pending predicate
			priorResponse: {
				content: JSON.stringify({ approved: false, feedback: "改 A/B/C" }),
				from_agent: FOUNDER,
			},
		});
		await runDeferredApprovalRebindPass(deps);
		expect(hook).toHaveBeenCalledOnce(); // exact match → hook convergence re-run
		expect(store.getDeferredApproval("Q-1", "100")?.consumed_at).toBeTruthy();
		const wake = store.getFounderAction("feedback-wake-Q-1-100");
		expect(wake?.status).toBe("pending");
		expect(JSON.parse(wake?.payload ?? "{}").feedback).toBe("改 A/B/C");
	});
});
