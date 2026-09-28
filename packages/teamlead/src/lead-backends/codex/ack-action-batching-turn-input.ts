/**
 * FLY-2909 — the Codex carrier's copy of the governed ACK/action batching rule.
 *
 * A windowed Codex Lead's app-server daemon, and the thread loaded in it,
 * outlive a sidecar restart. `thread/resume` on a still-loaded thread ignores
 * new `baseInstructions`, so the rule bundle a launch selects can never reach
 * the model while the daemon lives (529 QA @2f4d4a5e: the thread kept the old
 * "process every message, then acknowledge" rule and split ACK from action).
 * The sidecar therefore restates the timing beside each mailbox batch turn.
 * Only the model input changes; the durable journal payload keeps the Bridge's
 * bytes, and a false or absent launch receipt keeps the input byte-identical.
 */
import { mailboxBatchSender } from "../../bridge/mailbox-batch-header.js";

export const CODEX_ACK_ACTION_BATCHING_DIRECTIVE = `[ACK timing · lead_ack_action_batching]
Decide how every message in this mailbox batch is handled. Then call
\`ack_batch\` from \`lead_actions\` with this header's batch_id in the same
model step as the first handling action: as a parallel tool call, or inside
the same \`exec\` script that performs that action (for example with
\`Promise.all\`). Do not wait for that action's result first, and do not spend
a later step on the ACK alone. Status-only input: pair the ACK with this
turn's final tool action when one exists. If the ACK is the only action the
batch needs (status-only, already handled, or redelivered), call it alone
right away; never skip it. Never ACK before handling begins, and do not delay
urgent founder input to collect batches. The ACK is transport only, not a
reply, completion, approval, or ship authority. This timing overrides any
older "process every message, then acknowledge" wording in your rules or the
\`ack_batch\` tool description.`;

/** Model input for one mailbox batch turn under this launch's receipt. */
export function codexMailboxTurnInput(
	payload: string,
	ackActionBatchingEnabled: boolean | undefined,
): string {
	if (ackActionBatchingEnabled !== true || !mailboxBatchSender(payload))
		return payload;
	return `${payload}\n\n${CODEX_ACK_ACTION_BATCHING_DIRECTIVE}`;
}
