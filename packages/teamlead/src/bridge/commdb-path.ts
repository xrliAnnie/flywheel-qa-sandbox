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
 * isolated temp dir and NEVER write to the live Bridge comm.db (the production
 * gate-watcher reads it — leaked test gate questions otherwise time out and
 * spam the Lead). Unset → byte-compatible with the prod default path.
 */
export function commDbRootDir(): string {
	const override = process.env.FLYWHEEL_COMM_DIR?.trim();
	return override || join(homedir(), ".flywheel", "comm");
}

export function commDbPathForProject(projectName: string): string {
	return join(commDbRootDir(), projectName, "comm.db");
}
