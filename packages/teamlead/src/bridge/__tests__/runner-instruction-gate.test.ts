import { createHash } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { enqueueRunnerInstructionIfDeliverable } from "../runner-instruction-gate.js";

describe("runner instruction liveness gate", () => {
	let store: StateStore;
	let commDb: CommDB;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		commDb = new CommDB(":memory:");
	});
	afterEach(() => {
		commDb.close();
		store.close();
	});
	const input = {
		fromAgent: "bridge-land",
		executionId: "runner",
		content: "bounded cleanup",
		dedupeId: "cleanup:operation:runner",
		audit: {
			projectName: "flywheel",
			issueId: "issue-1",
			source: "bridge-land",
			reason: "land-cleanup:operation",
		},
	};
	it.each(["missing", "completed", "failed"])(
		"skips %s with durable scoped audit and no mailbox row",
		(status) => {
			if (status !== "missing")
				store.upsertSession({
					execution_id: "runner",
					issue_id: "issue-1",
					project_name: "flywheel",
					status,
				});
			const skipped = status === "missing" ? "missing" : "terminal";
			expect(
				enqueueRunnerInstructionIfDeliverable({ store, commDb }, input),
			).toEqual({ queued: false, skipped });
			expect(commDb.getUnreadInstructions("runner")).toEqual([]);
			expect(commDb.getMessageById(input.dedupeId)).toBeUndefined();
			expect(store.getEventsByExecution("runner")).toEqual([
				expect.objectContaining({
					event_id: "instruction_skipped:cleanup:operation:runner",
					event_type: `instruction_skipped_recipient_${skipped}`,
					issue_id: "issue-1",
					project_name: "flywheel",
					source: "bridge-land",
					payload: {
						fromAgent: "bridge-land",
						reason: "land-cleanup:operation",
						contentDigest: createHash("sha256")
							.update(input.content)
							.digest("hex")
							.slice(0, 16),
					},
				}),
			]);
		},
	);
	it.each(["running", "awaiting_review"])(
		"enqueues %s with original deterministic identity and replay dedupe",
		(status) => {
			store.upsertSession({
				execution_id: "runner",
				issue_id: "issue-1",
				project_name: "flywheel",
				status,
			});
			expect(
				enqueueRunnerInstructionIfDeliverable({ store, commDb }, input),
			).toMatchObject({ queued: true });
			enqueueRunnerInstructionIfDeliverable({ store, commDb }, input);
			expect(commDb.getUnreadInstructions("runner")).toEqual([
				expect.objectContaining({
					id: input.dedupeId,
					to_agent: "runner",
					content: input.content,
				}),
			]);
			expect(store.getEventsByExecution("runner")).toEqual([]);
		},
	);
	it("preserves explicit instruction ID and insertion boolean on replay", () => {
		store.upsertSession({
			execution_id: "runner",
			issue_id: "issue-1",
			project_name: "flywheel",
			status: "running",
		});
		const explicit = {
			...input,
			instructionId: "account-switch-wake:g1:runner",
		};
		expect(
			enqueueRunnerInstructionIfDeliverable({ store, commDb }, explicit),
		).toEqual({ queued: true, inserted: true });
		expect(
			enqueueRunnerInstructionIfDeliverable({ store, commDb }, explicit),
		).toEqual({ queued: true, inserted: false });
		expect(commDb.getUnreadInstructions("runner")[0]?.id).toBe(
			explicit.instructionId,
		);
	});
});
