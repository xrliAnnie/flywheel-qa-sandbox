/**
 * FLY-799 Part A-0b — durable binding persistence over StateStore.
 *
 * Persists the ship-gate message binding as a WRITE-ONCE session_event per
 * `(question, head)` revision: `bindingEventId(questionId, prHeadSha)` +
 * `insertEvent`'s UNIQUE constraint make each revision immutable (a duplicate
 * ship-gate notification cannot overwrite the first captured message id —
 * Codex R4 #2), while a FLY-945 head rebind anchors a new revision row.
 * Reads back the ONE current binding fail-closed via `selectCurrentBinding`.
 */

import type { SessionEvent, StateStore } from "../../StateStore.js";
import {
	bindingEventId,
	type GateMessageBinding,
	selectCurrentBinding,
} from "./gate-message-binding.js";

const BINDING_EVENT_TYPE = "ship_gate_msg_binding";

/**
 * Write the binding write-once per `(question, head)` revision. Returns true
 * when this write created the row, false when a binding for this exact
 * `(question, head)` already existed (immutable — the first captured
 * `gateMessageId` wins). FLY-945 Fix B: a NEW head for the same question is a
 * NEW row (rebind anchor); older head rows remain and naturally stop matching.
 */
export function writeGateMessageBinding(
	store: StateStore,
	binding: GateMessageBinding,
	projectName: string,
): boolean {
	const event: SessionEvent = {
		event_id: bindingEventId(binding.questionId, binding.prHeadSha),
		execution_id: binding.executionId,
		issue_id: binding.issueId,
		project_name: projectName,
		event_type: BINDING_EVENT_TYPE,
		source: "bridge.fly799-gate-binding",
		payload: binding,
	};
	return store.insertEvent(event);
}

/** Read the single current binding for `(executionId, questionId, prHeadSha)`, or null (fail-closed). */
export function readCurrentGateMessageBinding(
	store: StateStore,
	executionId: string,
	questionId: string,
	prHeadSha: string,
): GateMessageBinding | null {
	const bindings = store
		.getEventsByExecution(executionId)
		.filter((e) => e.event_type === BINDING_EVENT_TYPE)
		.map((e) => e.payload as GateMessageBinding)
		.filter((b): b is GateMessageBinding => !!b && typeof b === "object");
	return selectCurrentBinding(bindings, questionId, prHeadSha);
}
