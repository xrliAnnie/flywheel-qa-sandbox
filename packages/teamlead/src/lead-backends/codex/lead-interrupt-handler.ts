/**
 * FLY-2883 plan §6.1 — the Codex Lead sidecar's side of a controlled
 * interrupt. Injected into CodexLeadInboxServer only by the windowed TUI
 * runtime, which owns this generation's LeadTurnStateTracker (FLY-2882).
 *
 * A turn is in progress → steer the letter into THAT turn (never cancel it).
 * The Lead is idle → start one ordinary turn through the router.
 * The state is unknown, the router is paused, or the steer failed → report
 * `steer_failed` and do nothing else; the Bridge holds the letter and
 * re-judges later. A failed steer is never retried as a new turn here.
 *
 * Reading the state and issuing the side effect happen in one synchronous
 * section: nothing is awaited between `tracker.snapshot()` and the steer or
 * submit call, so a lifecycle event can never land in between (R3#1).
 */

import { codexMailboxTurnInput } from "./ack-action-batching-turn-input.js";
import type { CodexLeadInterruptOutcome } from "./CodexLeadInboxSocket.js";
import { CodexLeadProcessError } from "./CodexLeadProcess.js";
import type { LeadInputBatch, LeadInputRouter } from "./LeadInputRouter.js";
import type { LeadJournal } from "./LeadJournal.js";
import type { LeadTurnStateTracker } from "./LeadTurnStateTracker.js";

const RESULT_KEY_PREFIX = "interrupt-result:";

export interface CodexLeadInterruptHandlerDeps {
	threadId: string;
	tracker: Pick<LeadTurnStateTracker, "snapshot">;
	router: Pick<LeadInputRouter, "submitBatch" | "isPaused">;
	steer: (args: {
		threadId: string;
		expectedTurnId: string;
		input: unknown[];
		clientUserMessageId: string;
	}) => Promise<void>;
	journal: Pick<LeadJournal, "getByIdempotencyKey" | "recordObservation">;
	/** FLY-2909: governed launch receipt; absent keeps steer input byte-identical. */
	ackActionBatchingEnabled?: boolean;
	log?: (message: string) => void;
}

function recorded(
	output: string | undefined,
): CodexLeadInterruptOutcome | undefined {
	return output === "steered" || output === "queued_turn"
		? { outcome: output }
		: undefined;
}

export function createCodexLeadInterruptHandler(
	deps: CodexLeadInterruptHandlerDeps,
): { submit(batch: LeadInputBatch): Promise<CodexLeadInterruptOutcome> } {
	const record = (
		batchId: string,
		disposition: "steered" | "queued_turn",
	): void => {
		// Written only after the side effect succeeded. Losing it (crash) means a
		// replay steers again: at-least-once, documented as L3.
		try {
			deps.journal.recordObservation({
				idempotencyKey: `${RESULT_KEY_PREFIX}${batchId}`,
				payload: JSON.stringify({ kind: "lead_interrupt_result", disposition }),
				output: disposition,
			});
		} catch (error) {
			deps.log?.(
				`[lead-interrupt] result record failed for ${batchId}: ${(error as Error).message}`,
			);
		}
	};

	return {
		async submit(batch) {
			const prior = recorded(
				deps.journal.getByIdempotencyKey(`${RESULT_KEY_PREFIX}${batch.batchId}`)
					?.output,
			);
			if (prior) return prior;

			// ── synchronous decision section (no await until the side effect) ──
			if (deps.router.isPaused())
				return { outcome: "steer_failed", detail: "router_paused" };
			const snapshot = deps.tracker.snapshot();
			if (!snapshot.connected || !snapshot.seeded)
				return { outcome: "steer_failed", detail: "turn_state_unknown" };
			const turn = snapshot.activeTurns[0];
			if (!turn) {
				deps.router.submitBatch(batch);
				record(batch.batchId, "queued_turn");
				return { outcome: "queued_turn" };
			}
			const steering = deps.steer({
				threadId: deps.threadId,
				expectedTurnId: turn.turnId,
				input: [
					{
						type: "text",
						text: codexMailboxTurnInput(
							batch.payload,
							deps.ackActionBatchingEnabled,
						),
					},
				],
				clientUserMessageId: batch.batchId,
			});
			// ── end of synchronous section ──
			try {
				await steering;
			} catch (error) {
				// A protocol error (turn already ended / id mismatch) proves it did
				// not land; timeout, exit or a transport error may have landed.
				const detail =
					error instanceof CodexLeadProcessError && error.kind === "protocol"
						? "stale_turn"
						: "steer_outcome_unknown";
				deps.log?.(
					`[lead-interrupt] steer ${detail} for ${batch.batchId}: ${(error as Error).message}`,
				);
				return { outcome: "steer_failed", detail };
			}
			record(batch.batchId, "steered");
			return { outcome: "steered" };
		},
	};
}
