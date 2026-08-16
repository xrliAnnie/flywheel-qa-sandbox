/**
 * FLY-1099 §3.3 — the founder action-ledger drain: dependency gating +
 * terminal propagation (R2 #2 / R3 #3), drain-time eligibility re-verify,
 * bounded at-least-once execution with the emit_alert coupling, and the
 * anti-recursion rule (an emit_alert's own terminal failure never spawns
 * another emit_alert — R4 #3). Backed by a REAL StateStore (:memory:) so the
 * transactional semantics are the production ones.
 */

import { describe, expect, it, vi } from "vitest";
import type { FounderActionIntent } from "../../StateStore.js";
import { StateStore } from "../../StateStore.js";
import {
	drainFounderActionLedger,
	FOUNDER_NOTIFY_RETRY_MAX,
	type FounderActionDrainDeps,
	feedbackWakeContent,
} from "../founder-action-drain.js";

const SHA_A = "a".repeat(40);

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

async function harness(over: Partial<FounderActionDrainDeps> = {}) {
	const store = await StateStore.create(":memory:");
	const sessions = new Map<
		string,
		{ status?: string; pr_head_sha?: string; pr_number?: number }
	>();
	sessions.set("E-1", {
		status: "awaiting_review",
		pr_head_sha: SHA_A,
		pr_number: 42,
	});
	const postNotice = vi.fn(async () => ({ ok: true }));
	const wake = vi.fn(async () => ({ ok: true }));
	const alertSink = { alert: vi.fn(async () => ({ sent: true })) };
	const deps: FounderActionDrainDeps = {
		store: Object.assign(store, {
			getSession: (e: string) => sessions.get(e),
		}) as unknown as FounderActionDrainDeps["store"],
		postNotice,
		wake,
		alertSink,
		resolveAlertRoute: () => ({ leadId: "lead-1" }),
		nowMs: () => 999_000,
		...over,
	};
	return {
		store,
		sessions,
		deps,
		postNotice,
		wake,
		alertSink,
	};
}

describe("drainFounderActionLedger — execution + outcomes", () => {
	it("MERGED supersedes a queued notice without POST or action-attempt growth", async () => {
		const { store, deps, postNotice } = await harness({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "suppress_merged",
				cleanupComplete: true,
			}),
			resolveProjectRoot: () => "/repo",
		});
		store.insertFounderAction(
			intent({ payload: { text: "stale", questionId: "Q-1" } }),
		);
		await drainFounderActionLedger(deps);
		expect(postNotice).not.toHaveBeenCalled();
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"cancelled",
		);
		expect(store.getFounderAction("held-reply-Q-1-100")?.attempts).toBe(0);
	});

	it("UNKNOWN leaves the queued notice pending without consuming action retries", async () => {
		const { store, deps, postNotice } = await harness({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "retry_later",
				reason: "budget",
			}),
			resolveProjectRoot: () => "/repo",
		});
		store.insertFounderAction(
			intent({ payload: { text: "wait", questionId: "Q-1" } }),
		);
		await drainFounderActionLedger(deps);
		expect(postNotice).not.toHaveBeenCalled();
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"pending",
		);
		expect(store.getFounderAction("held-reply-Q-1-100")?.attempts).toBe(0);
	});

	it("terminal guard failure cancels the notice instead of spinning", async () => {
		const { store, deps, postNotice } = await harness({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "terminal_unavailable",
				reason: "unknown_exhausted",
			}),
			resolveProjectRoot: () => "/repo",
		});
		store.insertFounderAction(
			intent({ payload: { text: "never", questionId: "Q-1" } }),
		);
		await drainFounderActionLedger(deps);
		expect(postNotice).not.toHaveBeenCalled();
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"cancelled",
		);
	});

	it("held_reply notice → postNotice → delivered", async () => {
		const { store, deps, postNotice } = await harness();
		store.insertFounderAction(intent());
		await drainFounderActionLedger(deps);
		expect(postNotice).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: "T-1", text: "存着了" }),
		);
		expect(store.getFounderAction("held-reply-Q-1-100")?.status).toBe(
			"delivered",
		);
	});

	it("feedback_wake carries the FULL feedback text to the runner (R3 #1)", async () => {
		const { store, deps, wake } = await harness();
		store.insertFounderAction(
			intent({
				actionKey: "feedback-wake-Q-1-100",
				kind: "feedback_wake",
				payload: {
					feedback: "改这三处:A、B、C(完整原文)",
					questionId: "Q-1",
					msgId: "100",
				},
			}),
		);
		await drainFounderActionLedger(deps);
		expect(wake).toHaveBeenCalledWith(
			expect.objectContaining({
				content: feedbackWakeContent("改这三处:A、B、C(完整原文)"),
			}),
		);
	});
});

describe("drainFounderActionLedger — bounded failure + must-deliver alerts (§7.1)", () => {
	it("transient failure retries across passes; terminal failure lands failed + emit_alert intent in ONE transaction", async () => {
		const { store, deps } = await harness({
			postNotice: vi.fn(async () => ({ ok: false, error: "discord 500" })),
		});
		store.insertFounderAction(intent());
		const max = FOUNDER_NOTIFY_RETRY_MAX;
		for (let i = 0; i < max; i++) await drainFounderActionLedger(deps);
		const row = store.getFounderAction("held-reply-Q-1-100");
		expect(row?.status).toBe("failed");
		expect(row?.failed_at_ms).toBe(999_000);
		const alertRow = store.getFounderAction("emit-alert-held-reply-Q-1-100");
		expect(alertRow?.status).toBe("pending");
		expect(alertRow?.kind).toBe("emit_alert");
	});

	it("emit_alert delivered only on a REAL outcome; duplicate claim is NOT a receipt → retried with a salted eventId", async () => {
		const alert = vi
			.fn()
			.mockResolvedValueOnce({ skipped: "duplicate" })
			.mockResolvedValueOnce({ sent: true });
		const { store, deps } = await harness({ alertSink: { alert } });
		store.insertFounderAction(
			intent({
				actionKey: "emit-alert-x",
				kind: "emit_alert",
				payload: {
					alert: {
						leadId: "lead-1",
						eventId: "base-evt",
						eventType: "founder_notify_dead_letter",
						title: "t",
						body: "b",
						severity: "warning",
					},
				},
			}),
		);
		await drainFounderActionLedger(deps);
		expect(store.getFounderAction("emit-alert-x")?.status).toBe("pending"); // claim ≠ receipt
		await drainFounderActionLedger(deps);
		expect(store.getFounderAction("emit-alert-x")?.status).toBe("delivered");
		// the retry attempt used a NEW salted eventId (claims.db permanent dedup)
		expect(alert.mock.calls[0]?.[0].eventId).toBe("base-evt");
		expect(alert.mock.calls[1]?.[0].eventId).toBe("base-evt:r1");
	});

	it("an emit_alert's own terminal failure NEVER spawns another emit_alert (R4 #3 anti-recursion)", async () => {
		const { store, deps } = await harness({
			alertSink: { alert: vi.fn(async () => ({ skipped: "no-channel" })) },
		});
		store.insertFounderAction(
			intent({
				actionKey: "emit-alert-x",
				kind: "emit_alert",
				payload: { alert: {} },
			}),
		);
		const max = FOUNDER_NOTIFY_RETRY_MAX;
		for (let i = 0; i < max; i++) await drainFounderActionLedger(deps);
		expect(store.getFounderAction("emit-alert-x")?.status).toBe("failed");
		// bounded terminal: exactly ONE row with the emit-alert prefix ever exists
		expect(store.getFounderAction("emit-alert-emit-alert-x")).toBeUndefined();
		// audited
		const events = store.getEventsByExecution("E-1");
		expect(
			events.some((e) => e.event_type === "founder_alert_emit_exhausted"),
		).toBe(true);
	});
});
