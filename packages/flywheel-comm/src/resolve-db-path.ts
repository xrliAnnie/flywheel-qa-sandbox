import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the comm DB path from CLI args and environment.
 * Priority: --db flag > FLYWHEEL_COMM_DB env > --project flag > error
 */
export function resolveDbPath(opts: { db?: string; project?: string }): string {
	if (opts.db) {
		return opts.db;
	}

	const envPath = process.env.FLYWHEEL_COMM_DB;
	if (envPath) {
		return envPath;
	}

	if (opts.project) {
		return join(homedir(), ".flywheel", "comm", opts.project, "comm.db");
	}

	throw new Error(
		"No DB path specified. Use --db, --project, or set FLYWHEEL_COMM_DB.",
	);
}
