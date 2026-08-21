import type { CommDB } from "flywheel-comm/db";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import type { PhaseLiveness } from "./phase-actor-reentry.js";
import type { RunnerTmuxTargetDiscovery } from "./tmux-lookup.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";

export type HolderWakeCause = "qa_fail" | "phase_retest" | "workflow_rework";

export interface HolderWakeActivationDeps {
	transitionOpts: ApplyTransitionOpts;
	openCommDb: (projectName: string) => CommDB;
	resolveLeadId: (session: WorkflowActorSession) => string | undefined;
	resolveVendor: (session: WorkflowActorSession) => string | undefined;
	discoverTmuxTarget: (
		executionId: string,
	) => Promise<RunnerTmuxTargetDiscovery>;
	probeDiscoveredTarget: (tmuxTarget: string) => Promise<PhaseLiveness>;
}

/**
 * Event-driven reactivation for a reused parked holder. This is deliberately
 * called only by wake write paths: it performs no inventory, cadence, or
 * after-the-fact repair sweep.
 */
export async function activateHolderForWake(
	deps: HolderWakeActivationDeps,
	input: { session: WorkflowActorSession; cause: HolderWakeCause },
): Promise<{ ok: true } | { ok: false; error: string }> {
	const fresh = deps.transitionOpts.store.getSession(
		input.session.execution_id,
	);
	if (
		!fresh ||
		fresh.issue_id !== input.session.issue_id ||
		fresh.project_name !== input.session.project_name
	) {
		return { ok: false, error: "statestore_session_identity_mismatch" };
	}

	if (fresh.status === "approved_to_ship") {
		return { ok: false, error: "state_not_revivable:approved_to_ship" };
	}
	if (
		fresh.status !== "running" &&
		fresh.status !== "ship_parked" &&
		fresh.status !== "design_done" &&
		fresh.status !== "awaiting_review"
	) {
		return { ok: false, error: `state_not_revivable:${fresh.status}` };
	}

	const leadId = deps.resolveLeadId(input.session)?.trim();
	const vendor = deps.resolveVendor(input.session)?.trim();
	if (!leadId || !vendor) {
		return { ok: false, error: "wake_identity_routing_missing" };
	}

	let db: CommDB | undefined;
	try {
		db = deps.openCommDb(fresh.project_name);
		const registered = db.getSession(fresh.execution_id);
		let tmuxWindow = registered?.tmux_window?.trim();
		if (!tmuxWindow || tmuxWindow.endsWith(":pending")) {
			const discovered = await deps.discoverTmuxTarget(fresh.execution_id);
			if (discovered.kind !== "found") {
				return {
					ok: false,
					error: `commdb_session_target_${discovered.kind}`,
				};
			}
			tmuxWindow = discovered.tmuxWindow;
		}
		const liveness = await deps.probeDiscoveredTarget(tmuxWindow);
		if (liveness !== "alive") {
			return {
				ok: false,
				error: `persisted_target_not_alive:${liveness}`,
			};
		}
		const activated = db.activateSessionForWake({
			executionId: fresh.execution_id,
			tmuxWindow,
			projectName: fresh.project_name,
			issueId: fresh.issue_id,
			leadId,
			vendor,
		});
		if (!activated.ok) {
			return { ok: false, error: activated.reason };
		}
	} catch (error) {
		return {
			ok: false,
			error: `commdb_activation_failed:${(error as Error).message}`,
		};
	} finally {
		db?.close();
	}

	const transition = (targetStatus: string) =>
		applyTransition(deps.transitionOpts, fresh.execution_id, targetStatus, {
			executionId: fresh.execution_id,
			issueId: fresh.issue_id,
			projectName: fresh.project_name,
			trigger: "wake_rework",
			payload: { cause: input.cause },
		});

	if (fresh.status === "awaiting_review") {
		const parked = transition("ship_parked");
		if (!parked.ok) {
			return {
				ok: false,
				error: `statestore_activation_failed:${parked.error ?? "awaiting_review_to_ship_parked"}`,
			};
		}
	}
	const current = deps.transitionOpts.store.getSession(
		fresh.execution_id,
	)?.status;
	if (current !== "running") {
		const running = transition("running");
		if (!running.ok) {
			return {
				ok: false,
				error: `statestore_activation_failed:${running.error ?? `${current}_to_running`}`,
			};
		}
	}
	return { ok: true };
}
