import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { LegacyLeadEventReconciler } from "../legacy-lead-event-reconciler.js";
import { RuntimeRegistry } from "../runtime-registry.js";

describe("FLY-1373 legacy Lead event reconciliation", () => {
	let dir: string;
	let store: StateStore;
	let queue: LeadInboxQueue;
	let registry: RuntimeRegistry;
	const now = "2026-07-19T20:00:00.000Z";

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-reconcile-"));
		store = await StateStore.create(":memory:");
		queue = new LeadInboxQueue(join(dir, "comm.db"));
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-1",
			now,
			leaseTtlMs: 60_000,
		});
		registry = new RuntimeRegistry();
		registry.register(
			{ agentId: "lead-1", chatChannel: "chat", match: {} },
			{
				type: "test",
				deliver: vi.fn(),
				renderEnvelope: (env) => `rendered:${env.event.event_type}`,
				sendBootstrap: vi.fn(),
				health: vi.fn(),
				shutdown: vi.fn(),
			},
		);
	});

	afterEach(() => {
		queue.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function append(eventId: string): number {
		return store.appendLeadEvent(
			"lead-1",
			eventId,
			"session_completed",
			JSON.stringify({
				event_type: "session_completed",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "flywheel",
			}),
			"exec-1",
		);
	}

	it("repairs finalized legacy evidence in audit-first then queue-terminal order", async () => {
		const seq = append("event-1");
		const probe = vi.fn(async () => ({
			status: "delivered" as const,
			alias: "lead-1-old-attempt",
		}));
		await new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: probe,
			now: () => new Date(now),
		}).run();

		expect(store.getLeadEventBySeq(seq)?.delivered_at).toBeTruthy();
		expect(queue.getById("lead_event:lead-1:event-1")).toMatchObject({
			legacy_alias: "lead-1-old-attempt",
			disposition: "migrated",
			delivered_at: now,
			consumed_at: now,
		});
	});

	it("leaves unproven events pending for canonical idempotent delivery", async () => {
		append("event-2");
		await new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: async () => ({ status: "none" }),
			now: () => new Date(now),
		}).run();
		expect(queue.getById("lead_event:lead-1:event-2")).toMatchObject({
			content: "rendered:session_completed",
			consumed_at: null,
		});
	});

	it("leaves question events to QuestionAdmission instead of materializing a duplicate", async () => {
		store.appendLeadEvent(
			"lead-1",
			"gate-question-1",
			"gate_question",
			JSON.stringify({
				event_type: "gate_question",
				execution_id: "exec-1",
				question_id: "q-1",
			}),
			"exec-1",
		);
		const probe = vi.fn();
		await new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: probe,
			now: () => new Date(now),
		}).run();
		expect(queue.countPending("lead-1")).toBe(0);
		expect(probe).not.toHaveBeenCalled();
	});

	it("backfills the audit mirror after a crash left delivered queue evidence", async () => {
		const seq = append("event-3");
		queue.enqueue({
			id: "lead_event:lead-1:event-3",
			toLead: "lead-1",
			source: `lead_event:${seq}`,
			type: "session_completed",
			msgClass: "model",
			priority: 2,
			content: "rendered:session_completed",
		});
		queue.reconcileConsumed("lead_event:lead-1:event-3", {
			ownerEpoch: "epoch-1",
			disposition: "delivered",
			delivered: true,
			now,
		});
		const probe = vi.fn();
		await new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: probe,
			now: () => new Date(now),
		}).run();
		expect(store.getLeadEventBySeq(seq)?.delivered_at).toBeTruthy();
		expect(probe).not.toHaveBeenCalled();
	});

	it("commits delivered audit evidence before creating the terminal comm.db mirror", async () => {
		const seq = append("event-crash-order");
		const original = store.markLeadEventDelivered.bind(store);
		vi.spyOn(store, "markLeadEventDelivered").mockImplementation((value) => {
			original(value);
			throw new Error("crash after StateStore commit");
		});
		await expect(
			new LegacyLeadEventReconciler({
				store,
				registry,
				ownerEpoch: "epoch-1",
				queueForLead: () => queue,
				probeLegacyDelivery: async () => ({
					status: "delivered",
					alias: "lead-1-old-attempt",
				}),
				now: () => new Date(now),
			}).run(),
		).rejects.toThrow("crash after StateStore commit");

		expect(store.getLeadEventBySeq(seq)?.delivered_at).toBeTruthy();
		expect(
			queue.getById("lead_event:lead-1:event-crash-order"),
		).toBeUndefined();
	});
});
