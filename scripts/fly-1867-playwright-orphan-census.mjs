#!/usr/bin/env node

/** FLY-1867 — read-only `--once --print` Playwright orphan census. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export function parseArgs(argv) {
	if (argv.length !== 2 || argv[0] !== "--once" || argv[1] !== "--print") {
		throw new Error(
			"usage: fly-1867-playwright-orphan-census.mjs --once --print",
		);
	}
	return { once: true, print: true };
}

export function assertFreshBuildIdentity(identity, gitHead) {
	if (
		!identity ||
		typeof identity.artifactBuildSha !== "string" ||
		identity.artifactBuildSha !== gitHead
	) {
		throw new Error(
			`teamlead_dist_stale: artifact=${identity?.artifactBuildSha ?? "missing"} head=${gitHead}; run pnpm --dir packages/teamlead build`,
		);
	}
}

export function assertFreshTeamleadDist(targetRepoRoot, paths) {
	const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: targetRepoRoot,
		encoding: "utf8",
	}).trim();
	let identity;
	try {
		identity = JSON.parse(
			readFileSync(
				join(
					targetRepoRoot,
					"packages",
					"teamlead",
					"dist",
					"build-identity.json",
				),
				"utf8",
			),
		);
	} catch {
		identity = undefined;
	}
	assertFreshBuildIdentity(identity, gitHead);
	try {
		execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...paths], {
			cwd: targetRepoRoot,
			stdio: "ignore",
		});
		const untracked = execFileSync(
			"git",
			["ls-files", "--others", "--exclude-standard", "--", ...paths],
			{ cwd: targetRepoRoot, encoding: "utf8" },
		).trim();
		if (untracked) throw new Error("untracked");
	} catch {
		throw new Error(
			"teamlead_dist_source_dirty: commit the census sources and rebuild before reading live processes",
		);
	}
}

export async function main(argv = process.argv.slice(2)) {
	parseArgs(argv);
	assertFreshTeamleadDist(repoRoot, [
		"packages/teamlead/src/bridge/chrome-session-reaper.ts",
		"packages/teamlead/src/bridge/playwright-orphan-census.ts",
	]);

	const bridgeDist = join(repoRoot, "packages", "teamlead", "dist", "bridge");
	const [{ collectChromeSweepSample }, { formatPlaywrightOrphanCensusOnce }] =
		await Promise.all([
			import(pathToFileURL(join(bridgeDist, "chrome-session-reaper.js")).href),
			import(
				pathToFileURL(join(bridgeDist, "playwright-orphan-census.js")).href
			),
		]);
	const rawGrace = Number(process.env.FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN);
	const orphanGraceMinutes =
		Number.isFinite(rawGrace) && rawGrace > 0 ? rawGrace : 30;
	const sample = await collectChromeSweepSample();
	const output = await formatPlaywrightOrphanCensusOnce({
		sample,
		orphanGraceMinutes,
	});
	process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
