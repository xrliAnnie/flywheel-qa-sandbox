/**
 * Shared helper for the per-project CommDB file path. Extracted from
 * `event-route.ts` so other Bridge modules (e.g. ProofShot trigger) can use
 * the same path convention without duplicating it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory for per-project CommDB files. Defaults to `~/.flywheel/comm`.
 *
 * FLY-493: honor `FLYWHEEL_COMM_DIR` so tests can redirect the comm.db to an
 * isolated temp dir and NEVER write to the live Bridge comm.db. The older
 * `FLYWHEEL_COMM_ROOT` name remains a compatibility fallback. Every Bridge
 * caller must use this resolver so gate retirement and lifecycle finalization
 * cannot split across two databases.
 */
export function commDbRootDir(): string {
	const override =
		process.env.FLYWHEEL_COMM_ROOT?.trim() ||
		process.env.FLYWHEEL_COMM_DIR?.trim();
	return override || join(homedir(), ".flywheel", "comm");
}

export function commDbPathForProject(projectName: string): string {
	return join(commDbRootDir(), projectName, "comm.db");
}
