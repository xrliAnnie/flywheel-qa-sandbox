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

	it("thread handoff metadata is episode-fenced and reset by replacement", () => {
		openTicket();
		const first = store.handoffLedger(
			"thread",
			"fw|lead-a|rate_limit|",
			"evt-1",
			{
				ownerRef: "lead:flywheel-eng-lead",
				reason: "contact_book",
				deliveryIdPrefix: "alert_handoff:thread:ck:evt-1:lead",
			},
		);
		expect(first).toEqual(
			expect.objectContaining({
				handoff_reason: "contact_book",
				handoff_delivery_id: "alert_handoff:thread:ck:evt-1:lead:g1",
				handoff_generation: 1,
				resolve_draft_id: null,
			}),
		);

		openTicket({ eventId: "evt-2", threadId: "t-2" });
		expect(store.getActiveAlertThread("fw|lead-a|rate_limit|")).toEqual(
			expect.objectContaining({
				event_id: "evt-2",
				handoff_reason: null,
				handoff_delivery_id: null,
				handoff_generation: 0,
				resolve_draft_id: null,
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

describe("FLY-2386 mailbox alert ledger", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	const ledgerInput = (over: Record<string, unknown> = {}) => ({
		correlationKey: "fw|flywheel-eng-lead|bridge_abnormal_exit|",
		eventId: "evt-mailbox-1",
		deliveryId: "infra_alert:evt-mailbox-1",
		toAgent: "claude-infra-bot-lead",
		requestedOwner: "flywheel-eng-lead",
		routeClass: "duty_reroute" as const,
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		eventType: "bridge_abnormal_exit",
		sessionKey: null,
		...over,
	});

	it("opens a duty-routed mailbox episode that is retrievable by event id", () => {
		expect(
			store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false }),
		).toMatchObject({
			disposition: "inserted",
			deliveryProjection: {
				deliveryId: "infra_alert:evt-mailbox-1",
				toAgent: "claude-infra-bot-lead",
			},
		});

		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")).toEqual(
			expect.objectContaining({
				correlation_key: "fw|flywheel-eng-lead|bridge_abnormal_exit|",
				ticket_status: "NEW",
				owner_ref: "infra_bot:claude",
				fire_count: 1,
				acked_at: null,
				resolved_at: null,
			}),
		);
	});

	it("replays the same event and delivery projection without replacing it", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		expect(
			store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false }),
		).toMatchObject({
			disposition: "replayed_same",
			deliveryProjection: {
				eventId: "evt-mailbox-1",
				deliveryId: "infra_alert:evt-mailbox-1",
				toAgent: "claude-infra-bot-lead",
			},
		});
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")?.fire_count).toBe(
			1,
		);
	});

	it("keeps the canonical delivery when same-event reclassification is not authorized", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		const result = store.upsertAlertMailboxLedger(
			ledgerInput({
				deliveryId: "infra_alert:fallback",
				toAgent: "flywheel-eng-lead",
				routeClass: "duty_fallback",
			}),
			{ allowReseed: false },
		);

		expect(result).toMatchObject({
			disposition: "locked_canonical",
			deliveryProjection: {
				deliveryId: "infra_alert:evt-mailbox-1",
				toAgent: "claude-infra-bot-lead",
				routeClass: "duty_reroute",
			},
		});
	});

	it("reseeds a pristine same-event delivery after mailbox absence is proven", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		const result = store.upsertAlertMailboxLedger(
			ledgerInput({
				deliveryId: "infra_alert:fallback",
				toAgent: "flywheel-eng-lead",
				routeClass: "duty_fallback",
			}),
			{ allowReseed: true },
		);

		expect(result.disposition).toBe("reseeded");
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")).toEqual(
			expect.objectContaining({
				delivery_id: "infra_alert:fallback",
				to_agent: "flywheel-eng-lead",
				route_class: "duty_fallback",
				ticket_status: "ESCALATED",
				owner_ref: "lead:flywheel-eng-lead",
				handoff_reason: "duty_fallback",
				handoff_delivery_id: "infra_alert:fallback",
				acked_at: expect.any(String),
			}),
		);
	});

	it("locks a same-event delivery after duty has acknowledged it", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		expect(
			store.stampMailboxLedgerAck(
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
			),
		).toBe(true);
		expect(
			store.stampMailboxLedgerAck(
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"stale-event",
			),
		).toBe(false);

		const result = store.upsertAlertMailboxLedger(
			ledgerInput({
				deliveryId: "infra_alert:fallback",
				toAgent: "flywheel-eng-lead",
				routeClass: "duty_fallback",
			}),
			{ allowReseed: true },
		);
		expect(result.disposition).toBe("locked_canonical");
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")?.acked_at).toEqual(
			expect.any(String),
		);
	});

	it("merges a later fire into an unresolved same-route episode but returns the incoming delivery", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		const result = store.upsertAlertMailboxLedger(
			ledgerInput({
				eventId: "evt-mailbox-2",
				deliveryId: "infra_alert:evt-mailbox-2",
			}),
			{ allowReseed: false },
		);

		expect(result).toEqual({
			disposition: "merged",
			deliveryProjection: {
				eventId: "evt-mailbox-2",
				deliveryId: "infra_alert:evt-mailbox-2",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
			},
		});
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")?.fire_count).toBe(
			2,
		);
		expect(store.getMailboxLedgerByEventId("evt-mailbox-2")).toBeUndefined();
	});

	it("starts a clean episode when a later event changes delivery route", () => {
		store.upsertAlertMailboxLedger(
			ledgerInput({
				toAgent: "flywheel-eng-lead",
				routeClass: "direct_owner",
			}),
			{ allowReseed: false },
		);
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")).toEqual(
			expect.objectContaining({
				ticket_status: "ESCALATED",
				handoff_reason: "direct_owner",
				acked_at: expect.any(String),
			}),
		);

		expect(
			store.upsertAlertMailboxLedger(
				ledgerInput({
					eventId: "evt-mailbox-2",
					deliveryId: "infra_alert:evt-mailbox-2",
					routeClass: "duty",
					requestedOwner: "claude-infra-bot-lead",
				}),
				{ allowReseed: false },
			),
		).toMatchObject({ disposition: "new_episode" });
		expect(store.getMailboxLedgerByEventId("evt-mailbox-2")).toEqual(
			expect.objectContaining({
				fire_count: 1,
				ticket_status: "NEW",
				owner_ref: "infra_bot:claude",
				handoff_reason: null,
				handoff_delivery_id: null,
				handoff_generation: 0,
				resolve_draft_id: null,
				acked_at: null,
				resolved_at: null,
			}),
		);
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")).toBeUndefined();
	});

	it("hands off an exact mailbox episode with a fresh SQL generation each time", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		const handoff = {
			ownerRef: "lead:flywheel-eng-lead",
			reason: "no_entry" as const,
			deliveryIdPrefix:
				"alert_handoff:mailbox:fw|flywheel-eng-lead|bridge_abnormal_exit|:evt-mailbox-1:flywheel-eng-lead",
		};

		const first = store.handoffLedger(
			"mailbox",
			"fw|flywheel-eng-lead|bridge_abnormal_exit|",
			"evt-mailbox-1",
			handoff,
		);
		const second = store.handoffLedger(
			"mailbox",
			"fw|flywheel-eng-lead|bridge_abnormal_exit|",
			"evt-mailbox-1",
			handoff,
		);

		expect(first).toEqual(
			expect.objectContaining({
				handoff_generation: 1,
				handoff_delivery_id: `${handoff.deliveryIdPrefix}:g1`,
			}),
		);
		expect(second).toEqual(
			expect.objectContaining({
				handoff_generation: 2,
				handoff_delivery_id: `${handoff.deliveryIdPrefix}:g2`,
				ticket_status: "ESCALATED",
				owner_ref: "lead:flywheel-eng-lead",
				handoff_reason: "no_entry",
				acked_at: expect.any(String),
			}),
		);
		expect(
			store.handoffLedger(
				"mailbox",
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"stale-event",
				handoff,
			),
		).toBeUndefined();
	});

	it("binds one runbook draft before resolving an exact mailbox episode", () => {
		store.upsertAlertMailboxLedger(ledgerInput(), { allowReseed: false });
		expect(
			store.resolveMailboxLedger(
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
				"runbook--bridge--draft-a",
			),
		).toBe(false);

		expect(
			store.bindResolveDraft(
				"mailbox",
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
				"runbook--bridge--draft-a",
			),
		).toMatchObject({ ok: true });
		expect(
			store.bindResolveDraft(
				"mailbox",
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
				"runbook--bridge--draft-a",
			),
		).toMatchObject({ ok: true });
		expect(
			store.bindResolveDraft(
				"mailbox",
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
				"runbook--bridge--draft-b",
			),
		).toEqual({ ok: false, reason: "draft_conflict" });
		expect(
			store.bindResolveDraft(
				"mailbox",
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"stale-event",
				"runbook--bridge--draft-a",
			),
		).toEqual({ ok: false, reason: "stale_episode" });

		expect(
			store.resolveMailboxLedger(
				"fw|flywheel-eng-lead|bridge_abnormal_exit|",
				"evt-mailbox-1",
				"runbook--bridge--draft-a",
			),
		).toBe(true);
		expect(store.getMailboxLedgerByEventId("evt-mailbox-1")).toEqual(
			expect.objectContaining({
				ticket_status: "RESOLVED",
				resolve_draft_id: "runbook--bridge--draft-a",
				resolved_at: expect.any(String),
			}),
		);
	});

	it("lists only unacknowledged mailbox episodes in bounded cursor order", () => {
		for (const event of ["evt-1", "evt-2", "evt-3"]) {
			store.upsertAlertMailboxLedger(
				ledgerInput({
					correlationKey: `fw|lead|kind|${event}`,
					eventId: event,
					deliveryId: `infra_alert:${event}`,
				}),
				{ allowReseed: false },
			);
		}
		store.stampMailboxLedgerAck("fw|lead|kind|evt-1", "evt-1");

		const first = store.listMailboxLedgerOutstanding(2);
		expect(first.map((row) => row.event_id)).toEqual(["evt-3", "evt-2"]);
		expect(
			store
				.listMailboxLedgerOutstanding(2, first[1])
				.map((row) => row.event_id),
		).toEqual(["evt-3"]);
	});

	it("keeps the same correlation key visible in both board lanes", () => {
		store.openAlertThread({
			correlationKey: "shared-key",
			eventId: "evt-thread",
			threadId: "thread-1",
			channelId: "channel-1",
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventType: "bridge_abnormal_exit",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		store.resolveAlertThread("shared-key", "evt-thread");
		store.upsertAlertMailboxLedger(
			ledgerInput({ correlationKey: "shared-key", eventId: "evt-mailbox" }),
			{ allowReseed: false },
		);
		store.handoffLedger("mailbox", "shared-key", "evt-mailbox", {
			ownerRef: "lead:flywheel-eng-lead",
			reason: "contact_book",
			deliveryIdPrefix: "alert_handoff:mailbox:shared-key:evt-mailbox:lead",
		});

		const board = store.listAlertBoard({
			resolvedSinceIso: "2000-01-01T00:00:00.000Z",
			limit: 10,
		});
		expect(board.items).toEqual([
			expect.objectContaining({ lane: "mailbox", event_id: "evt-mailbox" }),
			expect.objectContaining({ lane: "thread", event_id: "evt-thread" }),
		]);
		expect(board.totals).toEqual({
			unreviewed: 0,
			in_duty: 0,
			handed_off: 1,
			resolved_in_window: 1,
		});
		expect(board.nextCursor).toBeNull();
	});
});
