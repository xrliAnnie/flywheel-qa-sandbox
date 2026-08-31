/**
 * FLY-927 (Task 2.2): alert_threads ticket lifecycle columns + accessors.
 * (The FLY-368 base-table suite lives in src/__tests__/alert-threads.test.ts —
 * its stale→resolve→new-episode semantics must stay green untouched.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";

// ─────────────────────────────────────────────────────────────────────────
// FLY-927 (Task 2.2): ticket lifecycle columns + accessors.
// ─────────────────────────────────────────────────────────────────────────
describe("FLY-927 alert_threads ticket lifecycle", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function openTicket(over: Record<string, unknown> = {}) {
		store.openAlertThread({
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			threadId: "t-1",
			channelId: "c-1",
			leadId: "lead-a",
			projectName: "fw",
			eventType: "rate_limit",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:codex",
			firstSeenAt: "2020-01-01 00:00:00",
			...over,
		});
	}

	it("migration is idempotent (double create/table init keeps working)", async () => {
		// A second in-memory store runs the same idempotent ALTERs — no throw.
		const again = await StateStore.create(":memory:");
		expect(again.getActiveAlertThread("nope")).toBeUndefined();
	});

	it("legacy open (no ticket fields) keeps NULL ticket semantics", () => {
		store.openAlertThread({
			correlationKey: "ck",
			eventId: "e",
			threadId: "t",
			channelId: "c",
			leadId: "l",
			projectName: "p",
			eventType: "pane_hash_stuck",
		});
		const row = store.getActiveAlertThread("ck");
		expect(row?.ticket_status).toBeNull();
		expect(row?.owner_ref).toBeNull();
		expect(row?.attempt_count).toBe(0);
		expect(row?.first_seen_at).toBeNull();
	});

	it("ticket open persists status/owner/first-seen; setTicketStatus ACK stamps acked_at once", () => {
		openTicket();
		let row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.owner_ref).toBe("infra_bot:codex");
		expect(row?.first_seen_at).toBe("2020-01-01 00:00:00");
		expect(row?.acked_at).toBeNull();

		store.setTicketStatus("fw|lead-a|rate_limit|", "ACK");
		row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.ticket_status).toBe("ACK");
		const firstAck = row?.acked_at;
		expect(firstAck).toBeTruthy();

		// A later status change never rewrites the first ack stamp.
		store.setTicketStatus("fw|lead-a|rate_limit|", "REPAIRING");
		store.setTicketStatus("fw|lead-a|rate_limit|", "ACK");
		row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.acked_at).toBe(firstAck);
	});

	it("duty ACK records disposition without changing the ticket lifecycle", () => {
		openTicket();
		expect(store.stampDutyAck("fw|lead-a|rate_limit|", "evt-1")).toBe(true);
		let row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.ticket_status).toBe("NEW");
		const firstAck = row?.acked_at;
		expect(firstAck).toBeTruthy();
		expect(store.listDutyOutstanding(10)).toEqual([]);

		store.setTicketStatus("fw|lead-a|rate_limit|", "REPAIRING");
		expect(store.stampDutyAck("fw|lead-a|rate_limit|", "evt-1")).toBe(true);
		row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.ticket_status).toBe("REPAIRING");
		expect(row?.acked_at).toBe(firstAck);
	});

	it("duty ACK cannot stamp a replacement episode", () => {
		openTicket();
		openTicket({ eventId: "evt-2", threadId: "t-2" });
		expect(store.stampDutyAck("fw|lead-a|rate_limit|", "evt-1")).toBe(false);
		expect(store.getActiveAlertThread("fw|lead-a|rate_limit|")).toEqual(
			expect.objectContaining({
				event_id: "evt-2",
				acked_at: null,
				ticket_status: "NEW",
			}),
		);
	});

	it("duty handoff atomically records completion, owner, and ESCALATED", () => {
		openTicket();
		expect(
			store.handoffTicket(
				"fw|lead-a|rate_limit|",
				"evt-1",
				"lead:flywheel-eng-lead",
			),
		).toBe(true);
		const row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.acked_at).toBeTruthy();
		expect(row?.owner_ref).toBe("lead:flywheel-eng-lead");
		expect(row?.ticket_status).toBe("ESCALATED");
	});

	it("duty handoff cannot reopen an episode ARC already resolved", () => {
		openTicket();
		store.setTicketStatus("fw|lead-a|rate_limit|", "RESOLVED", "evt-1");
		store.resolveAlertThread("fw|lead-a|rate_limit|", "evt-1");
		expect(
			store.handoffTicket(
				"fw|lead-a|rate_limit|",
				"evt-1",
				"lead:flywheel-eng-lead",
			),
		).toBe(false);
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				resolved_at: expect.any(String),
				ticket_status: "RESOLVED",
				owner_ref: "infra_bot:codex",
			}),
		);
	});

	it("bumpTicketAttempt increments toward the T2 budget", () => {
		openTicket();
		store.bumpTicketAttempt("fw|lead-a|rate_limit|");
		store.bumpTicketAttempt("fw|lead-a|rate_limit|");
		expect(
			store.getActiveAlertThread("fw|lead-a|rate_limit|")?.attempt_count,
		).toBe(2);
	});

	it("duty outstanding is bounded, newest-first, cursor-aware, and excludes legacy rows", () => {
		openTicket();
		store.resolveAlertThread("fw|lead-a|rate_limit|");
		openTicket({
			correlationKey: "fw|lead-b|crash_loop|",
			eventId: "evt-2",
			threadId: "t-2",
			leadId: "lead-b",
			eventType: "crash_loop",
		});
		openTicket({
			correlationKey: "fw|lead-c|quota|",
			eventId: "evt-3",
			threadId: "t-3",
			leadId: "lead-c",
			eventType: "quota",
		});
		store.openAlertThread({
			correlationKey: "legacy-active",
			eventId: "legacy-1",
			threadId: "legacy-t1",
			channelId: "c-1",
			leadId: "lead-a",
			projectName: "fw",
			eventType: "legacy",
		});
		store.openAlertThread({
			correlationKey: "legacy-resolved",
			eventId: "legacy-2",
			threadId: "legacy-t2",
			channelId: "c-1",
			leadId: "lead-a",
			projectName: "fw",
			eventType: "legacy",
		});
		store.resolveAlertThread("legacy-resolved");

		expect(
			store.listDutyOutstanding(2).map((row) => [row.event_id, row.resolved]),
		).toEqual([
			["evt-3", false],
			["evt-2", false],
		]);
		const cursor = store.getAlertThreadByEventId("evt-2");
		expect(cursor).toBeDefined();
		expect(
			store
				.listDutyOutstanding(2, cursor)
				.map((row) => [row.event_id, row.resolved]),
		).toEqual([["evt-3", false]]);
	});

	it("getActiveAlertThreadByEventId matches ONLY the active episode's event id", () => {
		openTicket();
		expect(store.getActiveAlertThreadByEventId("evt-1")?.thread_id).toBe("t-1");
		// Episode replace: new event id under the same correlation key.
		openTicket({ eventId: "evt-2", threadId: "t-2" });
		expect(store.getActiveAlertThreadByEventId("evt-1")).toBeUndefined();
		expect(store.getActiveAlertThreadByEventId("evt-2")?.thread_id).toBe("t-2");
		// Replace resets the lifecycle counters.
		expect(
			store.getActiveAlertThread("fw|lead-a|rate_limit|")?.attempt_count,
		).toBe(0);
	});

	it("episode-fenced status and resolve writes never mutate the replacement", () => {
		openTicket();
		openTicket({ eventId: "evt-2", threadId: "t-2" });
		expect(store.setTicketStatus("fw|lead-a|rate_limit|", "ACK", "evt-1")).toBe(
			0,
		);
		expect(store.resolveAlertThread("fw|lead-a|rate_limit|", "evt-1")).toBe(0);
		let row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.event_id).toBe("evt-2");
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.acked_at).toBeNull();

		expect(store.setTicketStatus("fw|lead-a|rate_limit|", "ACK")).toBe(1);
		row = store.getActiveAlertThread("fw|lead-a|rate_limit|");
		expect(row?.ticket_status).toBe("ACK");
	});

	it("duty lookup finds a ticket by root, thread, or event even after resolution", () => {
		openTicket({ rootMessageId: "root-1" });
		expect(store.getAlertThreadByRootMessageId("root-1")?.event_id).toBe(
			"evt-1",
		);
		expect(store.getAlertThreadByRootMessageId("t-1")?.event_id).toBe("evt-1");
		store.resolveAlertThread("fw|lead-a|rate_limit|");
		expect(store.getAlertThreadByEventId("evt-1")?.resolved_at).toBeTruthy();
		expect(
			store.getAlertThreadByRootMessageId("root-1")?.resolved_at,
		).toBeTruthy();
	});

	it("getActiveAlertThreadByLeadAndType exact-matches the active row", () => {
		openTicket();
		expect(
			store.getActiveAlertThreadByLeadAndType("lead-a", "rate_limit")?.event_id,
		).toBe("evt-1");
		expect(
			store.getActiveAlertThreadByLeadAndType("lead-a", "usage_limit"),
		).toBeUndefined();
		store.resolveAlertThread("fw|lead-a|rate_limit|");
		expect(
			store.getActiveAlertThreadByLeadAndType("lead-a", "rate_limit"),
		).toBeUndefined();
	});
});
