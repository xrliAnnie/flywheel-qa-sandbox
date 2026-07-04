/**
 * FLY-709 P4.3/P4.4 — `flywheel-comm runner-config apply`.
 *
 * The command Annie's copy-paste text targets (Path C): a Lead runs it on the
 * machine to change a project's runner defaults (`roles.runner.*`) or a cron
 * collection's model (`xiaohongshu_learning.collections[].model`). All write
 * semantics live in flywheel-config's writer (loader round-trip, fail-loud
 * contracts, comment preservation); this layer only resolves the project root
 * from ~/.flywheel/projects.json and parses flags.
 *
 * Changes are read per-run (call time) → they apply to NEW runs immediately,
 * no Bridge restart.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ApplyResult,
	type CronModelChange,
	type RunnerDefaultsChange,
	applyCronModel as realApplyCronModel,
	applyRunnerDefaults as realApplyRunnerDefaults,
} from "flywheel-config";

export interface RunnerConfigDeps {
	readProjectsJson?: () => string;
	applyRunnerDefaults?: (
		configPath: string,
		change: RunnerDefaultsChange,
	) => Promise<ApplyResult>;
	applyCronModel?: (
		configPath: string,
		change: CronModelChange,
	) => Promise<ApplyResult>;
	log?: (msg: string) => void;
	errorLog?: (msg: string) => void;
	exit?: (code: number) => never;
}

const USAGE =
	"usage: flywheel-comm runner-config apply --project <name> [--cron <collection_id>] [--model <id|default>] [--effort <level|default>] [--backend <executor|default>] --yes";

function flagVal(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** "default" → null (remove override); other strings verbatim. */
function dim(args: string[], name: string): string | null | undefined {
	const v = flagVal(args, name);
	if (v === undefined) return undefined;
	return v === "default" ? null : v;
}

function resolveProjectRoot(
	projectsJson: string,
	projectName: string,
): string | undefined {
	const raw = JSON.parse(projectsJson) as unknown;
	const entries = Array.isArray(raw)
		? raw
		: ((raw as { projects?: unknown[] })?.projects ?? []);
	for (const entry of entries) {
		const e = entry as { projectName?: string; projectRoot?: string };
		if (e?.projectName === projectName && typeof e.projectRoot === "string") {
			return e.projectRoot;
		}
	}
	return undefined;
}

export async function runRunnerConfig(
	args: string[],
	deps: RunnerConfigDeps = {},
): Promise<void> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const errorLog = deps.errorLog ?? ((m: string) => console.error(m));
	const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
	const fail = (msg: string): never => {
		errorLog(msg);
		errorLog(USAGE);
		return exit(1);
	};

	if (args[0] !== "apply") {
		return void fail(
			`unknown runner-config subcommand: ${args[0] ?? "(none)"}`,
		);
	}
	const project = flagVal(args, "--project");
	if (!project) return void fail("--project is required");
	const cronId = flagVal(args, "--cron");
	const model = dim(args, "--model");
	const effort = dim(args, "--effort");
	const backend = dim(args, "--backend");

	if (model === undefined && effort === undefined && backend === undefined) {
		return void fail(
			"nothing to change — give at least one of --model / --effort / --backend",
		);
	}
	if (cronId !== undefined && (effort !== undefined || backend !== undefined)) {
		return void fail(
			"--cron only supports --model (a cron collection has no effort/backend dimension)",
		);
	}
	if (!args.includes("--yes")) {
		return void fail(
			"refusing without --yes (the pasted command carries the founder's explicit authorization)",
		);
	}

	const readProjectsJson =
		deps.readProjectsJson ??
		(() => readFileSync(join(homedir(), ".flywheel", "projects.json"), "utf8"));
	let projectRoot: string | undefined;
	try {
		projectRoot = resolveProjectRoot(readProjectsJson(), project);
	} catch (err) {
		return void fail(`cannot read ~/.flywheel/projects.json: ${String(err)}`);
	}
	if (!projectRoot) {
		return void fail(
			`unknown project "${project}" in ~/.flywheel/projects.json`,
		);
	}
	const configPath = join(projectRoot, ".flywheel", "config.yaml");

	try {
		let result: ApplyResult;
		if (cronId !== undefined) {
			const applyCron = deps.applyCronModel ?? realApplyCronModel;
			// --cron requires an explicit --model (set or "default").
			if (model === undefined) {
				return void fail("--cron requires --model <id|default>");
			}
			result = await applyCron(configPath, {
				collectionId: cronId,
				model,
			});
		} else {
			const applyDefaults = deps.applyRunnerDefaults ?? realApplyRunnerDefaults;
			const change: RunnerDefaultsChange = {};
			if (model !== undefined) change.model = model;
			if (effort !== undefined) change.effort = effort;
			if (backend !== undefined) change.backend = backend;
			result = await applyDefaults(configPath, change);
		}
		if (result.changed.length === 0) {
			log(`no-op: ${configPath} already matches the requested state`);
		} else {
			log(`updated ${configPath}:`);
			for (const key of result.changed) log(`  - ${key}`);
			log("新 run 生效（热生效，无需重启 Bridge）");
		}
	} catch (err) {
		return void fail(err instanceof Error ? err.message : String(err));
	}
}
