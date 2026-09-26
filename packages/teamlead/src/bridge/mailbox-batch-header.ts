/**
 * The Bridge-authored header that opens every Lead mailbox batch payload.
 * Shared by the delivery loop that writes it and the Codex router that reads
 * the sender back (FLY-2862), so the two cannot drift.
 */
export function formatMailboxBatchHeader(args: {
	batchId: string;
	count: number;
	fromAgent: string | undefined;
	ackInstruction?: string | undefined;
}): string {
	return `[mailbox-batch ${args.batchId} | ${args.count} messages | from ${args.fromAgent}]\nYou must ack this batch with ${args.ackInstruction ?? "flywheel_inbox_ack_batch or lead_actions.ack_batch"} promptly so the sender can see you received it; unacked batches are redelivered and eventually dead-lettered.`;
}

const HEADER =
	/^\[mailbox-batch [^\s|\]]+ \| \d+ messages \| from ([^\]\n]+)\]/;

/** The sender named by a mailbox batch payload's header, if it opens with one. */
export function mailboxBatchSender(payload: string): string | undefined {
	return HEADER.exec(payload)?.[1];
}
