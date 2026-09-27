import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-09-25T12:00:00.000Z";
const decision = {
	policyVersion: "alert-wake-dedup-v1",
	reason: "alert_equivalent_delivered",
	proofRef: "alert-dedup:lead-a:0123456789abcdef:delivered-alert",
	decidedAt: NOW,
};
const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(MAILBOX_SCHEMA);
	const queue = new MailboxQueue(db);
	queue.acquireOrRenewOwner({
		ownerEpoch: "owner",
		now: NOW,
		leaseTtlMs: 60_000,
	});
	queue.enqueue({
		id: "alert",
		deliveryId: "alert-delivery",
		fromAgent: "bridge",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "regular",
		sourceKind: "infra_alert",
		content: "original alert",
		createdAt: NOW,
		senderRef: encodeSenderRef(),
	});
	expect(
		queue.claimLeadBatch({
			toAgent: "lead-a",
			msgClass: "model",
			ownerEpoch: "owner",
			batchId: "batch",
			now: NOW,
			claimTtlMs: 60_000,
		}),
	).toHaveLength(1);
	return { db, queue };
}

describe("FLY-2910 mailbox alert wake decisions", () => {
	it("settles a claimed alert as ACKED audit-only with an atomic audit record", () => {
		const { db, queue } = fixture();
		db.prepare(
			"UPDATE mailbox SET next_retry_at = ?, last_error = ? WHERE id = ?",
		).run(NOW, "previous transport failure", "alert");
		expect(
			queue.settleClaimAsAudit({
				id: "alert",
				ownerEpoch: "owner",
				batchId: "batch",
				decision,
			}),
		).toBe(true);
		expect(queue.getById("alert")).toMatchObject({
			state: "ACKED",
			acked_at: NOW,
			resolved_via: "alert_wake_dedup",
			delivery_disposition: "audit_only",
			notification_policy_version: decision.policyVersion,
			notification_reason: decision.reason,
			notification_proof_ref: decision.proofRef,
			notification_decided_at: NOW,
			claimed_by: null,
			claim_expires_at: null,
			batch_id: null,
			next_retry_at: null,
			last_error: null,
			delivered_at: null,
			notified_at: null,
		});
		const log = db
			.prepare("SELECT * FROM mailbox_log WHERE event_id = ?")
			.get("notification-audit:alert-delivery:alert-wake-dedup-v1") as {
			row_json: string;
		};
		expect(log).toMatchObject({
			message_id: "alert",
			subject_id: "alert",
			event: "processed",
			at: NOW,
		});
		expect(JSON.parse(log.row_json)).toMatchObject({
			deliveryId: "alert-delivery",
			disposition: "audit_only",
			policyVersion: decision.policyVersion,
			reason: decision.reason,
			proofRef: decision.proofRef,
		});
		expect(queue.countDeliverable("lead-a")).toBe(0);
		expect(
			queue.settleClaimAsAudit({
				id: "alert",
				ownerEpoch: "owner",
				batchId: "batch",
				decision,
			}),
		).toBe(false);
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM mailbox_log").get(),
		).toEqual({ count: 1 });
	});

	it("rolls back settlement when the audit insert fails", () => {
		const { db, queue } = fixture();
		db.exec(
			"CREATE TRIGGER reject_audit BEFORE INSERT ON mailbox_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
		);
		const before = queue.getById("alert");
		expect(() =>
			queue.settleClaimAsAudit({
				id: "alert",
				ownerEpoch: "owner",
				batchId: "batch",
				decision,
			}),
		).toThrow("audit unavailable");
		expect(queue.getById("alert")).toEqual(before);
	});

	it("archives the settled row through the existing ACKED retention path", () => {
		const { db, queue } = fixture();
		expect(
			queue.settleClaimAsAudit({
				id: "alert",
				ownerEpoch: "owner",
				batchId: "batch",
				decision,
			}),
		).toBe(true);
		expect(
			queue.archiveDueFamilies({ now: "2026-09-28T11:59:59.999Z" }),
		).toMatchObject({ archivedMessages: 0 });
		expect(
			queue.archiveDueFamilies({ now: "2026-09-28T12:00:00.000Z" }),
		).toMatchObject({ archivedFamilies: 1, archivedMessages: 1 });
		expect(queue.getById("alert")).toBeUndefined();
		const archived = db
			.prepare(
				"SELECT row_json FROM mailbox_log WHERE event_id = 'archived:alert'",
			)
			.get() as { row_json: string };
		expect(JSON.parse(archived.row_json)).toMatchObject({
			state: "ACKED",
			delivery_disposition: "audit_only",
			resolved_via: "alert_wake_dedup",
		});
	});

	it("annotates only delivery content while preserving the original envelope and claim", () => {
		const { queue } = fixture();
		const before = queue.getById("alert");
		const deliveryContent =
			"[告警摘要] 2 条已合并\noriginal alert\n[告警合并] 第 3 次";
		expect(
			queue.annotateLeadDelivery({
				id: "alert",
				ownerEpoch: "owner",
				batchId: "batch",
				deliveryContent,
			}),
		).toBe(true);
		expect(queue.getById("alert")).toEqual({
			...before,
			delivery_content: deliveryContent,
		});
	});

	for (const method of [
		"settleClaimAsAudit",
		"annotateLeadDelivery",
	] as const) {
		it.each([
			["state", "QUEUED"],
			["state", "ACKED"],
			["state", "DEAD"],
			["claimed_by", "stale-owner"],
			["batch_id", "other-batch"],
			["recipient_kind", "runner"],
			["msg_class", "protocol"],
			["delivery_disposition", "audit_only"],
			["delivered_at", NOW],
			["notified_at", NOW],
		])(`${method} rejects %s=%s without mutations`, (column, value) => {
			const { db, queue } = fixture();
			db.prepare(`UPDATE mailbox SET ${column} = ? WHERE id = 'alert'`).run(
				value,
			);
			const before = queue.getById("alert");
			expect(
				queue[method]({
					id: "alert",
					ownerEpoch: "owner",
					batchId: "batch",
					decision,
					deliveryContent: "annotated",
				}),
			).toBe(false);
			expect(queue.getById("alert")).toEqual(before);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM mailbox_log").get(),
			).toEqual({ count: 0 });
		});

		it(`${method} rejects a missing row`, () => {
			const { queue } = fixture();
			expect(
				queue[method]({
					id: "missing",
					ownerEpoch: "owner",
					batchId: "batch",
					decision,
					deliveryContent: "annotated",
				}),
			).toBe(false);
		});
	}
});
