/**
 * FLY-1066: Bridge-global residue-harvest orchestration.
 *
 * Boot, heartbeat maintenance, and the scheduled-run targeted path share one
 * in-process single-flight guard. A slow pass is skipped instead of overlapped;
 * every destructive decision remains inside the face-specific reconcilers.
 */

import type { Session } from "../StateStore.js";
import type { ProvenDeadTmuxTarget } from "./commdb-session-prune.js";

export type ResidueHarvestPassOutcome = "completed" | "skipped_in_flight";

export interface ResidueHarvester {
	runFullPass(): Promise<ResidueHarvestPassOutcome>;
	reapTarget(session: Session): Promise<boolean>;
}

export interface ResidueHarvesterDeps {
	projectNames: readonly string[];
	/** FLYWHEEL_COMMDB_FSM_RECONCILE gates only the CommDB-running face. */
	commDbFsmEnabled: boolean;
	harvestCommDb: (projectName: string) => Promise<unknown>;
	pruneTerminalCommDb: (
		projectName: string,
	) => Promise<readonly ProvenDeadTmuxTarget[]>;
	harvestStateStoreGhosts: (
		projectName: string,
		provenDeadTargets: readonly ProvenDeadTmuxTarget[],
	) => Promise<unknown>;
	resolveOrphanEscalations: () => unknown;
	reapStateStoreGhost: (session: Session) => Promise<boolean>;
	log?: (message: string) => void;
}

export function createResidueHarvester(
	deps: ResidueHarvesterDeps,
): ResidueHarvester {
	let inFlight = false;
	const log = deps.log ?? ((message: string) => console.warn(message));
	const projectNames = [...new Set(deps.projectNames)];

	return {
		async runFullPass() {
			if (inFlight) return "skipped_in_flight";
			inFlight = true;
			try {
				for (const projectName of projectNames) {
					if (deps.commDbFsmEnabled) {
						try {
							await deps.harvestCommDb(projectName);
						} catch (err) {
							log(
								`[residue-harvest] CommDB pass failed for ${projectName} (non-fatal): ${(err as Error).message}`,
							);
						}
					}
					let provenDeadTargets: readonly ProvenDeadTmuxTarget[] = [];
					try {
						provenDeadTargets = await deps.pruneTerminalCommDb(projectName);
					} catch (err) {
						log(
							`[residue-harvest] terminal CommDB prune failed for ${projectName} (non-fatal): ${(err as Error).message}`,
						);
					}
					try {
						await deps.harvestStateStoreGhosts(projectName, provenDeadTargets);
					} catch (err) {
						log(
							`[residue-harvest] StateStore pass failed for ${projectName} (non-fatal): ${(err as Error).message}`,
						);
					}
				}
				try {
					deps.resolveOrphanEscalations();
				} catch (err) {
					log(
						`[residue-harvest] orphan-escalation pass failed (non-fatal): ${(err as Error).message}`,
					);
				}
				return "completed";
			} finally {
				inFlight = false;
			}
		},

		async reapTarget(session) {
			if (inFlight) return false;
			inFlight = true;
			try {
				return await deps.reapStateStoreGhost(session);
			} catch (err) {
				log(
					`[residue-harvest] targeted pass failed for ${session.execution_id} (fail-closed): ${(err as Error).message}`,
				);
				return false;
			} finally {
				inFlight = false;
			}
		},
	};
}

export interface ResidueAwareBootSweepDeps {
	projectNames: readonly string[];
	residueHarvester?: Pick<ResidueHarvester, "runFullPass">;
	commDbFsmEnabled: boolean;
	runLegacyCommDbFsm: (projectName: string) => Promise<unknown>;
	pruneCommDb: (projectName: string) => Promise<unknown>;
}

/** Keep the flag-off FLY-817→FLY-638 call path exact; flag-on uses shared core. */
export async function runResidueAwareBootSweep(
	deps: ResidueAwareBootSweepDeps,
): Promise<void> {
	if (deps.residueHarvester) {
		await deps.residueHarvester.runFullPass();
		return;
	}
	for (const projectName of new Set(deps.projectNames)) {
		if (deps.commDbFsmEnabled) {
			await deps.runLegacyCommDbFsm(projectName);
		}
		await deps.pruneCommDb(projectName);
	}
}

/** Existing heartbeat tick 0 remains the boot-equivalent maintenance pass. */
export function residueMaintenanceEveryNTicks(intervalMs: number): number {
	return Math.max(1, Math.round(3_600_000 / Math.max(intervalMs, 1)));
}
