import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
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
			"Approval is recognized only from the founder's ✅ reaction on this card or the founder's direct reply in this card's thread.",
		);
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
		store.close();
	});
});
