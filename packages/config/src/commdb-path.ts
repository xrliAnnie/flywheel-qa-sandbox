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
 * FLY-2454: FLYWHEEL_COMM_ROOT takes precedence over the legacy
 * FLYWHEEL_COMM_DIR alias. Bridge, Lead runtime, runner adapter and cleanup
 * share this resolver so lifecycle operations cannot split across databases.
 */
export function commDbRootDir(env: NodeJS.ProcessEnv = process.env): string {
	const override =
		env.FLYWHEEL_COMM_ROOT?.trim() || env.FLYWHEEL_COMM_DIR?.trim();
	return override || join(homedir(), ".flywheel", "comm");
}

export function commDbPathForProject(
	projectName: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(commDbRootDir(env), projectName, "comm.db");
}
