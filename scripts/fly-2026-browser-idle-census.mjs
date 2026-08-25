#!/usr/bin/env node

/** FLY-2026 — read-only `--once --print` browser idle census. */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFreshTeamleadDist } from "./fly-1867-playwright-orphan-census.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const relevantSourcePaths = Object.freeze([
	"packages/teamlead/src/bridge/browser-idle-census.ts",
	"packages/teamlead/src/bridge/chrome-session-reaper.ts",
	"packages/teamlead/src/bridge/mcp-descendant-reaper.ts",
	"packages/teamlead/src/bridge/mcp-process-classifier.ts",
	"packages/teamlead/src/bridge/playwright-orphan-census.ts",
]);

export function parseArgs(argv) {
	if (argv.length !== 2 || argv[0] !== "--once" || argv[1] !== "--print") {
		throw new Error("usage: fly-2026-browser-idle-census.mjs --once --print");
	}
	return { once: true, print: true };
}

export function censusExitCode(census) {
	return census?.status === "ok" && census.singleDigit === true ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
	parseArgs(argv);
	assertFreshTeamleadDist(repoRoot, relevantSourcePaths);

	const modulePath = join(
		repoRoot,
		"packages",
		"teamlead",
		"dist",
		"bridge",
		"browser-idle-census.js",
	);
	const { collectBrowserIdleCensus } = await import(
		pathToFileURL(modulePath).href
	);
	const census = await collectBrowserIdleCensus();
	process.stdout.write(`${JSON.stringify(census)}\n`);
	process.exitCode = censusExitCode(census);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
