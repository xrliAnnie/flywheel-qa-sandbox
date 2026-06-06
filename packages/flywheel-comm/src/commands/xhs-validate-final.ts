/**
 * FLY-222: `flywheel-comm xhs-validate-final --run-key <K> [--response-file <p>]`
 *
 * The skill's fail-close gate (plan §2.3 ①). Reads the raw prune-gate response
 * (from --response-file, else stdin), validates it is a FINAL envelope bound to
 * --run-key, and:
 *   - valid   → prints the parsed envelope JSON, exit 0
 *   - invalid → prints {"valid":false,"reason":...}, exit 1
 *
 * The non-zero exit is the skill's signal to fail-close (zero Linear/memory
 * side-effects, state not advanced). Output goes to stdout so the skill parses
 * the kept candidates / learnings on success.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateFinalResponse } from "../xiaohongshu-final.js";

function readStdin(): string {
	try {
		return readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

export function xhsValidateFinal(argv: string[]): number {
	const { values } = parseArgs({
		args: argv,
		options: {
			"run-key": { type: "string" },
			"response-file": { type: "string" },
		},
		allowPositionals: false,
	});

	const runKey = values["run-key"];
	if (!runKey) {
		process.stderr.write("xhs-validate-final: --run-key is required\n");
		return 2;
	}

	const raw = values["response-file"]
		? readFileSync(values["response-file"], "utf-8")
		: readStdin();

	const result = validateFinalResponse(raw, runKey);
	if (result.valid) {
		process.stdout.write(`${JSON.stringify(result.final)}\n`);
		return 0;
	}
	process.stdout.write(
		`${JSON.stringify({ valid: false, reason: result.reason })}\n`,
	);
	return 1;
}
