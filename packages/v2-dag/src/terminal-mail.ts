import { FENCE, type WriteTx } from "flywheel-v2-kernel";
import { appendEvent } from "./events.js";

/**
 * FLY-1543 ⑤: one terminalization helper for every path that retires a runner
 * session (completion, reap, resume, rework, lost-open adoption).
 *
 * A session-addressed recipient dies with its activation, so mail still pending
 * for it is a treadmill: redelivery can never succeed. Each such row is settled
 * to `dead` with a typed event, and its running processing attempt (if any) is
 * crash-settled so `pa_one_running` releases the message. Writing this in one
 * place keeps the five entry points from drifting.
 */
export function terminalizeSessionMailboxTx(
	tx: WriteTx,
	input: {
		sessionRef: string;
		cutoverEpoch: number;
		nowIso: string;
	},
): number {
	const rows = tx.all<{ message_uid: string }>(
		`SELECT message_uid FROM mailbox
		  WHERE to_agent=@sessionRef AND state='pending'
		  ORDER BY seq`,
		{ sessionRef: input.sessionRef },
	);
	for (const row of rows) {
		const running = tx.get<{ attempt_uid: string }>(
			`SELECT attempt_uid FROM processing_attempts
			  WHERE message_uid=@messageUid AND outcome='running'`,
			{ messageUid: row.message_uid },
		);
		if (running) {
			tx.cas(FENCE.processingAttemptCasRunningSettled, {
				attemptUid: running.attempt_uid,
				outcome: "crashed",
				settledAt: input.nowIso,
				proposalDigest: null,
			});
		}
		tx.cas(
			`UPDATE mailbox SET state='dead'
			  WHERE message_uid=@messageUid AND state='pending'`,
			{ messageUid: row.message_uid },
		);
		const eventUid = `runner_recipient_terminal:${row.message_uid}`;
		if (
			!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			appendEvent(tx, {
				eventUid,
				kind: "runner_recipient_terminal",
				sourceKind: "session_terminal",
				sourceId: input.sessionRef,
				payload: {
					session_ref: input.sessionRef,
					message_uid: row.message_uid,
				},
				cutoverEpoch: input.cutoverEpoch,
				createdAt: input.nowIso,
			});
		}
	}
	return rows.length;
}
