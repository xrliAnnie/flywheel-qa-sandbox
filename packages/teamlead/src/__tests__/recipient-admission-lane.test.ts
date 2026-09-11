import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { describe, expect, it } from "vitest";
import { createTestLeadIdentityEnvs } from "../../../flywheel-comm/src/__tests__/helpers/lead-identity-env.js";
import { send } from "../../../flywheel-comm/src/commands/send.js";
import { CommDB } from "../../../flywheel-comm/src/db.js";
import { RunnerMailboxLane } from "../bridge/runner-mailbox-lane.js";
import { StateStore } from "../StateStore.js";

describe("CLI and runner lane share StateStore liveness authority", () => {
	it.each([
		{
			comm: "completed",
			state: "awaiting_review",
			unavailable: false,
			expected: "LEASED",
		},
		{
			comm: "running",
			state: "completed",
			unavailable: false,
			expected: "DEAD",
		},
		{
			comm: "running",
			state: "completed",
			unavailable: true,
			expected: "DEAD",
		},
	] as const)(
		"CommDB $comm / StateStore $state / unavailable=$unavailable",
		async ({ comm, state, unavailable, expected }) => {
			const root = mkdtempSync(join(tmpdir(), "fly1942-lane-"));
			const dbPath = join(root, "comm.db");
			const statePath = join(root, "teamlead.db");
			const id = "abcdef01-2345-6789-abcd-0123456789ab";
			const store = await StateStore.create(statePath);
			const db = new CommDB(dbPath);
			let queue: MailboxQueue | undefined;
			try {
				store.upsertSession({
					execution_id: id,
					issue_id: "FLY-1942",
					project_name: "flywheel",
					status: state,
				});
				db.registerSession(
					id,
					"s:w",
					"flywheel",
					"FLY-1942",
					"flywheel-eng-lead",
					"codex",
				);
				if (comm === "completed") db.updateSessionStatus(id, "completed");
				const env = {
					...createTestLeadIdentityEnvs(root, ["flywheel-eng-lead"])[
						"flywheel-eng-lead"
					],
					TEAMLEAD_DB_PATH: unavailable ? join(root, "absent.db") : statePath,
				};
				const args = {
					fromAgent: "flywheel-eng-lead",
					toAgent: id,
					content: "continue",
					dbPath,
					env,
				};
				let messageId: string;
				if (state === "completed" && !unavailable) {
					await expect(send(args)).rejects.toThrow(/recipient_terminal/);
					expect(db.getUnreadInstructions(id)).toEqual([]);
					messageId = "bypass-admission";
					db.insertInstructionWithId(
						messageId,
						args.fromAgent,
						id,
						args.content,
					);
				} else {
					messageId = await send(args);
				}
				queue = new MailboxQueue(dbPath);
				const now = new Date();
				queue.acquireOrRenewOwner({
					ownerEpoch: "test-owner",
					now: now.toISOString(),
					leaseTtlMs: 60_000,
				});
				const lane = new RunnerMailboxLane({
					queue,
					ownerEpoch: "test-owner",
					now: () => now,
					recipientState: (executionId) =>
						store.resolveRunnerRecipientState(executionId).state,
					deliver: async () => ({
						status: "delivered",
						backend: "codex",
						settlement: "on_consume",
					}),
				});
				await lane.tick();
				expect(queue.getById(messageId)?.state).toBe(expected);
				if (expected === "DEAD")
					expect(queue.getById(messageId)?.dead_reason).toBe(
						"recipient_terminal",
					);
			} finally {
				queue?.close();
				db.close();
				store.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
