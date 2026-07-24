import type { PhaseSession } from "./phase-orchestrator.js";
import type { RunnerTmuxTargetDiscovery } from "./tmux-lookup.js";

/** Four-state process evidence shared by three-stage and generalized re-entry. */
export type PhaseLiveness = "alive" | "dead_pin" | "absent" | "indeterminate";

/**
 * FLY-1462: statuses that, together with a successful global exec-marker sweep
 * finding no window, prove the old holder cannot be woken through normal flow.
 *
 * Status alone is not physical-death evidence: terminate can infer the process
 * is gone when its CommDB registration is already absent. `completed` is
 * intentionally excluded because a parked-alive holder commonly has that
 * status. Retry dispatches a new execution id rather than reviving these rows.
 */
const PROVEN_DEAD_HOLDER_STATUSES: ReadonlySet<string> = new Set([
	"terminated",
	"failed",
	"rejected",
	"blocked",
	"deferred",
	"shelved",
]);

export type PhaseActorReentryDecision =
	| { kind: "wake"; reason: "registered_alive" | "persisted_target_alive" }
	| {
			kind: "replace";
			reason:
				| "registered_dead_pin"
				| "persisted_target_dead"
				| "terminal_status_dead";
	  }
	| {
			kind: "hold";
			reason:
				| "registered_liveness_indeterminate"
				| "persisted_target_missing"
				| "persisted_liveness_indeterminate"
				| "terminal_status_unconfirmed";
	  };

/**
 * Prove whether the original context holder can be woken or is genuinely dead.
 * `absent` from the registration-backed probe is not death: a missing CommDB
 * registration and a dead process look identical there. Replacement therefore
 * requires independent target or exec-marker evidence.
 */
export async function classifyPhaseActorReentry(input: {
	session: PhaseSession;
	probeRegistered(session: PhaseSession): Promise<PhaseLiveness>;
	probePersisted(session: PhaseSession): Promise<PhaseLiveness>;
	discoverByExecMarker?(
		session: PhaseSession,
	): Promise<RunnerTmuxTargetDiscovery>;
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
			PROVEN_DEAD_HOLDER_STATUSES.has(input.session.status) &&
			input.discoverByExecMarker
		) {
			const discovered = await input.discoverByExecMarker(input.session);
			if (discovered.kind === "missing") {
				return { kind: "replace", reason: "terminal_status_dead" };
			}
			return { kind: "hold", reason: "terminal_status_unconfirmed" };
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
