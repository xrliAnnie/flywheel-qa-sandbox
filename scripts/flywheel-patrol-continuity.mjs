#!/usr/bin/env node
/**
 * Trusted launcher for patrol continuity and report closure (FLY-1945).
 *
 * Resolve this executable's real path before locating its compiled implementation.
 * Managed bin entrypoints are strict symlinks to this source, and packaged installs
 * contain the same scripts/ + packages/teamlead/dist/ layout. Neither the working
 * directory nor an environment module path can select executable code. The CLI
 * accepts data-source paths solely for read-only SQLite and project-registry input;
 * report validation never invokes collectors or writes a continuity sidecar.
 *
 * A missing compiled helper is an unavailable dependency. Do not restore the old
 * terminal-line timer or infer STALLED from a failed dependency. Snapshot callers
 * preserve every owned pane and emit UNKNOWN until the full helper is available.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

try {
	const source = realpathSync(fileURLToPath(import.meta.url));
	const modulePath = join(
		dirname(dirname(source)),
		"packages/teamlead/dist/patrol-continuity-cli.js",
	);
	if (!statSync(modulePath).isFile()) throw Error("helper_missing");
	const implementation = await import(pathToFileURL(modulePath).href);
	if (typeof implementation.runPatrolContinuity !== "function")
		throw Error("helper_invalid");
	process.exitCode = await implementation.runPatrolContinuity(
		process.argv.slice(2),
	);
} catch {
	process.stderr.write("PATROL_CONTINUITY_UNAVAILABLE helper_load_failed\n");
	process.exitCode = 70;
}
