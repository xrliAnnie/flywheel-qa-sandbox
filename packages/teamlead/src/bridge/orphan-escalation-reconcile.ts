/**
 * FLY-1066 face ④: resolve detection-escalation episodes whose runner target
 * is absent from StateStore and every configured project CommDB.
 *
 * Escalation rows have no project identity, so this is deliberately a global
 * once-per-full-harvest tail. The all-project presence index is only a first
 * filter: every candidate is synchronously re-read from StateStore and every
 * CommDB immediately before resolution. Any unreadable database is unknown,
 * never absence.
 */

import type { StateStore } from "../StateStore.js";

export interface OrphanEscalationReconcileDeps {
	store: StateStore;
	projectNames: readonly string[];
	listCommDbExecutionIds: (projectName: string) => string[];
	hasCommDbSession: (projectName: string, executionId: string) => boolean;
	/** Test/race seam invoked after first-pass filtering, before authoritative re-reads. */
	beforeCandidateRecheck?: (executionId: string) => void;
	log?: (message: string) => void;
}

export interface OrphanEscalationReconcileResult {
	aborted: boolean;
	abortReason?: "no_configured_projects" | "commdb_index_unreadable";
	scanned: number;
	candidateTargets: number;
	resolvedTargets: number;
	resolvedRows: number;
	skippedNonRunnerTarget: number;
	keptPresent: number;
	readErrors: number;
}

function emptyResult(): OrphanEscalationReconcileResult {
	return {
		aborted: false,
		scanned: 0,
		candidateTargets: 0,
		resolvedTargets: 0,
		resolvedRows: 0,
		skippedNonRunnerTarget: 0,
		keptPresent: 0,
		readErrors: 0,
	};
}

/** Runner targets are raw execution ids; lead/watchdog state keys are project:lead. */
export function isRunnerEscalationTargetKey(targetKey: string): boolean {
	return targetKey.length > 0 && !targetKey.includes(":");
}

export function resolveOrphanDetectionEscalations(
	deps: OrphanEscalationReconcileDeps,
): OrphanEscalationReconcileResult {
	const result = emptyResult();
	const log = deps.log ?? ((message: string) => console.warn(message));
	const projectNames = [...new Set(deps.projectNames)];
	if (projectNames.length === 0) {
		result.aborted = true;
		result.abortReason = "no_configured_projects";
		return result;
	}

	// Fail the entire face-④ pass closed unless every configured CommDB can be
	// indexed. A partial index cannot prove a target is globally absent.
	const commDbPresence = new Set<string>();
	try {
		for (const projectName of projectNames) {
			for (const executionId of deps.listCommDbExecutionIds(projectName)) {
				commDbPresence.add(executionId);
			}
		}
	} catch (err) {
		result.aborted = true;
		result.abortReason = "commdb_index_unreadable";
		result.readErrors++;
		log(
			`[orphan-escalation-reconcile] CommDB presence index unreadable; aborting global pass (${(err as Error).message})`,
		);
		return result;
	}

	const rows = deps.store.getDetectionEscalationsForReconcile();
	result.scanned = rows.length;
	const candidates = new Set<string>();
	for (const row of rows) {
		if (!isRunnerEscalationTargetKey(row.target_key)) {
			result.skippedNonRunnerTarget++;
			continue;
		}
		if (
			deps.store.getSession(row.target_key) ||
			commDbPresence.has(row.target_key)
		) {
			result.keptPresent++;
			continue;
		}
		candidates.add(row.target_key);
	}
	result.candidateTargets = candidates.size;

	for (const executionId of candidates) {
		deps.beforeCandidateRecheck?.(executionId);
		if (deps.store.getSession(executionId)) {
			result.keptPresent++;
			continue;
		}

		let present = false;
		let indeterminate = false;
		for (const projectName of projectNames) {
			try {
				if (deps.hasCommDbSession(projectName, executionId)) {
					present = true;
					break;
				}
			} catch (err) {
				indeterminate = true;
				result.readErrors++;
				log(
					`[orphan-escalation-reconcile] ${executionId}: ${projectName} CommDB re-read indeterminate (${(err as Error).message})`,
				);
				break;
			}
		}
		if (present || indeterminate) {
			if (present) result.keptPresent++;
			continue;
		}

		const resolved =
			deps.store.resolveDetectionEscalationsForResidueTarget(executionId);
		if (resolved > 0) {
			result.resolvedTargets++;
			result.resolvedRows += resolved;
		}
	}
	return result;
}
