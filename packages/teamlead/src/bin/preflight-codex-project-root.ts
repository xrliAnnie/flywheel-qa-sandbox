#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveFullAccessProjectRoot } from "../lead-backends/codex/codex-lead-runtime.js";

export interface PreflightCodexProjectRootDeps {
	homeDir?: string;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

function errorLine(code: string, message: string): string {
	return JSON.stringify({ ok: false, code, message });
}

export function runPreflightCodexProjectRoot(
	args: string[],
	deps: PreflightCodexProjectRootDeps = {},
): 0 | 64 | 78 {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	let values: {
		"project-root"?: string;
		"state-dir"?: string;
		"codex-home"?: string;
	};
	try {
		({ values } = parseArgs({
			args,
			options: {
				"project-root": { type: "string" },
				"state-dir": { type: "string" },
				"codex-home": { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		stderr(
			errorLine(
				"codex_project_root_usage",
				error instanceof Error ? error.message : String(error),
			),
		);
		return 64;
	}
	const projectRoot = values["project-root"]?.trim();
	const stateDir = values["state-dir"]?.trim();
	const codexHome = values["codex-home"]?.trim();
	if (!projectRoot || !stateDir || !codexHome) {
		stderr(
			errorLine(
				"codex_project_root_usage",
				"--project-root, --state-dir, and --codex-home are required",
			),
		);
		return 64;
	}
	const home = deps.homeDir ?? homedir();
	try {
		const canonical = resolveFullAccessProjectRoot(projectRoot, "", {
			home,
			flywheelDir: join(home, ".flywheel"),
			stateDir,
			codexHome,
		});
		stdout(JSON.stringify({ ok: true, projectRoot: canonical }));
		return 0;
	} catch (error) {
		stderr(
			errorLine(
				"codex_project_root_invalid",
				error instanceof Error ? error.message : String(error),
			),
		);
		return 78;
	}
}

if (
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = runPreflightCodexProjectRoot(process.argv.slice(2));
}
