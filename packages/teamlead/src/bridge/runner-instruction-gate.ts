import { createHash, randomUUID } from "node:crypto";
import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../StateStore.js";

export interface RunnerInstructionAudit {
	projectName: string;
	issueId: string;
	source: string;
	reason: string;
}
export type EnqueueOutcome =
	| { queued: true; inserted: boolean }
	| { queued: false; skipped: "missing" | "terminal" };

/** Gate issue/generation-enumerated recipients using mailbox liveness truth. */
export function enqueueRunnerInstructionIfDeliverable(
	deps: {
		store: Pick<StateStore, "resolveRunnerRecipientState" | "insertEvent">;
		commDb: Pick<CommDB, "insertInstruction" | "insertInstructionWithId">;
	},
	input: {
		fromAgent: string;
		executionId: string;
		content: string;
		dedupeId?: string;
		instructionId?: string;
		audit: RunnerInstructionAudit;
	},
): EnqueueOutcome {
	const { state } = deps.store.resolveRunnerRecipientState(input.executionId);
	if (state !== "alive") {
		deps.store.insertEvent({
			event_id: `instruction_skipped:${input.dedupeId ?? input.instructionId ?? randomUUID()}`,
			execution_id: input.executionId,
			issue_id: input.audit.issueId,
			project_name: input.audit.projectName,
			source: input.audit.source,
			event_type: `instruction_skipped_recipient_${state}`,
			severity: "info",
			payload: {
				fromAgent: input.fromAgent,
				reason: input.audit.reason,
				contentDigest: createHash("sha256")
					.update(input.content)
					.digest("hex")
					.slice(0, 16),
			},
		});
		return { queued: false, skipped: state };
	}
	const inserted = input.instructionId
		? deps.commDb.insertInstructionWithId(
				input.instructionId,
				input.fromAgent,
				input.executionId,
				input.content,
			)
		: // This legacy API returns an ID even on dedupe replay, not a new-row bit.
			Boolean(
				deps.commDb.insertInstruction(
					input.fromAgent,
					input.executionId,
					input.content,
					{ dedupeId: input.dedupeId },
				),
			);
	return { queued: true, inserted };
}
