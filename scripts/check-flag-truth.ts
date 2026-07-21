#!/usr/bin/env -S npx tsx
/** FLY-1393: static + live truth check for every FLYWHEEL_* environment key. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	validateFlagTruthEnvironment,
	validateWatchdogManifest,
} from "../packages/config/src/feature-flags/truth.js";

interface Args {
	envFile: string;
	live: boolean;
	healthUrl: string;
}

function parseArgs(argv: readonly string[]): Args {
	let envFile = resolve(homedir(), ".flywheel/.env");
	let live = false;
	let healthUrl = process.env.FLYWHEEL_BRIDGE_URL ?? "http://127.0.0.1:9876";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--live") live = true;
		else if (argv[i] === "--env-file" && argv[i + 1])
			envFile = resolve(argv[++i]!);
		else if (argv[i] === "--health-url" && argv[i + 1]) healthUrl = argv[++i]!;
		else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
	}
	return { envFile, live, healthUrl: healthUrl.replace(/\/$/, "") };
}

export function envNamesFromFile(content: string): string[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) =>
			line
				.replace(/^export\s+/, "")
				.split("=", 1)[0]!
				.trim(),
		)
		.filter((name) => name.startsWith("FLYWHEEL_"));
}

function liveBridgeEnvNames(): string[] {
	const listing = execFileSync("ps", ["eww", "-axo", "command="], {
		encoding: "utf8",
	});
	const bridge = listing
		.split(/\r?\n/)
		.find(
			(line) =>
				/FLYWHEEL_BRIDGE_URL=/.test(line) &&
				/(run-bridge|flywheel-teamlead|bridge\/plugin)/.test(line),
		);
	if (!bridge) throw new Error("live Bridge process not found");
	return [...bridge.matchAll(/(?:^|\s)(FLYWHEEL_[A-Z0-9_]+)=/g)].map(
		(match) => match[1]!,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.envFile))
		throw new Error(`env file not found: ${args.envFile}`);
	const names = envNamesFromFile(readFileSync(args.envFile, "utf8"));
	if (args.live) names.push(...liveBridgeEnvNames());
	const staticResult = validateFlagTruthEnvironment([...new Set(names)]);
	const errors = [...staticResult.errors];
	if (args.live) {
		const response = await fetch(`${args.healthUrl}/health`);
		if (!response.ok)
			errors.push(`Bridge /health returned HTTP ${response.status}`);
		else {
			const body = (await response.json()) as { watchdogs?: unknown };
			if (!body.watchdogs)
				errors.push("Bridge /health missing watchdogs manifest");
			else errors.push(...validateWatchdogManifest(body.watchdogs).errors);
		}
	}
	if (errors.length > 0) {
		for (const error of errors) console.error(`ERROR ${error}`);
		process.exitCode = 1;
		return;
	}
	console.log(
		`flag truth OK: ${new Set(names).size} env keys${args.live ? " + live watchdog manifest" : ""}`,
	);
}

void main().catch((error) => {
	console.error(
		`ERROR ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
