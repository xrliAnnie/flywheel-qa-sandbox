#!/usr/bin/env node
/**
 * FLY-247 inc2a (R2 #5 / §2.6): engine-side projects.json validator.
 *
 * `flywheel-fleet.sh` invokes this built CLI before EVERY projects.json rename
 * and during recovery, so the bash writer can never fall back to `jq empty` and
 * silently bypass cross-field rules such as the FLY-245 codex fail-close. It is
 * the SAME validation authority the Bridge uses (`parseAndValidateProjects`),
 * with no env access and no secret hydration.
 *
 * Versioned so the engine can assert a minimum validator version.
 *
 * Exit codes (consumed by flywheel-fleet.sh):
 *   0 — valid (or --version)
 *   1 — schema/cross-field INVALID (e.g. FLY-245 violation)
 *   2 — input could not be read
 *   3 — input was not valid JSON
 */

import { readFileSync } from "node:fs";
import { parseAndValidateProjects } from "../ProjectConfig.js";

export const VALIDATE_PROJECTS_VERSION = 1;

export interface ValidateResult {
	code: 0 | 1 | 2 | 3;
	message: string;
}

/** Validate raw projects.json text. Pure — no process exit, no env reads. */
export function validateProjectsText(text: string): ValidateResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { code: 3, message: `invalid JSON: ${errMsg(err)}` };
	}
	try {
		parseAndValidateProjects(raw);
	} catch (err) {
		return { code: 1, message: `INVALID: ${errMsg(err)}` };
	}
	return { code: 0, message: `OK (v${VALIDATE_PROJECTS_VERSION})` };
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** CLI entry. `argv` = full process.argv. Returns the process exit code. */
export function runCli(argv: string[]): number {
	const arg = argv[2];
	if (arg === "--version") {
		process.stdout.write(`validate-projects v${VALIDATE_PROJECTS_VERSION}\n`);
		return 0;
	}
	let text: string;
	try {
		// A path arg reads that file; "-" or no arg reads stdin (fd 0).
		text =
			arg && arg !== "-"
				? readFileSync(arg, "utf-8")
				: readFileSync(0, "utf-8");
	} catch (err) {
		process.stderr.write(
			`validate-projects: cannot read input: ${errMsg(err)}\n`,
		);
		return 2;
	}
	const result = validateProjectsText(text);
	const stream = result.code === 0 ? process.stdout : process.stderr;
	stream.write(`validate-projects: ${result.message}\n`);
	return result.code;
}

// Only run when invoked directly as a CLI (not when imported by tests).
// import.meta.url is the file URL; process.argv[1] is the invoked script path.
if (
	typeof process !== "undefined" &&
	import.meta.url === `file://${process.argv[1]}`
) {
	process.exit(runCli(process.argv));
}
