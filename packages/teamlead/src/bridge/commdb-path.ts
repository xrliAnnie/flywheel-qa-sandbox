/**
 * Shared helper for the per-project CommDB file path. Extracted from
 * `event-route.ts` so other Bridge modules (e.g. ProofShot trigger) can use
 * the same path convention without duplicating it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function commDbPathForProject(projectName: string): string {
	return join(homedir(), ".flywheel", "comm", projectName, "comm.db");
}
