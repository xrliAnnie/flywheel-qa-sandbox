import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1573 StateStore runner recipient state", () => {
	it("keeps awaiting_review deliverable while preserving outcome-terminal states", async () => {
		const store = await StateStore.create(":memory:");
		try {
			for (const [execution_id, status] of [
				["alive", "running"],
				["reviewing", "awaiting_review"],
				["shipping", "approved_to_ship"],
				["completed", "completed"],
				["approved", "approved"],
				["blocked", "blocked"],
				["failed", "failed"],
				["rejected", "rejected"],
				["deferred", "deferred"],
				["shelved", "shelved"],
				["terminated", "terminated"],
			] as const) {
				store.upsertSession({
					execution_id,
					issue_id: `FLY-${execution_id}`,
					project_name: "flywheel",
					status,
					issue_labels: JSON.stringify(["backend"]),
				});
			}
			expect(store.resolveRunnerRecipientState("alive")).toMatchObject({
				state: "alive",
				projectName: "flywheel",
				issueLabels: '["backend"]',
			});
			expect(store.resolveRunnerRecipientState("reviewing")?.state).toBe(
				"alive",
			);
			expect(store.resolveRunnerRecipientState("shipping")?.state).toBe(
				"alive",
			);
			for (const executionId of [
				"completed",
				"approved",
				"blocked",
				"failed",
				"rejected",
				"deferred",
				"shelved",
				"terminated",
			]) {
				expect(store.resolveRunnerRecipientState(executionId)?.state).toBe(
					"terminal_or_missing",
				);
			}
			expect(store.resolveRunnerRecipientState("missing")?.state).toBe(
				"terminal_or_missing",
			);
		} finally {
			store.close();
		}
	});
});

describe("FLY-1573 durable dead-letter alert intents", () => {
	const base = {
		id: "dead_letter_alert:lead_unacked:lead-1:10",
		sourceKind: "lead_unacked" as const,
		recipient: "lead-1",
		throughDeadSeq: 10,
		leadId: "lead-1",
		projectName: "flywheel",
		deadCount: 5,
		summary: "lead-1 has 5 unacked messages",
		windowMs: 30 * 60_000,
	};

	it("keeps one pending intent per recipient and advances the source cursor", async () => {
		const store = await StateStore.create(":memory:");
		try {
			expect(
				store.createDeadLetterAlertIntent({
					...base,
					now: "2026-08-10T10:00:00.000Z",
				}),
			).toBe("created");
			expect(
				store.createDeadLetterAlertIntent({
					...base,
					id: "dead_letter_alert:lead_unacked:lead-1:11",
					throughDeadSeq: 11,
					now: "2026-08-10T10:01:00.000Z",
				}),
			).toBe("pending");
			expect(store.listDeadLetterAlertCursors()).toEqual([
				{
					sourceKind: "lead_unacked",
					recipient: "lead-1",
					throughDeadSeq: 10,
				},
			]);
		} finally {
			store.close();
		}
	});

	it("settles only from a real receipt and anchors the 30-minute window there", async () => {
		const store = await StateStore.create(":memory:");
		try {
			store.createDeadLetterAlertIntent({
				...base,
				now: "2026-08-10T10:00:00.000Z",
			});
			expect(
				store.claimDeadLetterAlert({
					id: base.id,
					claimToken: "claim-1",
					now: "2026-08-10T10:01:00.000Z",
					windowMs: base.windowMs,
				}),
			).toBe(true);
			expect(store.settleDeadLetterAlertFromReceipt(base.id, base.id)).toBe(
				false,
			);
			store.recordAlertDeliveryReceipt(
				base.id,
				"sent",
				"2026-08-10T10:02:00.000Z",
			);
			expect(store.settleDeadLetterAlertFromReceipt(base.id, base.id)).toBe(
				true,
			);
			expect(
				store.createDeadLetterAlertIntent({
					...base,
					id: "dead_letter_alert:lead_unacked:lead-1:20",
					throughDeadSeq: 20,
					now: "2026-08-10T10:31:59.999Z",
				}),
			).toBe("rate_limited");
			expect(
				store.createDeadLetterAlertIntent({
					...base,
					id: "dead_letter_alert:lead_unacked:lead-1:20",
					throughDeadSeq: 20,
					now: "2026-08-10T10:32:00.000Z",
				}),
			).toBe("created");
		} finally {
			store.close();
		}
	});

	it("uses the notification window as the single ambiguous-attempt reclaim fence", async () => {
		const store = await StateStore.create(":memory:");
		try {
			store.createDeadLetterAlertIntent({
				...base,
				now: "2026-08-10T10:00:00.000Z",
			});
			expect(
				store.claimDeadLetterAlert({
					id: base.id,
					claimToken: "claim-1",
					now: "2026-08-10T10:01:00.000Z",
					windowMs: base.windowMs,
				}),
			).toBe(true);
			store.recordDeadLetterAlertFailure(base.id, "claim-1", "Crash");
			expect(store.listDueDeadLetterAlerts("2026-08-10T10:30:59.999Z")).toEqual(
				[],
			);
			expect(
				store.listDueDeadLetterAlerts("2026-08-10T10:31:00.000Z"),
			).toHaveLength(1);
			expect(
				store.claimDeadLetterAlert({
					id: base.id,
					claimToken: "claim-2",
					now: "2026-08-10T10:31:00.000Z",
					windowMs: base.windowMs,
				}),
			).toBe(true);
		} finally {
			store.close();
		}
	});
});
