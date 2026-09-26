import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue, type MailboxRow } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	AlertWakeDedup,
	decideAlertWake,
	parseAlertWake,
} from "../alert-wake-dedup.js";
import type { LeadDeliveryBatch } from "../lead-delivery-adapter.js";
import { LeadInboxLoop } from "../lead-inbox-loop.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../mailbox-queue-config.js";

const now = Date.parse("2026-09-25T12:00:00.000Z");
function letter(overrides: Partial<MailboxRow> = {}): MailboxRow {
	return {
		id: "a",
		delivery_id: "a",
		recipient_kind: "lead",
		to_agent: "lead-a",
		source_kind: "infra_alert",
		source_ref: "event-a",
		type: "regular",
		content:
			"[infra_alert] Cross-family review job failed\nReview request-1 for FLY-2910: please retry\nevent=review_job_failed severity=warning project=flywheel owner=lead-a session=session-a",
		...overrides,
	} as MailboxRow;
}
function parse(row = letter()) {
	return parseAlertWake(row, "lead-a", "456");
}
function ticket(text: string, extra = {}): MailboxRow {
	const envelope = {
		v: 1,
		leadId: "lead-a",
		authorId: "456",
		messageId: "123",
		authorName: "Dispatcher",
		chatId: "789",
		originChannelId: "789",
		ts: "2026-09-25T12:00:00.000Z",
		priority: 1,
		msgKind: "guild",
		attachments: [],
		text,
		...extra,
	};
	return letter({
		source_kind: "discord_chat",
		type: "discord_chat",
		content: `[discord-chat-receipt v1] ${JSON.stringify({ ...envelope, deliveryId: `chat:${envelope.leadId}:${envelope.messageId}` })}`,
	});
}

describe("alert wake recognition and equivalence", () => {
	it("recognizes infra alerts and preserves request, issue and session identity", () => {
		const first = parse()!;
		expect(first).toMatchObject({
			kind: "review_job_failed",
			title: "Cross-family review job failed",
			severity: "warning",
			carrier: "infra_alert",
		});
		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		for (const [from, to] of [
			["request-1", "request-2"],
			["FLY-2910", "FLY-2911"],
			["session-a", "session-b"],
			["please retry", "please approve"],
		]) {
			expect(
				parse(letter({ content: letter().content.replace(from, to) }))!
					.fingerprint,
			).not.toBe(first.fingerprint);
		}
	});
	it("folds only ISO timestamps and cmux ages, retaining other numbers", () => {
		const row = letter({
			content:
				"[infra_alert] cmux watcher unhealthy (stalled)\npid=123 heartbeat_age_ms=100 event_age_ms=200 at=2026-09-25T12:00:00Z\nevent=cmux_watcher_stalled severity=severe project=flywheel affected=lead-a",
		});
		expect(
			parse(
				letter({
					...row,
					content: row.content
						.replace("age_ms=100", "age_ms=999")
						.replace("12:00:00Z", "13:00:00Z"),
				}),
			)!.fingerprint,
		).toBe(parse(row)!.fingerprint);
		expect(
			parse(
				letter({ ...row, content: row.content.replace("pid=123", "pid=124") }),
			)!.fingerprint,
		).not.toBe(parse(row)!.fingerprint);
	});
	it("normalizes category labels without merging changed counts or issue ids", () => {
		const base =
			"[infra_alert] FLY-2910 backlog (12)\nobjects: session-a\nevent=backlog severity=warning";
		const a = parse(letter({ content: base }))!;
		for (const value of ["13", "24"]) {
			const b = parse(
				letter({
					content: base.replace("12", value).replace("FLY-2910", "FLY-2911"),
				}),
			)!;
			expect(b.categoryKey).toBe(a.categoryKey);
			expect(b.fingerprint).not.toBe(a.fingerprint);
		}
	});
	it("requires full-list producer proof for truncated zombie bodies", () => {
		const row = letter({
			content:
				"[infra_alert] zombie backlog (12)\n仅列前 3 个 session-a\nevent=zombie_session_backlog severity=warning",
			source_ref: "zombie-backlog:0123456789abcdef:123",
		});
		const a = parse(row)!;
		expect(a.fingerprint).not.toBeNull();
		expect(
			parse(
				letter({
					...row,
					content: row.content.replace("session-a", "session-b"),
				}),
			)!.fingerprint,
		).toBe(a.fingerprint);
		expect(
			parse(letter({ ...row, source_ref: "unknown" }))!.fingerprint,
		).toBeNull();
		expect(
			parse(
				letter({ ...row, source_ref: "zombie-backlog:1111111111111111:123" }),
			)!.fingerprint,
		).not.toBe(a.fingerprint);
	});
	it("authenticates dispatcher tickets and leaves other messages untouched", () => {
		const text =
			"⚠️ **Review failed** (lead-a / review_job_failed)\n🎫 flywheel · 首见 12:00 · owner x · 状态 NEW\nrequest-1 retry";
		expect(parse(ticket(text))).toMatchObject({
			carrier: "discord_chat",
			messageId: "123",
			kind: "review_job_failed",
		});
		const ingress = ticket(text);
		expect(
			parse({
				...ingress,
				content: `${ingress.content.replace("[discord-chat-receipt v1]", "[discord-chat-delivery v1]")}\nDispatcher: ${text}`,
			})?.fingerprint,
		).toBe(parse(ingress)!.fingerprint);
		expect(parse(ticket(text.replace("12:00", "13:00")))!.fingerprint).toBe(
			parse(ticket(text))!.fingerprint,
		);
		for (const row of [
			ticket(text, {
				authorId: "founder",
				authorName: "flywheel-alerts-dispatcher",
			}),
			ticket(text, { leadId: "lead-b" }),
			ticket("plain text"),
			letter({ content: "[alert_handoff] x" }),
			letter({ source_kind: "lead_event" }),
			letter({ source_kind: "question", type: "question" }),
			letter({ recipient_kind: "runner" }),
			letter({ content: letter().content.replace("warning", "bogus") }),
		])
			expect(parse(row)).toBeNull();
		expect(parseAlertWake(ticket(text), "lead-a", null)).toBeNull();
	});
	it("recognizes the notifier's exact automatic marker before its optional mention", () => {
		const text =
			"⚠️ **Review failed** (lead-a / review_job_failed)\nrequest-1 retry";
		for (const prefix of ["🤖[自动] ", "🤖[自动] <@1138241636057481306> "]) {
			expect(parse(ticket(prefix + text))?.fingerprint).toBe(
				parse(ticket(text))!.fingerprint,
			);
		}
		expect(parse(ticket(`unknown prefix ${text}`))).toBeNull();
	});
});

describe("alert wake decision", () => {
	const alert = () => parse()!;
	const record = {
		windowStartedAt: new Date(now).toISOString(),
		maxSeverity: 1,
		ticketGeneration: "generation-a",
	};
	function decide(overrides = {}) {
		return decideAlertWake({
			alert: alert(),
			record,
			ticketGeneration: "generation-a",
			now,
			...overrides,
		});
	}
	it("suppresses only delivered equivalents in the same fixed six-hour window", () => {
		expect(decide()).toEqual({
			action: "suppress",
			reason: "alert_equivalent_delivered",
		});
		expect(decide({ record: undefined })).toMatchObject({
			action: "wake",
			reason: "no_delivered_equivalent",
		});
		expect(decide({ now: now + 6 * 3600000 })).toMatchObject({
			action: "suppress",
		});
		expect(decide({ now: now + 6 * 3600000 + 1 })).toMatchObject({
			action: "wake",
			reason: "window_expired",
		});
	});
	it("wakes on severity, generation, or unknown identity", () => {
		expect(decide({ alert: { ...alert(), severity: "severe" } })).toMatchObject(
			{ action: "wake", reason: "severity_up" },
		);
		expect(decide({ ticketGeneration: "generation-b" })).toMatchObject({
			action: "wake",
			reason: "new_ticket_generation",
		});
		expect(decide({ ticketGeneration: null })).toMatchObject({
			action: "wake",
			reason: "unprovable",
		});
		expect(decide({ alert: { ...alert(), fingerprint: null } })).toMatchObject({
			action: "wake",
			reason: "unprovable",
		});
	});
	it("digests info while preserving actionable flag handoffs", () => {
		expect(
			decide({
				alert: { ...alert(), severity: "info", kind: "review_advisory_pass" },
			}),
		).toMatchObject({ action: "digest" });
		expect(
			decide({
				alert: { ...alert(), severity: "info", kind: "flag_scan_handoff" },
				record: undefined,
			}),
		).toMatchObject({ action: "wake" });
	});
});

describe("alert wake durable policy", () => {
	let store: StateStore;
	let policy: AlertWakeDedup;
	let clock = now;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		clock = now;
		policy = new AlertWakeDedup({
			store,
			dispatcherUserId: () => "456",
			isEnabled: () => true,
			now: () => new Date(clock),
		});
	});
	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});
	function mapped(
		id: string,
		extra: Partial<MailboxRow> = {},
		generation = "generation-a",
	) {
		store.recordAlertWakeLetter({
			deliveryId: id,
			correlationKey: "correlation-a",
			canonicalEventId: generation,
			recordedAt: new Date(clock).toISOString(),
		});
		return letter({ id, delivery_id: id, batch_id: `batch-${id}`, ...extra });
	}
	const decision = (row: MailboxRow, leadId = "lead-a") =>
		policy.revalidate(row, leadId, "flywheel");
	const delivered = (row: MailboxRow, leadId = "lead-a") =>
		policy.recordDelivered(row, leadId, "flywheel");
	it.each(["infra_alert", "discord_chat"] as const)(
		"preserves unacked %s redelivery through ACK-lease exhaustion",
		async (carrier) => {
			const root = mkdtempSync(join(tmpdir(), "fly2910-ack-lease-"));
			const queue = new MailboxQueue(join(root, "comm.db"));
			try {
				const row =
					carrier === "infra_alert"
						? mapped("unacked")
						: ticket(
								"⚠️ **Review failed** (lead-a / review_job_failed)\nrequest-1 retry",
							);
				if (carrier === "discord_chat") {
					store.openAlertThread({
						correlationKey: "lease-thread",
						eventId: "generation-a",
						threadId: "thread-a",
						rootMessageId: "123",
						channelId: "789",
						leadId: "lead-a",
						projectName: "flywheel",
						eventType: "review_job_failed",
					});
				}
				// Materialize a real digest on the first delivery; retries must retain it unchanged.
				decision(
					letter({
						content: "[infra_alert] Notice\nFYI\nevent=notice severity=info",
					}),
				);
				queue.enqueue({
					id: row.delivery_id,
					fromAgent: "bridge",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: row.type,
					sourceKind: row.source_kind,
					sourceRef: row.source_ref,
					content: row.content,
					createdAt: new Date(clock).toISOString(),
					senderRef: encodeSenderRef(),
				});
				const deliverBatch = vi.fn(async (batch: LeadDeliveryBatch) => ({
					batchId: batch.batchId,
					memberIds: batch.members.map((member) => member.deliveryId),
					status: "accepted_new" as const,
				}));
				let batchNumber = 0;
				const consumer = new LeadInboxLoop({
					queue,
					leadId: "lead-a",
					ownerEpoch: "lease-owner",
					adapter: { deliverBatch },
					hasLiveSession: () => true,
					recipientState: () => "alive",
					handleProtocol: async () => ({ disposition: "done" }),
					now: () => new Date(clock),
					batchIdFactory: () => `lease-batch-${++batchNumber}`,
					queueConfig: () => ({
						...DEFAULT_MAILBOX_QUEUE_CONFIG,
						batchWindowMs: 0,
					}),
					revalidateModel: async (member) =>
						decision(member) ?? { deliver: true },
					markAuditDelivered: (member) => delivered(member),
				});
				expect(await consumer.tick()).toMatchObject({
					ok: true,
					modelConsumed: 1,
				});
				const firstContent = queue.getById(row.delivery_id)!.delivery_content;
				expect(firstContent).toContain("[告警摘要]");
				for (
					let attempt = 1;
					attempt <= DEFAULT_MAILBOX_QUEUE_CONFIG.leaseRetryMax;
					attempt++
				) {
					clock += DEFAULT_MAILBOX_QUEUE_CONFIG.ackLeaseMs + 60_000;
					expect(await consumer.tick()).toMatchObject({
						ok: true,
						modelConsumed: 1,
					});
					expect(queue.getById(row.delivery_id)).toMatchObject({
						state: "LEASED",
						delivery_disposition: "model",
						acked_at: null,
						lease_retry_count: attempt,
						retry_count: 0,
						delivery_content: firstContent,
					});
					expect(
						store.getAlertWakeDedupRecord("lead-a", parse(row)!.fingerprint!),
					).toMatchObject({
						occurrences: 1,
						suppressed: 0,
						digestPending: 0,
					});
				}
				clock += DEFAULT_MAILBOX_QUEUE_CONFIG.ackLeaseMs + 60_000;
				expect(await consumer.tick()).toMatchObject({
					ok: true,
					modelConsumed: 0,
				});
				expect(deliverBatch).toHaveBeenCalledTimes(
					1 + DEFAULT_MAILBOX_QUEUE_CONFIG.leaseRetryMax,
				);
				expect(queue.getById(row.delivery_id)).toMatchObject({
					state: "DEAD",
					dead_reason: "lease_expired_unacked",
					acked_at: null,
					delivery_disposition: "model",
				});
			} finally {
				queue.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("counts equivalent repeats only after receipt and exposes a digest on the next alert", () => {
		const a = mapped("a");
		expect(decision(a)).toMatchObject({ deliver: true });
		const b = mapped("b");
		expect(decision(b)).toMatchObject({ deliver: true });
		expect(
			store.getAlertWakeDedupRecord("lead-a", parse(a)!.fingerprint!),
		).toBeUndefined();
		delivered(a);
		const c = mapped("c");
		expect(decision(c)).toMatchObject({
			deliver: false,
			disposition: "audit_only",
			settle: "acked",
			auditDecision: {
				policyVersion: "alert-wake-dedup-v1",
				reason: "alert_equivalent_delivered",
				proofRef: expect.stringContaining(":a"),
			},
		});
		expect(
			store.getAlertWakeDedupRecord("lead-a", parse(a)!.fingerprint!),
		).toMatchObject({ occurrences: 2, suppressed: 1, digestPending: 1 });
		const changed = mapped("changed", {
			content: a.content.replace("request-1", "request-2"),
		});
		expect(decision(changed)).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("[告警摘要]"),
		});
		expect(store.takeAlertWakeDigest("lead-a", 10).total).toBe(0);
	});
	it("keeps different Lead and kind evidence separate", () => {
		const a = mapped("a");
		delivered(a);
		expect(
			decision(mapped("b", { to_agent: "lead-b" }), "lead-b"),
		).toMatchObject({ deliver: true });
		expect(
			decision(
				mapped("c", {
					content: a.content.replace("event=review_job_failed", "event=other"),
				}),
			),
		).toMatchObject({ deliver: true });
	});
	it.each([
		["request-1", "request-2"],
		["session-a", "session-b"],
		["FLY-2910", "FLY-2911"],
		["please retry", "please approve"],
		["severity=warning", "severity=severe"],
	])("annotates changed %s with the inclusive category count", (from, to) => {
		const a = mapped("a");
		delivered(a);
		expect(
			decision(mapped("b", { content: a.content.replace(from, to) })),
		).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("第 2 次，其中 0 次"),
		});
	});
	it("counts earlier wake candidates in the same batch without treating them as delivery evidence", () => {
		const a = mapped("a", { batch_id: "same-batch" });
		const b = mapped("b", { batch_id: "same-batch" });
		expect(decision(a)).toMatchObject({ deliver: true });
		expect(decision(b)).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("第 2 次"),
		});
	});
	it.each([13, 24])(
		"wakes and annotates a title quantity changing from 12 to %s",
		(count) => {
			const content =
				"[infra_alert] zombie backlog (12)\nobjects: session-a\nevent=backlog severity=warning";
			delivered(mapped("twelve", { content }));
			expect(
				decision(
					mapped("changed-count", {
						content: content.replace("(12)", `(${count})`),
					}),
				),
			).toMatchObject({
				deliver: true,
				deliveryContent: expect.stringContaining("第 2 次，其中 0 次"),
			});
		},
	);
	it("digests info without generation evidence but preserves the actionable exception", () => {
		const content =
			"[infra_alert] Review passed\nadvisory only\nevent=review_advisory_pass severity=info";
		expect(decision(letter({ content }))).toMatchObject({
			deliver: false,
			settle: "acked",
			auditDecision: { reason: "alert_info_digest" },
		});
		expect(
			decision(
				letter({
					content: content.replace("review_advisory_pass", "flag_scan_handoff"),
				}),
			),
		).toMatchObject({ deliver: true });
	});
	it("attaches at most ten digest entries once per batch and never to founder messages", () => {
		for (let i = 0; i < 12; i++)
			decision(
				letter({
					id: `info-${i}`,
					content: `[infra_alert] Notice\nFYI\nevent=notice_${String.fromCharCode(97 + i)} severity=info`,
				}),
			);
		expect(decision(letter({ source_kind: "question" }))).toBeNull();
		const a = decision(mapped("a", { batch_id: "batch" }))!;
		expect(a).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("有 12 条告警"),
		});
		if (a.deliver) expect(a.deliveryContent?.match(/^- ×/gm)).toHaveLength(10);
		decision(
			letter({
				content: "[infra_alert] Another info\nFYI\nevent=another severity=info",
				batch_id: "batch",
			}),
		);
		const b = decision(mapped("b", { batch_id: "batch" }))!;
		if (b.deliver) expect(b.deliveryContent).not.toContain("[告警摘要]");
		expect(store.takeAlertWakeDigest("lead-a", 10).total).toBe(1);
	});
	it("fails open on missing mappings and keeps severity tied to the delivered generation", () => {
		const a = mapped("a", {
			content: letter().content.replace("warning", "severe"),
		});
		delivered(a);
		expect(
			decision(letter({ id: "missing", delivery_id: "missing" })),
		).toMatchObject({ deliver: true });
		const b = mapped("b", {}, "generation-b");
		expect(decision(b)).toMatchObject({ deliver: true });
		delivered(b);
		expect(
			decision(mapped("c", { content: a.content }, "generation-b")),
		).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("级别升高"),
		});
		clock += 6 * 3600000 + 1;
		expect(decision(mapped("expired", {}, "generation-b"))).toMatchObject({
			deliver: true,
		});
	});
	it("keeps switch-off read-free, and still records confirmed deliveries for enabling later", () => {
		const a = mapped("a");
		const read = vi.spyOn(store, "getAlertWakeDedupRecord");
		for (const isEnabled of [
			() => false,
			() => {
				throw new Error("unavailable");
			},
		]) {
			read.mockClear();
			const off = new AlertWakeDedup({
				store,
				dispatcherUserId: () => null,
				isEnabled,
				now: () => new Date(clock),
			});
			expect(off.revalidate(a, "lead-a", "flywheel")).toBeNull();
			expect(read).not.toHaveBeenCalled();
			off.recordDelivered(a, "lead-a", "flywheel");
		}
		expect(decision(mapped("b"))).toMatchObject({ deliver: false });
	});
	it("lets evidence write failures preserve delivery and future waking", () => {
		const a = mapped("a");
		vi.spyOn(store, "recordAlertWakeDelivered").mockImplementation(() => {
			throw new Error("disk failure");
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => delivered(a)).not.toThrow();
		expect(decision(mapped("b"))).toMatchObject({ deliver: true });
	});

	it("requires the actual dispatcher root mapping and wakes a reopened B episode", () => {
		const text =
			"⚠️ **Review failed** (lead-a / review_job_failed)\nrequest-1 retry";
		const a = ticket(text);
		expect(decision(a)).toMatchObject({ deliver: true });
		delivered(a);
		expect(
			store.getAlertWakeDedupRecord("lead-a", parse(a)!.fingerprint!),
		).toBeUndefined();
		const open = (eventId: string) =>
			store.openAlertThread({
				correlationKey: "thread-key",
				eventId,
				threadId: "thread-a",
				rootMessageId: "123",
				channelId: "channel-a",
				leadId: "lead-a",
				projectName: "flywheel",
				eventType: "review_job_failed",
			});
		open("episode-a");
		delivered(a);
		const b = { ...a, id: "b", delivery_id: "b", batch_id: "batch-b" };
		expect(decision(b)).toMatchObject({ deliver: false, settle: "acked" });
		expect(
			decision({ ...b, content: b.content.replaceAll("123", "124") }),
		).toMatchObject({ deliver: true });
		open("episode-b");
		expect(decision(b)).toMatchObject({
			deliver: true,
			deliveryContent: expect.stringContaining("工单重开"),
		});
	});
});
