import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { readCurrentGateMessageBinding } from "../approval-signal/gate-message-binding-store.js";
import { materializeWorkflowGateHolder } from "../gate-materializer.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("workflow gate materializer", () => {
	it("converges a deterministic question and one current founder card", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1375",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "a".repeat(40),
			sourceExecutionId: "qa-exec",
			questionId: "workflow-gate-run-1",
			now: "2026-07-21T20:00:00.000Z",
		});
		let posts = 0;
		let cardContent = "";
		const deps = {
			store,
			commDbPath: commPath,
			leadId: "flywheel-eng-lead",
			threadId: "discord-thread-1",
			postCard: async (input: { content: string }) => {
				posts += 1;
				cardContent = input.content;
				return { messageId: "discord-card-1" };
			},
			now: () => "2026-07-21T20:01:00.000Z",
		};

		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-run-1"),
		).toMatchObject({ ok: true, state: "awaiting_review" });
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-run-1"),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(posts).toBe(1);
		expect(cardContent).toContain(
			"Approval is recognized only from the founder's ✅ reaction on this card or an exact reply-to-card: approve / look good to me.",
		);
		expect(cardContent).toContain(
			"打回:请 reply-to 本卡回复「打回」,或用 design: / implement: / qa:",
		);
		expect(cardContent).toContain("也认全角冒号");
		expect(cardContent).toContain("thread 自由发言只转给 Lead");
		const comm = CommDB.openReadonly(commPath);
		try {
			expect(comm.getPendingQuestions("flywheel-eng-lead")).toMatchObject([
				{
					id: "workflow-gate-run-1",
					from_agent: "qa-exec",
					checkpoint: "approve_to_ship",
				},
			]);
		} finally {
			comm.close();
		}
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("workflow-gate-run-1"),
		).toMatchObject({
			state: "awaiting_review",
			materialization_stage: "completed",
			card_message_id: "discord-card-1",
		});
		expect(
			readCurrentGateMessageBinding(
				store,
				"qa-exec",
				"workflow-gate-run-1",
				"a".repeat(40),
			),
		).toMatchObject({
			threadId: "discord-thread-1",
			gateMessageId: "discord-card-1",
		});
		expect(
			store
				.getEventsByExecution("qa-exec")
				.filter((event) => event.event_type === "founder_thread_notified"),
		).toHaveLength(1);
		store.close();
	});

	it("reconciles a 2xx-without-id card instead of posting a duplicate", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-ambiguous-"));
		roots.push(root);
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-ambiguous",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-ambiguous",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "b".repeat(40),
			sourceExecutionId: "qa-ambiguous",
			questionId: "workflow-gate-ambiguous",
			now: "2026-08-17T00:00:00.000Z",
		});
		let currentNow = "2026-08-17T00:00:00.000Z";
		const postCard = vi.fn(async (input) => {
			expect(input.correlationMarker).toMatch(/^gate:[0-9a-f]{12}$/);
			return { kind: "posted_ambiguous" as const };
		});
		const scanCard = vi.fn(async (input) => {
			expect(input.legacyTerms).toEqual([]);
			return {
				kind: "found" as const,
				messageId: "discord-reconciled-1",
				frontier: "frontier-1",
				marker: input.correlationMarker,
			};
		});
		const deps = {
			store,
			commDbPath: join(root, "comm.db"),
			leadId: "flywheel-eng-lead",
			threadId: "discord-thread-1",
			postCard,
			scanCard,
			reconcileNotBeforeMs: 0,
			reconcileQuietIntervalMs: 0,
			now: () => currentNow,
		};

		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-ambiguous"),
		).toMatchObject({ ok: false, reason: "workflow_gate_card_post_ambiguous" });
		currentNow = "2026-08-17T00:00:01.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-ambiguous"),
		).toMatchObject({
			ok: true,
			cardMessageId: "discord-reconciled-1",
		});
		expect(postCard).toHaveBeenCalledTimes(1);
		expect(scanCard).toHaveBeenCalledTimes(1);
		expect(
			store
				.getEventsByExecution("qa-ambiguous")
				.filter((event) => event.event_type === "founder_thread_notified"),
		).toHaveLength(1);
		store.close();
	});

	it("restarts the quiet proof when the thread frontier moves", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-frontier-"));
		roots.push(root);
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-frontier",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-frontier",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "7".repeat(40),
			sourceExecutionId: "qa-frontier",
			questionId: "workflow-gate-frontier",
			now: "2026-08-17T00:00:00.000Z",
		});
		let currentNow = "2026-08-17T00:00:00.000Z";
		const postCard = vi
			.fn()
			.mockResolvedValueOnce({ kind: "posted_ambiguous" })
			.mockResolvedValueOnce({ kind: "posted", messageId: "card-after-churn" });
		const scanCard = vi
			.fn()
			.mockResolvedValueOnce({ kind: "none", frontier: "message-1" })
			.mockResolvedValueOnce({ kind: "none", frontier: "message-2" })
			.mockResolvedValueOnce({ kind: "none", frontier: "message-2" });
		const deps = {
			store,
			commDbPath: join(root, "comm.db"),
			leadId: "flywheel-eng-lead",
			threadId: "discord-thread-1",
			postCard,
			scanCard,
			reconcileNotBeforeMs: 0,
			reconcileQuietIntervalMs: 30_000,
			now: () => currentNow,
		};

		await materializeWorkflowGateHolder(deps, "workflow-gate-frontier");
		currentNow = "2026-08-17T00:00:01.000Z";
		await materializeWorkflowGateHolder(deps, "workflow-gate-frontier");
		currentNow = "2026-08-17T00:00:40.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-frontier"),
		).toMatchObject({
			ok: false,
			reason: "workflow_gate_card_zero_scan_unconfirmed",
		});
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("workflow-gate-frontier"),
		).toMatchObject({
			card_post_first_zero_at: "2026-08-17T00:00:40.000Z",
			card_post_first_zero_frontier: "message-2",
		});
		currentNow = "2026-08-17T00:01:11.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-frontier"),
		).toMatchObject({
			ok: false,
			reason: "workflow_gate_card_retry_authorized",
		});
		currentNow = "2026-08-17T00:01:12.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-frontier"),
		).toMatchObject({ ok: true, cardMessageId: "card-after-churn" });
		expect(postCard).toHaveBeenCalledTimes(2);
		expect(scanCard).toHaveBeenCalledTimes(3);
		store.close();
	});

	it("does not reclassify a post-cutover holder as legacy after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-cutover-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const first = await StateStore.create(dbPath);
		first.createWorkflowRun({
			runId: "run-cutover",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		first.ensureWorkflowGateHolder({
			runId: "run-cutover",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "8".repeat(40),
			sourceExecutionId: "qa-cutover",
			questionId: "workflow-gate-cutover",
			now: "2026-08-17T00:00:00.000Z",
		});
		first.close();

		const reopened = await StateStore.create(dbPath);
		expect(
			reopened.getCurrentWorkflowGateHolderByQuestionId(
				"workflow-gate-cutover",
			),
		).toMatchObject({ card_post_legacy_unknown: 0 });
		reopened.close();
	});

	it("authorizes a retry only after two complete quiet zero-match scans with an unchanged frontier", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-no-effect-"));
		roots.push(root);
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-no-effect",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-no-effect",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "c".repeat(40),
			sourceExecutionId: "qa-no-effect",
			questionId: "workflow-gate-no-effect",
			now: "2026-08-17T00:00:00.000Z",
		});
		let currentNow = "2026-08-17T00:00:00.000Z";
		const postCard = vi
			.fn()
			.mockResolvedValueOnce({ kind: "posted_ambiguous" })
			.mockResolvedValueOnce({ kind: "posted", messageId: "card-retry" });
		const scanCard = vi.fn(async () => ({
			kind: "none" as const,
			frontier: "stable-frontier",
		}));
		const deps = {
			store,
			commDbPath: join(root, "comm.db"),
			leadId: "flywheel-eng-lead",
			threadId: "discord-thread-1",
			postCard,
			scanCard,
			reconcileNotBeforeMs: 0,
			reconcileQuietIntervalMs: 0,
			now: () => currentNow,
		};

		await materializeWorkflowGateHolder(deps, "workflow-gate-no-effect");
		currentNow = "2026-08-17T00:00:01.000Z";
		await materializeWorkflowGateHolder(deps, "workflow-gate-no-effect");
		expect(postCard).toHaveBeenCalledTimes(1);
		currentNow = "2026-08-17T00:00:02.000Z";
		await materializeWorkflowGateHolder(deps, "workflow-gate-no-effect");
		expect(postCard).toHaveBeenCalledTimes(1);
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("workflow-gate-no-effect")
				?.updated_at,
		).toBe("2026-08-17T00:00:00.000Z");
		currentNow = "2026-08-17T00:00:03.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-no-effect"),
		).toMatchObject({ ok: true, cardMessageId: "card-retry" });
		expect(postCard).toHaveBeenCalledTimes(2);
		expect(scanCard).toHaveBeenCalledTimes(2);
		store.close();
	});

	it("reconciles a crash after Discord returns an id but before the holder advances", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-crash-"));
		roots.push(root);
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-crash",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-crash",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "d".repeat(40),
			sourceExecutionId: "qa-crash",
			questionId: "workflow-gate-crash",
			now: "2026-08-17T00:00:00.000Z",
		});
		let currentNow = "2026-08-17T00:00:00.000Z";
		const postCard = vi.fn(async () => ({
			kind: "posted" as const,
			messageId: "discord-crash-card",
		}));
		const scanCard = vi.fn(async () => ({
			kind: "found" as const,
			messageId: "discord-crash-card",
			frontier: "discord-crash-card",
		}));
		const originalAdvance =
			store.advanceWorkflowGateHolderMaterialization.bind(store);
		let crashOnce = true;
		store.advanceWorkflowGateHolderMaterialization = ((input) => {
			if (input.stage === "card_posted" && crashOnce) {
				crashOnce = false;
				throw new Error("simulated_crash_after_post");
			}
			return originalAdvance(input);
		}) as typeof store.advanceWorkflowGateHolderMaterialization;
		const deps = {
			store,
			commDbPath: join(root, "comm.db"),
			leadId: "flywheel-eng-lead",
			threadId: "discord-thread-1",
			postCard,
			scanCard,
			reconcileNotBeforeMs: 0,
			now: () => currentNow,
		};

		await expect(
			materializeWorkflowGateHolder(deps, "workflow-gate-crash"),
		).rejects.toThrow("simulated_crash_after_post");
		store.advanceWorkflowGateHolderMaterialization = originalAdvance;
		currentNow = "2026-08-17T00:00:01.000Z";
		expect(
			await materializeWorkflowGateHolder(deps, "workflow-gate-crash"),
		).toMatchObject({ ok: true, cardMessageId: "discord-crash-card" });
		expect(postCard).toHaveBeenCalledTimes(1);
		expect(scanCard).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("caps durable POST intents at three", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-budget",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-budget",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "e".repeat(40),
			sourceExecutionId: "qa-budget",
			questionId: "workflow-gate-budget",
			now: "2026-08-17T00:00:00.000Z",
		});
		for (let sequence = 1; sequence <= 3; sequence += 1) {
			const intent = store.claimWorkflowGateCardPostIntent({
				questionId: "workflow-gate-budget",
				correlationMarker: "gate:0123456789ab",
				now: `2026-08-17T00:00:0${sequence}.000Z`,
				reconcileNotBefore: `2026-08-17T00:00:0${sequence}.000Z`,
			});
			expect(intent).toMatchObject({ ok: true, created: true, sequence });
			expect(
				store.markWorkflowGateCardPostOutcome({
					questionId: "workflow-gate-budget",
					sequence,
					outcome: "no_effect",
				}),
			).toEqual({ ok: true });
		}
		expect(
			store.claimWorkflowGateCardPostIntent({
				questionId: "workflow-gate-budget",
				correlationMarker: "gate:0123456789ab",
				now: "2026-08-17T00:00:04.000Z",
				reconcileNotBefore: "2026-08-17T00:00:04.000Z",
			}),
		).toEqual({
			ok: false,
			reason: "workflow_gate_card_post_budget_exhausted",
		});
		store.close();
	});

	it("requeues a completed holder until its deterministic success audit is backfilled", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-gate-audit-"));
		roots.push(root);
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-audit",
			issueId: "FLY-1832",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "run-audit",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "f".repeat(40),
			sourceExecutionId: "qa-audit",
			questionId: "workflow-gate-audit",
			now: "2026-08-17T00:00:00.000Z",
		});
		for (const [stage, cardMessageId] of [
			["card_posted", "audit-card"],
			["card_bound", "audit-card"],
			["completed", undefined],
		] as const) {
			store.advanceWorkflowGateHolderMaterialization({
				questionId: "workflow-gate-audit",
				stage,
				...(cardMessageId ? { cardMessageId } : {}),
				now: "2026-08-17T00:00:01.000Z",
			});
		}
		expect(
			store
				.listWorkflowGateHoldersForMaterialization()
				.map((holder) => holder.question_id),
		).toContain("workflow-gate-audit");
		expect(
			await materializeWorkflowGateHolder(
				{
					store,
					commDbPath: join(root, "comm.db"),
					leadId: "flywheel-eng-lead",
					threadId: "discord-thread-1",
					postCard: vi.fn(async () => {
						throw new Error("must_not_post");
					}),
				},
				"workflow-gate-audit",
			),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(
			store
				.listWorkflowGateHoldersForMaterialization()
				.map((holder) => holder.question_id),
		).not.toContain("workflow-gate-audit");
		store.close();
	});
});
