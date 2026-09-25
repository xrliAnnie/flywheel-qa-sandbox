import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateLeadInterruptInput } from "../bridge/lead-interrupt-store.js";
import { StateStore } from "../StateStore.js";

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

const NOW = "2026-09-25T20:00:00.000Z";

function input(
	overrides: Partial<CreateLeadInterruptInput> = {},
): CreateLeadInterruptInput {
	return {
		interruptId: "li_00000000-0000-4000-8000-000000000001",
		initiatorKind: "voice_session",
		initiatorRef: "voice-session-1",
		idempotencyKey: "idem-key-0001",
		requestDigest: "a".repeat(64),
		founderMessageId: "123456789012345678",
		targetProject: "flywheel",
		targetLeadId: "flywheel-eng-lead",
		targetBackend: "claude-code",
		body: "你现在在做什么?",
		bodyDigest: "b".repeat(64),
		now: NOW,
		...overrides,
	};
}

describe("FLY-2883 lead interrupt store", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("creates the row and its requested audit in one transaction", () => {
		const row = store.leadInterrupts.createRequested(input());
		expect(row).toMatchObject({
			interruptId: "li_00000000-0000-4000-8000-000000000001",
			deliveryId: "lead-interrupt:li_00000000-0000-4000-8000-000000000001",
			state: "requested",
			disposition: null,
			replyText: null,
		});
		const audit = store.leadInterrupts.listAudit(row.interruptId);
		expect(audit).toEqual([
			expect.objectContaining({
				event: "requested",
				initiatorKind: "voice_session",
				initiatorRef: "voice-session-1",
				founderMessageId: "123456789012345678",
				targetProject: "flywheel",
				targetLeadId: "flywheel-eng-lead",
				bodyDigest: "b".repeat(64),
				at: NOW,
			}),
		]);
		// The audit never carries the body itself.
		expect(JSON.stringify(audit)).not.toContain("你现在在做什么");
	});

	it("leaves no row behind when the audit insert is refused", () => {
		rawDb(
			store,
		).exec(`CREATE TRIGGER fail_lead_interrupt_audit BEFORE INSERT ON lead_interrupt_audit
			BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
		expect(() => store.leadInterrupts.createRequested(input())).toThrow(
			/audit down/,
		);
		expect(
			store.leadInterrupts.get("li_00000000-0000-4000-8000-000000000001"),
		).toBeUndefined();
	});

	it("keeps the audit append-only (UPDATE, DELETE, INSERT OR REPLACE)", () => {
		store.leadInterrupts.createRequested(input());
		expect(() =>
			rawDb(store).exec("UPDATE lead_interrupt_audit SET detail = 'x'"),
		).toThrow(/append-only/);
		expect(() => rawDb(store).exec("DELETE FROM lead_interrupt_audit")).toThrow(
			/append-only/,
		);
		expect(() =>
			rawDb(store).exec(
				`INSERT OR REPLACE INTO lead_interrupt_audit
				 (id, interrupt_id, event, initiator_kind, initiator_ref, at)
				 VALUES (1, 'x', 'requested', 'voice_session', 'r', '${NOW}')`,
			),
		).toThrow(/append-only/);
	});

	it("rejects a duplicate idempotency key for the same initiator", () => {
		store.leadInterrupts.createRequested(input());
		expect(() =>
			store.leadInterrupts.createRequested(
				input({ interruptId: "li_00000000-0000-4000-8000-000000000002" }),
			),
		).toThrow();
		expect(
			store.leadInterrupts.getByIdempotencyKey(
				"voice_session",
				"voice-session-1",
				"idem-key-0001",
			)?.interruptId,
		).toBe("li_00000000-0000-4000-8000-000000000001");
	});

	it("guards transitions by expected source state", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		expect(store.leadInterrupts.get(row.interruptId)?.state).toBe("queued");
		expect(() =>
			store.leadInterrupts.transition({
				interruptId: row.interruptId,
				from: ["requested"],
				to: "failed",
				event: "enqueue_failed",
				detail: "mailbox_threw",
				now: NOW,
			}),
		).toThrow(/lead_interrupt_state_conflict/);
		expect(store.leadInterrupts.get(row.interruptId)?.state).toBe("queued");
		expect(
			store.leadInterrupts.listAudit(row.interruptId).map((a) => a.event),
		).toEqual(["requested", "enqueued"]);
	});

	it("allows requested -> failed from an enqueue failure (R3#2 source 1)", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "failed",
			event: "enqueue_failed",
			detail: "mailbox_threw",
			now: NOW,
		});
		expect(store.leadInterrupts.get(row.interruptId)?.state).toBe("failed");
	});

	it("allows requested -> failed from an archived-DEAD reconciliation (R3#2 source 2)", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "failed",
			event: "enqueue_failed",
			detail: "letter_dead",
			now: NOW,
		});
		const audit = store.leadInterrupts.listAudit(row.interruptId);
		expect(audit.at(-1)).toMatchObject({
			event: "enqueue_failed",
			detail: "letter_dead",
		});
	});

	it("rolls back a transition when its audit cannot be written", () => {
		const row = store.leadInterrupts.createRequested(input());
		rawDb(
			store,
		).exec(`CREATE TRIGGER fail_lead_interrupt_audit BEFORE INSERT ON lead_interrupt_audit
			BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
		expect(() =>
			store.leadInterrupts.transition({
				interruptId: row.interruptId,
				from: ["requested"],
				to: "queued",
				event: "enqueued",
				now: NOW,
			}),
		).toThrow(/audit down/);
		expect(store.leadInterrupts.get(row.interruptId)?.state).toBe("requested");
	});

	it("records a reply from queued (Lead answered while the letter was held)", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		expect(
			store.leadInterrupts.recordReply({
				interruptId: row.interruptId,
				text: "在改投递循环,五分钟后好",
				replyDigest: "c".repeat(64),
				now: NOW,
			}),
		).toBe("replied");
		expect(store.leadInterrupts.get(row.interruptId)).toMatchObject({
			state: "replied",
			replyText: "在改投递循环,五分钟后好",
			replyDigest: "c".repeat(64),
			repliedAt: NOW,
		});
		expect(
			store.leadInterrupts.recordReply({
				interruptId: row.interruptId,
				text: "在改投递循环,五分钟后好",
				replyDigest: "c".repeat(64),
				now: NOW,
			}),
		).toBe("replayed");
		expect(
			store.leadInterrupts.recordReply({
				interruptId: row.interruptId,
				text: "别的",
				replyDigest: "d".repeat(64),
				now: NOW,
			}),
		).toBe("conflict");
		expect(
			store.leadInterrupts
				.listAudit(row.interruptId)
				.filter((a) => a.event === "replied"),
		).toHaveLength(1);
	});

	it("refuses a reply before the letter is in the mailbox", () => {
		const row = store.leadInterrupts.createRequested(input());
		expect(
			store.leadInterrupts.recordReply({
				interruptId: row.interruptId,
				text: "x",
				replyDigest: "c".repeat(64),
				now: NOW,
			}),
		).toBe("invalid_state");
		expect(
			store.leadInterrupts.recordReply({
				interruptId: "li_missing",
				text: "x",
				replyDigest: "c".repeat(64),
				now: NOW,
			}),
		).toBe("not_found");
	});

	it("records a disposition without downgrading a replied row (R2#6)", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		store.leadInterrupts.recordReply({
			interruptId: row.interruptId,
			text: "ok",
			replyDigest: "c".repeat(64),
			now: NOW,
		});
		expect(
			store.leadInterrupts.recordDisposition({
				interruptId: row.interruptId,
				disposition: "steered",
				reason: null,
				event: "steered",
				now: NOW,
			}),
		).toBe("recorded");
		expect(store.leadInterrupts.get(row.interruptId)).toMatchObject({
			state: "replied",
			disposition: "steered",
		});
		// Same disposition replays idempotently; a different one is refused.
		expect(
			store.leadInterrupts.recordDisposition({
				interruptId: row.interruptId,
				disposition: "steered",
				reason: null,
				event: "steered",
				now: NOW,
			}),
		).toBe("replayed");
		expect(
			store.leadInterrupts.recordDisposition({
				interruptId: row.interruptId,
				disposition: "mailbox_only",
				reason: "lead_idle",
				event: "mailbox_only",
				now: NOW,
			}),
		).toBe("conflict");
		expect(store.leadInterrupts.get(row.interruptId)?.disposition).toBe(
			"steered",
		);
	});

	it("moves queued -> delivered when a disposition is recorded", () => {
		const row = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: row.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		store.leadInterrupts.recordDisposition({
			interruptId: row.interruptId,
			disposition: "nudged",
			reason: null,
			event: "nudged",
			now: NOW,
		});
		expect(store.leadInterrupts.get(row.interruptId)).toMatchObject({
			state: "delivered",
			disposition: "nudged",
		});
		expect(store.leadInterrupts.hasAuditEvent(row.interruptId, "nudged")).toBe(
			true,
		);
	});

	it("lists only queued/delivered interrupts addressed to the Lead", () => {
		const a = store.leadInterrupts.createRequested(input());
		store.leadInterrupts.transition({
			interruptId: a.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		store.leadInterrupts.createRequested(
			input({
				interruptId: "li_00000000-0000-4000-8000-000000000002",
				idempotencyKey: "idem-key-0002",
			}),
		);
		const other = store.leadInterrupts.createRequested(
			input({
				interruptId: "li_00000000-0000-4000-8000-000000000003",
				idempotencyKey: "idem-key-0003",
				targetLeadId: "other-lead",
			}),
		);
		store.leadInterrupts.transition({
			interruptId: other.interruptId,
			from: ["requested"],
			to: "queued",
			event: "enqueued",
			now: NOW,
		});
		expect(
			store.leadInterrupts
				.listPendingForLead("flywheel", "flywheel-eng-lead")
				.map((r) => r.interruptId),
		).toEqual([a.interruptId]);
	});

	it("counts open and recent interrupts for rate limiting", () => {
		store.leadInterrupts.createRequested(input());
		store.leadInterrupts.createRequested(
			input({
				interruptId: "li_00000000-0000-4000-8000-000000000002",
				idempotencyKey: "idem-key-0002",
				targetLeadId: "other-lead",
				now: "2026-09-25T19:00:00.000Z",
			}),
		);
		expect(
			store.leadInterrupts.countOpenForTarget({
				initiatorKind: "voice_session",
				initiatorRef: "voice-session-1",
				targetProject: "flywheel",
				targetLeadId: "flywheel-eng-lead",
				since: "2026-09-25T19:30:00.000Z",
			}),
		).toBe(1);
		expect(
			store.leadInterrupts.countOpenForTarget({
				initiatorKind: "voice_session",
				initiatorRef: "voice-session-1",
				targetProject: "flywheel",
				targetLeadId: "other-lead",
				since: "2026-09-25T19:30:00.000Z",
			}),
		).toBe(0);
		expect(
			store.leadInterrupts.countRecentForInitiator({
				initiatorKind: "voice_session",
				initiatorRef: "voice-session-1",
				since: "2026-09-25T18:00:00.000Z",
			}),
		).toBe(2);
	});

	it("appends a standalone audit event for a refused request", () => {
		store.leadInterrupts.appendAudit({
			interruptId: "li_refused",
			event: "refused",
			initiatorKind: "voice_session",
			initiatorRef: "voice-session-1",
			founderMessageId: "123456789012345678",
			targetProject: "flywheel",
			targetLeadId: "flywheel-eng-lead",
			bodyDigest: null,
			detail: "target_not_lead",
			now: NOW,
		});
		expect(store.leadInterrupts.listAudit("li_refused")).toEqual([
			expect.objectContaining({ event: "refused", detail: "target_not_lead" }),
		]);
	});
});
