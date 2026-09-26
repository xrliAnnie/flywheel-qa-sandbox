import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
	defaultMarkerDir,
	type MarkerReconcilerDeps,
	tryReconcileComplete,
} from "./complete-marker-reconciler.js";

/** Pending or unreadable completion evidence vetoes death; no liveness inference. */
export function hasUnresolvedCompleteMarker(
	executionId: string,
	markerDir?: string,
): boolean {
	if (!executionId || /[/\\]|\.\./.test(executionId)) return true;
	try {
		// lstat keeps a dangling symlink pending instead of treating it as absent.
		lstatSync(join(markerDir ?? defaultMarkerDir(), `${executionId}.json`));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Reconcile completion after slow work and before preparing a death mutation.
 * Callers must still re-read lifecycle authority and synchronously check
 * hasUnresolvedCompleteMarker adjacent to their CAS, with no intervening await.
 */
export async function completionBlocksDeath(
	executionId: string,
	deps: MarkerReconcilerDeps | null,
): Promise<boolean> {
	try {
		if (deps) {
			const outcome = await tryReconcileComplete(executionId, deps);
			if (outcome.kind !== "absent" && outcome.kind !== "quarantined")
				return true;
		}
		return hasUnresolvedCompleteMarker(executionId, deps?.markerDir);
	} catch {
		return true;
	}
}
