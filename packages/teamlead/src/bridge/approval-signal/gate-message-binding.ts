/**
 * FLY-799 Part A-0b — durable ship-gate message binding (pure core).
 *
 * ReactionSource requires an authoritative `(questionId, prHeadSha) →
 * gateMessageId` binding: the Discord id of the "🚀 Ship gate" notification
 * message that the founder reacts on (Codex R3 #1). Without a binding there is
 * NO approval; the target is never inferred from thread scan / text / timestamp.
 *
 * The binding is persisted as a durable, immutable session_event
 * (`bindingEventId`, which insertEvent's UNIQUE constraint makes write-once).
 * These pure helpers extract the created message id from the notifier's Discord
 * POST response and select the ONE current binding fail-closed (Codex R4 #2:
 * exactly one match for the current question+head, else null).
 */

export interface GateMessageBinding {
	questionId: string;
	executionId: string;
	issueId: string;
	prHeadSha: string;
	threadId: string;
	gateMessageId: string;
	checkpoint: string;
	postedAt: string;
}

/** Extract the created message id from a Discord POST /channels/:id/messages body. */
export function extractGateMessageId(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const id = (body as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Stable, write-once event id for a `(question, head)` ship-gate message
 * binding revision.
 *
 * FLY-945 Fix B (Codex R1 #1 / R2 #4): the id carries the FULL 40-hex head —
 * a per-question-only id would make the row write-once forever, so a head
 * rebind (QA-evidence commit moved the PR head) could never anchor the
 * follow-up gate message. Each `(question, head)` is one immutable row; older
 * heads' rows remain and simply stop matching `selectCurrentBinding`. Display
 * text may shorten the sha; the persisted unique key never does.
 */
export function bindingEventId(questionId: string, prHeadSha: string): string {
	return `ship-gate-msg-binding-${questionId}-${prHeadSha.toLowerCase()}`;
}

/**
 * Select the single current binding for `(questionId, prHeadSha)`, fail-closed:
 * exactly one match resolves; zero or more-than-one (ambiguous / stale) → null.
 */
export function selectCurrentBinding(
	bindings: readonly GateMessageBinding[],
	questionId: string,
	prHeadSha: string,
): GateMessageBinding | null {
	const matches = bindings.filter(
		(b) => b.questionId === questionId && b.prHeadSha === prHeadSha,
	);
	return matches.length === 1 ? (matches[0] as GateMessageBinding) : null;
}
