#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TEAMLEAD_ROOT = join(REPO_ROOT, "packages", "teamlead");
const RECEIPT =
	/FLY-2453 529 receipt state_db=.*teamlead\.db comm_db=.*comm\.db fake_founder=\d+ fake_discord=\d+ source=1 audit=1 verdict=1 observation=1 declaration=1 strength_two=1 opinion=1 reaction=eligible land=activated/;

const result = spawnSync(
	"pnpm",
	[
		"--dir",
		TEAMLEAD_ROOT,
		"exec",
		"vitest",
		"run",
		"src/__tests__/StateStore.auto-narrow-approval.test.ts",
		"-t",
		"529 isolated",
		"--reporter=verbose",
	],
	{ cwd: REPO_ROOT, encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
if (result.error) throw result.error;
if (result.status !== 0) {
	throw new Error(`FLY-2453 529 harness failed with exit ${result.status}`);
}
if (!RECEIPT.test(output)) {
	throw new Error(
		"FLY-2453 529 harness completed without its evidence receipt",
	);
}
process.stdout.write(
	"FLY-2453 529 gate: PASS (independent StateStore/CommDB, fake founder and Discord)\n",
);
