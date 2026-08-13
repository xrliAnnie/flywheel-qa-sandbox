import { isStateStoreIrreversibleTerminalForZombie } from "../StateStore.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";

/** Four-state process evidence shared by DAG workflow and generalized re-entry. */
export type PhaseLiveness = "alive" | "dead_pin" | "absent" | "indeterminate";

export type PhaseActorReentryDecision =
	| { kind: "wake"; reason: "registered_alive" | "persisted_target_alive" }
	| {
			kind: "replace";
			reason:
				| "registered_dead_pin"
				| "persisted_target_dead"
				| "terminal_actor_target_and_host_absent";
	  }
	| {
			kind: "hold";
			reason:
				| "registered_liveness_indeterminate"
				| "persisted_target_missing"
				| "persisted_liveness_indeterminate";
	  };

/**
 * Prove whether the original context holder can be woken or is genuinely dead.
 * `absent` from the registration-backed probe is not death: a cleared/corrupt
 * CommDB registration and a dead process look identical there. Only the actor's
 * persisted tmux target may authorize replacement.
 */
export async function classifyPhaseActorReentry(input: {
	session: WorkflowActorSession;
	probeRegistered(session: WorkflowActorSession): Promise<PhaseLiveness>;
	probePersisted(session: WorkflowActorSession): Promise<PhaseLiveness>;
	hasHostProcess?(executionId: string): Promise<boolean>;
}): Promise<PhaseActorReentryDecision> {
	const registered = await input.probeRegistered(input.session);
	if (registered === "alive") {
		return { kind: "wake", reason: "registered_alive" };
	}
	if (registered === "dead_pin") {
		return { kind: "replace", reason: "registered_dead_pin" };
	}
	if (registered === "indeterminate") {
		return { kind: "hold", reason: "registered_liveness_indeterminate" };
	}
	if (!input.session.tmux_session) {
		if (
			input.hasHostProcess &&
			isStateStoreIrreversibleTerminalForZombie(input.session.status) &&
			!(await input.hasHostProcess(input.session.execution_id))
		) {
			return {
				kind: "replace",
				reason: "terminal_actor_target_and_host_absent",
			};
		}
		return { kind: "hold", reason: "persisted_target_missing" };
	}
	const persisted = await input.probePersisted(input.session);
	if (persisted === "alive") {
		return { kind: "wake", reason: "persisted_target_alive" };
	}
	if (persisted === "dead_pin" || persisted === "absent") {
		return { kind: "replace", reason: "persisted_target_dead" };
	}
	return { kind: "hold", reason: "persisted_liveness_indeterminate" };
}
