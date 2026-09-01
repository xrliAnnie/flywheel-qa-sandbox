#!/usr/bin/env node
/**
 * Trusted launcher for the FLY-2210 node-dwell maintenance helper.
 *
 * This .mjs source is intentionally committed as an executable rather than generated
 * into a mutable bin directory. `converge-flywheel-bin.sh` installs a strict
 * symlink to this source. Resolving the launcher through `realpathSync` means a
 * production invocation from `$HOME/.local/bin` still discovers the checkout
 * that owns both this wrapper and the compiled TeamLead module. No environment
 * variable can redirect the imported executable.
 *
 * The wrapper does not open SQLite itself. Threshold reads are performed by
 * `StateStore.openForMaintenance(..., { readonly: true })`; open approval gates
 * are projected by CommDB's read-only question-domain API; receipt writes use
 * the bounded writer in the same compiled module. This separation keeps shell
 * quoting out of lifecycle SQL and gives callers stable non-zero diagnostics:
 *
 *   NODE_DWELL_UNAVAILABLE <token>  configuration/read failure
 *   RECEIPT_BUSY                    writer could not acquire SQLite promptly
 *   RECEIPT_REJECTED <token>        caller or target validation failed
 *
 * Build `packages/teamlead` before invoking this launcher. A missing or stale
 * dist artifact is an unavailable patrol dependency, never permission to fall
 * back to an unvalidated default threshold.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourcePath = realpathSync(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(sourcePath));
const modulePath = join(
	repoRoot,
	"packages",
	"teamlead",
	"dist",
	"node-dwell-control.js",
);

try {
	if (!statSync(modulePath).isFile()) {
		throw new Error("compiled helper is not a regular file");
	}
	const implementation = await import(pathToFileURL(modulePath).href);
	if (typeof implementation.runNodeDwellControl !== "function") {
		throw new Error("compiled helper is missing runNodeDwellControl");
	}
	process.exitCode = await implementation.runNodeDwellControl(
		process.argv.slice(2),
	);
} catch (error) {
	const detail = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`NODE_DWELL_UNAVAILABLE helper_load_failed (${detail})\n`,
	);
	process.exitCode = 70;
}
