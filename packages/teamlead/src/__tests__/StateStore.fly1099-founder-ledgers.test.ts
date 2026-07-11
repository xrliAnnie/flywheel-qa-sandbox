/**
 * FLY-1099 §3.1 — the three founder-reply reliability tables:
 *   founder_deferred_approval (historical key, single-active partial index,
 *   strict same-msg no-op, transactional consume/invalidate + held_reply
 *   supersede), founder_action_ledger (intent → outcome, terminal failure +
 *   emit_alert coupling), founder_reply_retry (bounded retry, dead-letter
 *   transaction, waterline cleanup).
 */

import { describe, expect, it } from "vitest";
import {
	type FounderActionIntent,
	isStateStoreIrreversibleTerminalForZombie,
	type SessionEvent,
	StateStore,
	ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES,
} from "../StateStore.js";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const SHA_A = "a".repeat(40);

function deferInput(over: Record<string, unknown> = {}) {
	return {
		questionId: "Q-1",
		msgId: "100",
		executionId: "E-1",
		issueId: "FLY-1",
		projectName: "proj",
		prHeadSha: SHA_A,
		threadId: "T-1",
		decision: "approve" as const,
		content: "ship",
		authorUserId: "F-1",
		founderIdAtCapture: "F-1",
		ttlSeconds: 2700,
		...over,
	};
}

function intent(over: Partial<FounderActionIntent> = {}): FounderActionIntent {
	return {
		actionKey: "held-reply-Q-1-100",
		kind: "held_reply",
		executionId: "E-1",
		issueId: "FLY-1",
		projectName: "proj",
		threadId: "T-1",
		payload: { text: "存着了" },
		...over,
	};
}

function audit(id: string, type = "founder_approval_deferred"): SessionEvent {
	return {
		event_id: id,
		execution_id: "E-1",
		issue_id: "FLY-1",
		project_name: "proj",
		event_type: type,
		source: "test",
	};
}

describe("founder_deferred_approval", () => {
	it("defer inserts an active row + the held_reply intent + audit in ONE transaction", async () => {
		const store = await freshStore();
		const r = store.deferFounderApproval({
			...deferInput(),
			heldReplyAction: intent(),
			audit: audit("aud-1"),
		});
		expect(r).toBe("inserted");
		const rows = store.listActiveDeferredApprovals();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.decision).toBe("approve");
		expect(rows[0]?.pr_head_sha).toBe(SHA_A);
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"pending",
		);
	});

	it("same (questionId, msgId) re-defer is a STRICT no-op — no TTL refresh, no ledger write (Codex R1 #3)", async () => {
		const store = await freshStore();
		store.deferFounderApproval(deferInput());
		const before = store.getDeferredApproval("Q-1", "100");
		const r = store.deferFounderApproval({
			...deferInput({ ttlSeconds: 99999 }),
			heldReplyAction: intent({ actionKey: "held-reply-Q-1-100-second" }),
		});
		expect(r).toBe("noop_existing");
		const after = store.getDeferredApproval("Q-1", "100");
		expect(after?.expires_at).toBe(before?.expires_at);
		expect(store.getFounderAction("held-reply-Q-1-100-second")).toBeUndefined();
	});

	it("a NEW msg for the same gate replaces the old active row (invalidated 'replaced') — historical key kept", async () => {
		const store = await freshStore();
		store.deferFounderApproval(deferInput({ msgId: "100" }));
		store.deferFounderApproval(
			deferInput({ msgId: "200", decision: "reject", content: "改一下" }),
		);
		const active = store.listActiveDeferredApprovals();
		expect(active).toHaveLength(1);
		expect(active[0]?.msg_id).toBe("200");
		const old = store.getDeferredApproval("Q-1", "100");
		expect(old?.invalidated_reason).toBe("replaced");
	});

	it("consume marks consumed + supersedes pending held_reply intents + commits the feedback_wake intent atomically (R3 #1 b')", async () => {
		const store = await freshStore();
		store.deferFounderApproval({
			...deferInput({ decision: "reject", content: "full feedback text" }),
			heldReplyAction: intent(),
		});
		const ok = store.consumeDeferredApproval({
			questionId: "Q-1",
			msgId: "100",
			notice: intent({
				actionKey: "rebound-notice-Q-1-100",
				kind: "rebound_notice",
				payload: { text: "已生效" },
			}),
			feedbackWake: intent({
				actionKey: "feedback-wake-Q-1-100",
				kind: "feedback_wake",
				payload: { feedback: "full feedback text" },
			}),
			audit: audit("aud-rebound", "founder_approval_rebound"),
		});
		expect(ok).toBe(true);
		expect(store.listActiveDeferredApprovals()).toHaveLength(0);
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"superseded",
		);
		expect(store.getFounderAction("rebound-notice-Q-1-100")?.status).toBe(
			"pending",
		);
		expect(store.getFounderAction("feedback-wake-Q-1-100")?.status).toBe(
			"pending",
		);
		// second consume is a no-op
		expect(
			store.consumeDeferredApproval({ questionId: "Q-1", msgId: "100" }),
		).toBe(false);
	});

	it("invalidate (head_drift) supersedes pending held_reply + lands the drift notice", async () => {
		const store = await freshStore();
		store.deferFounderApproval({
			...deferInput(),
			heldReplyAction: intent(),
		});
		const ok = store.invalidateDeferredApproval({
			questionId: "Q-1",
			msgId: "100",
			reason: "head_drift",
			notice: intent({
				actionKey: "head-drift-notice-Q-1-100",
				kind: "head_drift_notice",
				payload: { text: "作废" },
			}),
		});
		expect(ok).toBe(true);
		expect(store.getDeferredApproval("Q-1", "100")?.invalidated_reason).toBe(
			"head_drift",
		);
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"superseded",
		);
		expect(store.getFounderAction("head-drift-notice-Q-1-100")?.status).toBe(
			"pending",
		);
	});
});

describe("founder_action_ledger", () => {
	it("insertFounderAction is INSERT OR IGNORE by action_key", async () => {
		const store = await freshStore();
		expect(store.insertFounderAction(intent())).toBe(true);
		expect(store.insertFounderAction(intent())).toBe(false);
	});

	it("delivered / attempt-failure / terminal-failure state machine + emit_alert coupling (§7.1)", async () => {
		const store = await freshStore();
		store.insertFounderAction(intent());
		expect(store.recordFounderActionFailure("held-reply-Q-1-100", "boom")).toBe(
			1,
		);
		store.markFounderActionFailed({
			actionKey: "held-reply-Q-1-100",
			error: "boom",
			nowMs: 1234567,
			alertIntent: intent({
				actionKey: "emit-alert-held-reply-Q-1-100",
				kind: "emit_alert",
				payload: { alert: { eventId: "x" } },
			}),
		});
		const failed = store.getFounderAction("held-reply-Q-1-100");
		expect(failed?.status).toBe("failed");
		expect(failed?.failed_at_ms).toBe(1234567);
		// the emit_alert intent landed in the SAME transaction
		expect(
			store.getFounderAction("emit-alert-held-reply-Q-1-100")?.status,
		).toBe("pending");
		// a terminal row can no longer be delivered/cancelled
		store.markFounderActionDelivered("held-reply-Q-1-100");
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe("failed");
	});

	it("cancel only affects pending rows", async () => {
		const store = await freshStore();
		store.insertFounderAction(intent());
		store.markFounderActionDelivered("held-reply-Q-1-100");
		store.cancelFounderAction("held-reply-Q-1-100", "moved_on");
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"delivered",
		);
	});

	it("listPendingFounderActions returns only pending rows in insertion order", async () => {
		const store = await freshStore();
		store.insertFounderAction(intent({ actionKey: "a-1" }));
		store.insertFounderAction(intent({ actionKey: "a-2" }));
		store.markFounderActionDelivered("a-1");
		expect(store.listPendingFounderActions().map((r) => r.action_key)).toEqual([
			"a-2",
		]);
	});
});

describe("founder_reply_retry", () => {
	it("recordFounderReplyFailure upserts attempts + keeps first_seen_ms stable (episode salt, R3 #4)", async () => {
		const store = await freshStore();
		const r1 = store.recordFounderReplyFailure({
			threadId: "T-1",
			msgId: "100",
			stage: "wake_no_session_lead",
			error: "no_session_lead",
			nowMs: 1000,
		});
		expect(r1.attempts).toBe(1);
		expect(r1.first_seen_ms).toBe(1000);
		const r2 = store.recordFounderReplyFailure({
			threadId: "T-1",
			msgId: "100",
			stage: "wake_no_session_lead",
			error: "no_session_lead",
			nowMs: 2000,
		});
		expect(r2.attempts).toBe(2);
		expect(r2.first_seen_ms).toBe(1000); // NOT refreshed
	});

	it("dead-letter is ONE transaction: row mark + audit + emit_alert intent; repeat is a no-op", async () => {
		const store = await freshStore();
		store.recordFounderReplyFailure({
			threadId: "T-1",
			msgId: "100",
			stage: "wake_no_session_lead",
			error: "x",
			nowMs: 1000,
		});
		const ok = store.markFounderReplyDeadLettered({
			threadId: "T-1",
			msgId: "100",
			nowMs: 5000,
			audit: audit("dl-aud-1", "founder_reply_dead_letter"),
			alertIntent: intent({
				actionKey: "emit-alert-dl-T-1-100",
				kind: "emit_alert",
				payload: { alert: { eventId: "founder-reply-dl-100-5000" } },
			}),
		});
		expect(ok).toBe(true);
		const row = store.getFounderReplyRetry("T-1", "100");
		expect(row?.dead_lettered_ms).toBe(5000);
		expect(store.getFounderAction("emit-alert-dl-T-1-100")?.status).toBe(
			"pending",
		);
		// second DL attempt: no-op, no duplicate alert intent
		expect(
			store.markFounderReplyDeadLettered({
				threadId: "T-1",
				msgId: "100",
				nowMs: 6000,
				audit: audit("dl-aud-2", "founder_reply_dead_letter"),
				alertIntent: intent({
					actionKey: "emit-alert-dl-T-1-100-b",
					kind: "emit_alert",
					payload: {},
				}),
			}),
		).toBe(false);
		expect(store.getFounderAction("emit-alert-dl-T-1-100-b")).toBeUndefined();
	});

	it("waterline cleanup deletes every row the cursor safely crossed (Codex R2 #6), later rows survive", async () => {
		const store = await freshStore();
		for (const [msg, ts] of [
			["100", 1000],
			["200", 2000],
			["300", 3000],
		] as const) {
			store.recordFounderReplyFailure({
				threadId: "T-1",
				msgId: msg,
				stage: "s",
				error: "e",
				nowMs: ts,
			});
		}
		store.recordFounderReplyFailure({
			threadId: "T-other",
			msgId: "150",
			stage: "s",
			error: "e",
			nowMs: 1500,
		});
		const n = store.clearFounderReplyRetriesUpTo("T-1", "200");
		expect(n).toBe(2);
		expect(store.getFounderReplyRetry("T-1", "300")).toBeDefined();
		// other threads untouched
		expect(store.getFounderReplyRetry("T-other", "150")).toBeDefined();
	});
});

describe("isStateStoreIrreversibleTerminalForZombie (Codex R2 #4)", () => {
	it("每个允许值有单测 — enumerated terminal statuses are Z1-eligible", () => {
		for (const s of ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES) {
			expect(isStateStoreIrreversibleTerminalForZombie(s)).toBe(true);
		}
	});

	it("live / mid-flight statuses are NEVER Z1-eligible (awaiting_review = FLY-1049 → Z2)", () => {
		for (const s of [
			"running",
			"awaiting_review",
			"approved_to_ship",
			"approved",
			undefined,
			"",
		]) {
			expect(isStateStoreIrreversibleTerminalForZombie(s)).toBe(false);
		}
	});
});

describe("Codex code R5: dead-letter on a MISSING retry row (latch re-drive shape)", () => {
	it("creates the row + marks + lands audit + alert intent in ONE transaction", async () => {
		const store = await freshStore();
		const ok = store.markFounderReplyDeadLettered({
			threadId: "T-9",
			msgId: "900",
			nowMs: 7777,
			audit: audit("dl-missing-row", "founder_reply_dead_letter"),
			alertIntent: intent({
				actionKey: "emit-alert-dl-T-9-900",
				kind: "emit_alert",
				payload: { alert: { eventId: "founder-reply-dl-900-7777" } },
			}),
		});
		expect(ok).toBe(true);
		const row = store.getFounderReplyRetry("T-9", "900");
		expect(row?.dead_lettered_ms).toBe(7777);
		expect(store.getFounderAction("emit-alert-dl-T-9-900")?.status).toBe(
			"pending",
		);
	});
});
