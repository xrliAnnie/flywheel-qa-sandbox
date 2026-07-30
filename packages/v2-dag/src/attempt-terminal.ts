import { FENCE, type WriteTx } from "flywheel-v2-kernel";
import { DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import { readEnvelope, updateEnvelope } from "./meta.js";
import { terminalizeSessionMailboxTx } from "./terminal-mail.js";

interface WriterChainData {
	chain_head: string;
	open_attempt: null | {
		attempt_id: string;
		generation: number;
		family: string;
		start_head: string;
	};
	span_author_set: string[];
	pending_gap: null | { from: string; to: string };
}

interface LaunchClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: unknown;
}

export type AttemptTerminalReason =
	| "completed"
	| "failed"
	| "canceled"
	| "superseded";

/**
 * FLY-1543 ⑩: the single transaction-scoped terminal transition for a DAG
 * attempt. The holder and every holding die in the same Kernel.write:
 *
 * - the attempt becomes terminal;
 * - active activations stop being mailbox recipients;
 * - pending session mail and running delivery attempts settle;
 * - launch owner/lease claims are tombstoned and cleared;
 * - every exact attempt/generation writer lock is released.
 *
 * Callers may advance a successful/observed writer chain before invoking this
 * primitive in the same transaction. If they do not, this still releases the
 * open_attempt without authorizing any HEAD movement.
 */
export function terminalizeAttemptTx(
	tx: WriteTx,
	input: {
		attemptId: string;
		reason: AttemptTerminalReason;
		cutoverEpoch: number;
		nowIso: string;
	},
): {
	releasedSessions: number;
	settledMessages: number;
	releasedLaunchClaims: number;
	releasedWriterLocks: number;
} {
	const attempt = tx.get<{
		task_id: string;
		generation: number;
		desired_state: string;
		worktree_id: string | null;
	}>(
		`SELECT task_id,generation,desired_state,worktree_id
		   FROM attempts WHERE id=@attemptId`,
		{ attemptId: input.attemptId },
	);
	if (!attempt)
		throw new DagContractError("attempt terminal source is missing");
	if (attempt.desired_state === "terminal") {
		throw new DagContractError("attempt is already terminal");
	}

	tx.cas(FENCE.attemptCasActiveTerminal, {
		attemptId: input.attemptId,
		reason: input.reason,
		terminalAt: input.nowIso,
	});

	const activations = tx.all<{
		id: string;
		session_ref: string;
		state: string;
	}>(
		`SELECT id,session_ref,state
		   FROM activations
		  WHERE attempt_id=@attemptId
		  ORDER BY rowid`,
		{ attemptId: input.attemptId },
	);
	let releasedSessions = 0;
	let settledMessages = 0;
	let releasedLaunchClaims = 0;
	for (const activation of activations) {
		if (activation.state === "active") {
			tx.cas(FENCE.activationCasActiveTerminal, {
				activationId: activation.id,
			});
			releasedSessions += 1;
		}
		settledMessages += terminalizeSessionMailboxTx(tx, {
			sessionRef: activation.session_ref,
			cutoverEpoch: input.cutoverEpoch,
			nowIso: input.nowIso,
		});
		const claimKey = `launch_claim:${activation.session_ref}`;
		const claim = readEnvelope<LaunchClaimData>(
			tx,
			claimKey,
			input.cutoverEpoch,
		);
		if (
			claim &&
			(claim.data.state !== "tombstoned" ||
				claim.data.owner_token !== null ||
				claim.data.lease_until !== null)
		) {
			updateEnvelope(
				tx,
				claimKey,
				claim,
				{
					...claim.data,
					state: "tombstoned",
					owner_token: null,
					lease_until: null,
				},
				input.nowIso,
			);
			releasedLaunchClaims += 1;
		}
	}

	let releasedWriterLocks = 0;
	if (attempt.worktree_id) {
		const writerKey = `writer_chain:${attempt.worktree_id}`;
		const writer = readEnvelope<WriterChainData>(
			tx,
			writerKey,
			input.cutoverEpoch,
		);
		if (writer?.data.open_attempt?.attempt_id === input.attemptId) {
			if (writer.data.open_attempt.generation !== attempt.generation) {
				throw new DagContractError("owned writer lock generation is corrupt");
			}
			updateEnvelope(
				tx,
				writerKey,
				writer,
				{ ...writer.data, open_attempt: null },
				input.nowIso,
			);
			releasedWriterLocks = 1;
		}
	}

	const eventUid = `attempt_holdings_released:${input.attemptId}`;
	if (!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })) {
		appendEvent(tx, {
			eventUid,
			taskId: attempt.task_id,
			attemptId: input.attemptId,
			kind: "attempt_holdings_released",
			sourceKind: "attempt_terminal",
			sourceId: input.attemptId,
			payload: {
				reason: input.reason,
				released_sessions: releasedSessions,
				settled_messages: settledMessages,
				released_launch_claims: releasedLaunchClaims,
				released_writer_locks: releasedWriterLocks,
			},
			cutoverEpoch: input.cutoverEpoch,
			createdAt: input.nowIso,
		});
	}
	return {
		releasedSessions,
		settledMessages,
		releasedLaunchClaims,
		releasedWriterLocks,
	};
}
