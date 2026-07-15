/**
 * GEO-151 ProofShot — free port detection without killing the occupant.
 *
 * Why not just spawn ProofShot with `--port 3000` and let it scream? Two
 * reasons:
 *   1. ProofShot's stock behavior is to either fail or, in some versions,
 *      kill the existing listener. Killing is unsafe — the user might have
 *      a real dev server running for unrelated work.
 *   2. We need to know the picked port to render the URL the Runner Reads.
 *
 * Strategy: try a small range of candidate ports starting at `preferredPort`.
 * For each, use `lsof -i :<port>` to check if anything is listening. First
 * free port wins. If all are occupied, return `null` and let the caller
 * fail with a clear error (don't pick a random port — Annie likely wants
 * the deterministic 3000-3010 range).
 *
 * NOTE: `lsof` is macOS/Linux. On Windows we'd need `netstat`. Flywheel
 * runs on Annie's Mac only today, so we don't worry about it.
 */

import { execFileSync } from "node:child_process";

export const DEFAULT_PORT_RANGE_START = 3000;
export const DEFAULT_PORT_RANGE_COUNT = 10;

/**
 * Find the first free port in `[preferredPort, preferredPort + count)`.
 * Returns `null` if all are occupied.
 *
 * For test-friendliness, accepts an optional `probeFn` that overrides the
 * actual `lsof` call. Default behavior shells out to `lsof -i :PORT`.
 */
export function findFreePort(
	preferredPort: number = DEFAULT_PORT_RANGE_START,
	count: number = DEFAULT_PORT_RANGE_COUNT,
	probeFn: (port: number) => boolean = isPortOccupiedViaLsof,
): number | null {
	for (let i = 0; i < count; i++) {
		const port = preferredPort + i;
		if (!probeFn(port)) return port;
	}
	return null;
}

/**
 * Run `lsof -i :PORT` and return true if any process is listening.
 * `lsof` exits 0 with output when there's a hit; exits 1 with no output
 * when nothing is listening. We catch both.
 */
export function isPortOccupiedViaLsof(port: number): boolean {
	try {
		const out = execFileSync("lsof", ["-i", `:${port}`, "-P", "-n"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		// Non-empty stdout means at least one listener.
		return out.trim().length > 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status === 1) {
			// lsof exit 1 with no output = port free.
			return false;
		}
		// Any other failure (missing lsof binary, EACCES, etc.) — treat as
		// "unknown but probably free" so we don't block on platform issues.
		// The downstream spawn will throw a real error if the port really
		// is occupied.
		return false;
	}
}
