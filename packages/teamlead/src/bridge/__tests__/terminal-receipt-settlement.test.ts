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

	it("keeps an unknown issue-authority lookup retryable", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ordinary runner message",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "receipt-unknown",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "retry after transient authority lookup failure",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		comm.close();
		const revalidate = vi
			.fn()
			.mockResolvedValueOnce("unknown" as const)
			.mockResolvedValue("authorized" as const);
		const projector = new TerminalReceiptSettlementProjector({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			now: () => 5_000,
		});
		const input = {
			projectName: "flywheel",
			canonicalIssueId: "issue-uuid",
			issueAliases: ["issue-uuid", "FLY-1448"],
			authorityCredential: "issue-uuid:2026-07-24T00:00:00.000Z",
			revalidate,
		};

		await projector.settleIssueDone(input);
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				authority_kind: "issue_done",
				state: "pending",
				claim_token: null,
				last_error: expect.stringContaining("authority_unknown"),
			},
		]);

		await projector.settleIssueDone(input);
		comm = new CommDB(commPath);
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{ authority_kind: "issue_done", state: "completed" },
		]);
		const check = new LeadInboxQueue(commPath);
		try {
			expect(check.getById("receipt-unknown")?.disposed_at).toBeTruthy();
		} finally {
			check.close();
		}
	});

	it("refuses to complete while an active legacy receipt detection has no CommDB root", async () => {
		store.upsertDetectionEscalation({
			targetKey: "flywheel:flywheel-eng-lead",
			kind: "receipt_unprocessed",
			episodeFingerprint: "missing-receipt-root",
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
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				state: "applying",
				last_error: expect.stringContaining(
					"unresolved legacy receipt detection",
				),
			},
		]);
		expect(
			store.getDetectionEscalation(
				"flywheel:flywheel-eng-lead",
				"receipt_unprocessed",
				"missing-receipt-root",
			),
		).toMatchObject({ status: "NEW", source_receipt_id: null });
		expect(store.listUndeliveredLeadEvents()).toEqual([
			expect.objectContaining({
				lead_id: "flywheel-eng-lead",
				event_type: "receipt_settlement_lineage_invalid",
				payload: expect.stringContaining("CommDB root missing"),
			}),
		]);
	});

	it("refuses a same-execution legacy receipt owned by a different Lead", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"lead-other",
			"wrong-lead receipt",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "wrong-lead-root",
				toLead: "lead-other",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "must not attach to the session owner's settlement",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		store.upsertDetectionEscalation({
			targetKey: "flywheel:lead-other",
			kind: "receipt_unprocessed",
			episodeFingerprint: "wrong-lead-root",
			issueId: "FLY-1448",
			ownerLeadId: "lead-other",
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
		}).pass();

		comm = new CommDB(commPath);
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				state: "applying",
				last_error: expect.stringContaining("Lead lineage mismatch"),
			},
		]);
		expect(
			store.getDetectionEscalation(
				"flywheel:lead-other",
				"receipt_unprocessed",
				"wrong-lead-root",
			),
		).toMatchObject({ status: "NEW", source_receipt_id: null });
		expect(store.listUndeliveredLeadEvents()).toEqual([
			expect.objectContaining({
				lead_id: "flywheel-eng-lead",
				event_type: "receipt_settlement_lineage_invalid",
				payload: expect.stringContaining("Lead lineage mismatch"),
			}),
		]);
	});

	it("refuses a root-matched legacy detection from a different issue", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"wrong-issue receipt",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "wrong-issue-root",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "must not attach across issues",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		store.upsertDetectionEscalation({
			targetKey: "flywheel:flywheel-eng-lead",
			kind: "receipt_unprocessed",
			episodeFingerprint: "wrong-issue-root",
			issueId: "FLY-OTHER",
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
		}).pass();

		comm = new CommDB(commPath);
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				state: "applying",
				last_error: expect.stringContaining("issue lineage mismatch"),
			},
		]);
		expect(
			store.getDetectionEscalation(
				"flywheel:flywheel-eng-lead",
				"receipt_unprocessed",
				"wrong-issue-root",
			),
		).toMatchObject({ status: "NEW", source_receipt_id: null });
		expect(store.listUndeliveredLeadEvents()).toEqual([
			expect.objectContaining({
				lead_id: "flywheel-eng-lead",
				event_type: "receipt_settlement_lineage_invalid",
				payload: expect.stringContaining("issue lineage mismatch"),
			}),
		]);
	});

	it("refuses cross-project legacy receipt lineage", async () => {
		comm.registerSession(
			"exec-other",
			"session",
			"other-project",
			"FLY-1448",
			"flywheel-eng-lead",
			"codex",
		);
		const sourceId = comm.insertQuestion(
			"exec-other",
			"flywheel-eng-lead",
			"foreign receipt",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "cross-project-root",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "must not attach across projects",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		store.upsertDetectionEscalation({
			targetKey: "flywheel:flywheel-eng-lead",
			kind: "receipt_unprocessed",
			episodeFingerprint: "cross-project-root",
			issueId: "FLY-1448",
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
		}).pass();

		comm = new CommDB(commPath);
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				state: "applying",
				last_error: expect.stringContaining("project lineage mismatch"),
			},
		]);
	});

	it("refuses ambiguous legacy detection rows for one receipt root", async () => {
		const sourceId = comm.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ambiguous receipt",
			{ checkpoint: "question" },
		);
		const queue = new LeadInboxQueue(commPath);
		try {
			queue.enqueue({
				id: "ambiguous-root",
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_report",
				msgClass: "protocol",
				content: "ambiguous legacy detection",
				refMessageId: sourceId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
		for (const kind of ["receipt_unprocessed", "receipt_unprocessed_retry"]) {
			store.upsertDetectionEscalation({
				targetKey: "flywheel:flywheel-eng-lead",
				kind,
				episodeFingerprint: "ambiguous-root",
				issueId: "FLY-1448",
				ownerLeadId: "flywheel-eng-lead",
				firstDetectedAtMs: 1_000,
			});
		}
		store.persistTransition("exec-1", "completed", {
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
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				state: "applying",
				last_error: expect.stringContaining(
					"ambiguous legacy receipt detection lineage",
				),
			},
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
