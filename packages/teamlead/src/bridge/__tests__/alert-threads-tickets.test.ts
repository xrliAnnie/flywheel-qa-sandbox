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

	it("bumpTicketAttempt increments toward the T2 budget", () => {
		openTicket();
		store.bumpTicketAttempt("fw|lead-a|rate_limit|");
		store.bumpTicketAttempt("fw|lead-a|rate_limit|");
		expect(
			store.getActiveAlertThread("fw|lead-a|rate_limit|")?.attempt_count,
		).toBe(2);
	});

	it("getUnackedTicketsOlderThan: old NEW tickets match; ACKed / legacy rows never do", () => {
		openTicket(); // first_seen 2020 → definitely older than 5min
		store.openAlertThread({
			correlationKey: "legacy",
			eventId: "e2",
			threadId: "t2",
			channelId: "c",
			leadId: "lead-b",
			projectName: "fw",
			eventType: "crash_loop",
		});
		let stale = store.getUnackedTicketsOlderThan(5 * 60_000);
		expect(stale.map((r) => r.correlation_key)).toEqual([
			"fw|lead-a|rate_limit|",
		]);

		store.setTicketStatus("fw|lead-a|rate_limit|", "ACK");
		stale = store.getUnackedTicketsOlderThan(5 * 60_000);
		expect(stale).toEqual([]);
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
