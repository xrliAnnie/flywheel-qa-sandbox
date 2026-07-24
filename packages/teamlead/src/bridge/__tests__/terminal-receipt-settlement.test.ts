import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { TerminalReceiptSettlementProjector } from "../terminal-receipt-settlement.js";

describe("FLY-1448 terminal receipt settlement projector", () => {
	let dir: string;
	let commPath: string;
	let store: StateStore;
	let comm: CommDB;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1448-settlement-projector-"));
		commPath = join(dir, "comm.db");
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1448",
			project_name: "flywheel",
			status: "running",
		});
		comm = new CommDB(commPath);
		comm.registerSession(
			"exec-1",
			"session",
			"flywheel",
			"FLY-1448",
			"flywheel-eng-lead",
			"codex",
		);
	});

	afterEach(() => {
		comm.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("settles a pending gate, receipt family, and legacy detection lineage", async () => {
		const questionId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ship?",
			{ checkpoint: "approve_to_ship" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "receipt-root",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_question",
				msgClass: "protocol",
				content: "ship approval pending",
				refMessageId: questionId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		store.upsertDetectionEscalation({
			targetKey: "flywheel:flywheel-eng-lead",
			kind: "receipt_unprocessed",
			episodeFingerprint: "receipt-root",
			issueId: "FLY-1448",
			ownerLeadId: "flywheel-eng-lead",
			firstDetectedAtMs: 1_000,
		});
		store.persistTransition("exec-1", "completed", {
			issue_id: "FLY-1448",
			project_name: "flywheel",
		});
		comm.close();

		await new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			now: () => 5_000,
		}).pass();

		comm = new CommDB(commPath);
		expect(comm.getPendingGatesByRunner("exec-1")).toEqual([]);
		const check = new LeadInboxQueue(commPath);
		try {
			expect(check.getById("receipt-root")?.disposed_at).toBeTruthy();
		} finally {
			check.close();
		}
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{ state: "completed" },
		]);
		expect(
			store.getDetectionEscalation(
				"flywheel:flywheel-eng-lead",
				"receipt_unprocessed",
				"receipt-root",
			),
		).toMatchObject({
			status: "RESOLVED",
			source_receipt_id: "receipt-root",
			source_execution_id: "exec-1",
			source_question_id: questionId,
		});
	});

	it("resumes an applying intent after the session revives", async () => {
		store.persistTransition("exec-1", "completed", {
			issue_id: "FLY-1448",
			project_name: "flywheel",
		});
		const intent = store.listReceiptSettlementIntents()[0]!;
		store.claimTerminalSettlementIntent(
			intent.intent_id,
			intent.terminal_lifecycle_id!,
		);
		store.persistTransition("exec-1", "awaiting_review", {
			issue_id: "FLY-1448",
			project_name: "flywheel",
		});
		comm.close();

		await new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).pass();

		comm = new CommDB(commPath);
		expect(store.getReceiptSettlementIntent(intent.intent_id)?.state).toBe(
			"completed",
		);
	});

	it("settles a non-gate receipt for a running session under fresh issue-Done authority", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ordinary runner message",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "receipt-no-gate",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "ordinary receipt debt",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		comm.close();
		const revalidate = vi.fn(async () => "authorized" as const);

		await new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			now: () => 5_000,
		}).settleIssueDone({
			projectName: "flywheel",
			canonicalIssueId: "issue-uuid",
			issueAliases: ["issue-uuid", "FLY-1448"],
			authorityCredential: "issue-uuid:2026-07-24T00:00:00.000Z",
			revalidate,
		});

		comm = new CommDB(commPath);
		const check = new LeadInboxQueue(commPath);
		try {
			expect(check.getById("receipt-no-gate")?.disposed_evidence).toContain(
				"issue_done",
			);
		} finally {
			check.close();
		}
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{ authority_kind: "issue_done", state: "completed" },
		]);
		expect(revalidate).toHaveBeenCalled();
	});

	it("leaves a running session receipt untouched when the issue reopens before mutation", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ordinary runner message",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "receipt-reopened",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "must survive reopen",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		comm.close();

		await new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).settleIssueDone({
			projectName: "flywheel",
			canonicalIssueId: "issue-uuid",
			issueAliases: ["issue-uuid", "FLY-1448"],
			authorityCredential: "issue-uuid:2026-07-24T00:00:00.000Z",
			revalidate: async () => "reopened",
		});

		comm = new CommDB(commPath);
		const check = new LeadInboxQueue(commPath);
		try {
			expect(check.getById("receipt-reopened")?.disposed_at).toBeNull();
		} finally {
			check.close();
		}
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{ authority_kind: "issue_done", state: "fenced" },
		]);
	});

	it("uses PR-merged authority to retire the exact ship gate family", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1448",
			project_name: "flywheel",
			status: "running",
			pr_number: 1448,
		});
		const questionId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ship?",
			{ checkpoint: "approve_to_ship" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "receipt-merged",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_question",
				msgClass: "protocol",
				content: "ship receipt",
				refMessageId: questionId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		comm.close();

		await new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			now: () => 5_000,
		}).settlePrMerged({
			projectName: "flywheel",
			canonicalIssueId: "FLY-1448",
			issueAliases: ["FLY-1448"],
			prNumber: 1448,
			authorityCredential: "flywheel:1448:merge-oid",
			revalidate: async () => "authorized",
		});

		comm = new CommDB(commPath);
		expect(comm.getPendingGatesByRunner("exec-1")).toEqual([]);
		const check = new LeadInboxQueue(commPath);
		try {
			expect(check.getById("receipt-merged")?.disposed_evidence).toContain(
				"superseded_merged",
			);
		} finally {
			check.close();
		}
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{ authority_kind: "pr_merged", state: "completed" },
		]);
	});
});
