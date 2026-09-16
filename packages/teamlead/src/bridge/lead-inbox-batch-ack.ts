import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { executeLeadBridgeWrite } from "./lead-capability-write.js";

type Options = Parameters<typeof executeLeadBridgeWrite>[0];
/** Bridge receives its project-owned queue; the parent never opens mailbox or StateStore. */
export function executeLeadInboxBatchAck(
	options: Omit<
		Options,
		| "operationId"
		| "providerPrefix"
		| "resultIdentity"
		| "effect"
		| "input"
		| "authorize"
		| "sideEffectsPossible"
	> & {
		input: { batchId: string };
		queue: Pick<MailboxQueue, "ackBatchByRecipient">;
	},
) {
	let attempted = false;
	return executeLeadBridgeWrite({
		...options,
		operationId: "inbox.batch.ack",
		providerPrefix: "inbox-batch",
		resultIdentity: { batchId: options.input.batchId },
		authorize: options.assertCurrent,
		sideEffectsPossible: () => attempted,
		effect: async () => {
			await options.assertCurrent();
			options.signal.throwIfAborted();
			attempted = true;
			let outcome: ReturnType<MailboxQueue["ackBatchByRecipient"]>;
			try {
				outcome = options.queue.ackBatchByRecipient({
					batchId: options.input.batchId,
					fromAgent: options.leadId,
					now: new Date().toISOString(),
				});
			} catch (error) {
				// The queue checks this before its first write in the transaction.
				if (
					error instanceof Error &&
					error.message === "mailbox batch recipient mismatch"
				)
					attempted = false;
				throw error;
			}
			// A retired/absent batch has no ACK evidence for this operation.
			if (outcome !== "applied" && outcome !== "duplicate")
				throw new Error("inbox_batch_ack_unproven");
		},
	});
}
