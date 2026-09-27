import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, expect, it, vi } from "vitest";
import {
	buildLeadAuditSummaryOffer,
	formatLeadAuditSummary,
} from "../lead-audit-summary.js";

const now = "2026-09-26T06:00:00.000Z";
const roots: string[] = [],
	queues: MailboxQueue[] = [];
const snapshot = {
	generation: "b7d44c90-cd46-4932-8600-6dfec78e273b",
	startSeq: 0,
	startEventId: null,
	recovered: false,
	fromSeq: 0,
	throughSeq: 12,
	anchorEventId: "event-12",
	total: 12,
	counts: { stage_changed: 12 },
	representatives: Array.from({ length: 8 }, (_, i) => ({
		seq: i,
		event_id: `event-${i}`,
		event_type: "stage_changed",
		payload: JSON.stringify({
			execution_id: `exact-exec-${i}`,
			stage: "test",
			title: "<script>&😀".repeat(30),
		}),
	})),
};
function setup() {
	const root = mkdtempSync(join(tmpdir(), "fly2912-offer-"));
	roots.push(root);
	const queue = new MailboxQueue(join(root, "comm.db"));
	queues.push(queue);
	queue.acquireOrRenewOwner({ ownerEpoch: "owner", now, leaseTtlMs: 60000 });
	queue.enqueue({
		id: "q",
		fromAgent: "runner",
		toAgent: "lead",
		recipientKind: "lead",
		type: "question",
		content: "real question",
		createdAt: now,
		senderRef: encodeSenderRef(),
	});
	queue.claimLeadBatchQueue({
		toAgent: "lead",
		msgClass: "model",
		ownerEpoch: "owner",
		batchId: "batch",
		now,
		transportClaimTtlMs: 30000,
		batchWindowMs: 0,
		batchMaxSize: 5,
		inflightMaxBatches: 3,
	});
	const store = {
		getFlagValueRow: vi.fn(() => ({ hasOverride: true, raw: "1" })),
		getNotificationAuditGeneration: vi.fn(() => snapshot),
		readLeadAuditSummary: vi.fn(() => snapshot),
	};
	return {
		store,
		queue,
		projectName: "p",
		leadId: "lead",
		ownerEpoch: "owner",
		batchId: "batch",
		transportBatchId: "batch#r0",
		memberIds: ["q#r0"],
		canBuildSummary: true,
		now,
	};
}
afterEach(() => {
	for (const q of queues.splice(0)) q.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
it("limits escaped text by code points, preserves exact IDs and true omitted count", () => {
	const result = formatLeadAuditSummary(snapshot, {
		projectName: "p",
		leadId: "lead",
	});
	expect([...result].length).toBeLessThanOrEqual(2000);
	expect(result).not.toContain("<script>");
	expect(result).toContain("&lt;script&gt;&amp;");
	expect(result).toContain("total=12");
	expect(result).toContain("omittedCount=");
	expect(result).toContain("exact-exec-0");
	expect(result).toContain("afterSeq=0&throughSeq=12&storeEpoch=");
	const displayed = Number(result.match(/representatives=(\d+)/)![1]);
	expect(result).toContain(`omittedCount=${12 - displayed}`);
	expect(displayed).toBeLessThanOrEqual(8);
});
it("freezes bytes before delivery and reuses them even after OFF or source failure", () => {
	const input = setup();
	const first = buildLeadAuditSummaryOffer(input);
	expect(first?.content).toContain("只读账目概览");
	input.store.getFlagValueRow.mockReturnValue({ hasOverride: true, raw: "0" });
	input.store.readLeadAuditSummary.mockImplementation(() => {
		throw Error("unavailable");
	});
	expect(buildLeadAuditSummaryOffer(input)).toEqual(first);
	expect(input.store.readLeadAuditSummary).toHaveBeenCalledTimes(1);
});
it("OFF freezes empty and keeps those bytes after enabling without source reads", () => {
	const input = setup();
	input.store.getFlagValueRow.mockReturnValue({ hasOverride: true, raw: "0" });
	const empty = buildLeadAuditSummaryOffer(input);
	expect(empty?.content).toBe("");
	expect(input.queue.getLeadAuditSummaryOffer(input)?.content).toBe("");
	input.store.getFlagValueRow.mockReturnValue({ hasOverride: true, raw: "1" });
	expect(buildLeadAuditSummaryOffer(input)).toEqual(empty);
	expect(input.store.getNotificationAuditGeneration).not.toHaveBeenCalled();
	expect(input.store.readLeadAuditSummary).not.toHaveBeenCalled();
});
it("never creates new summary bytes for a resumed transport without an offer", () => {
	const input = { ...setup(), canBuildSummary: false };
	expect(buildLeadAuditSummaryOffer(input)?.content).toBe("");
	expect(input.store.getNotificationAuditGeneration).not.toHaveBeenCalled();
	expect(input.store.readLeadAuditSummary).not.toHaveBeenCalled();
});
it("source failure freezes empty without coverage", () => {
	const input = setup();
	input.store.readLeadAuditSummary.mockImplementation(() => {
		throw Error("bad archive");
	});
	const empty = buildLeadAuditSummaryOffer(input);
	expect(empty?.content).toBe("");
	expect(input.queue.getLeadAuditSummaryOffer(input)?.acceptedAt).toBeNull();
	input.store.readLeadAuditSummary.mockReturnValue(snapshot);
	expect(buildLeadAuditSummaryOffer(input)).toEqual(empty);
});
it("cannot create an attachment without a current real batch and owner", () => {
	const input = setup();
	expect(() =>
		buildLeadAuditSummaryOffer({ ...input, ownerEpoch: "stale" }),
	).toThrow();
	expect(() =>
		buildLeadAuditSummaryOffer({
			...input,
			batchId: "absent",
			transportBatchId: "absent#r0",
		}),
	).toThrow();
});
