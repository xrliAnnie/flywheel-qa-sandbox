#!/usr/bin/env node
// Read-only native skill admission check. Does not bootstrap or run a model.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PINNED_NATIVE_CODEX_SKILLS } from "../packages/teamlead/dist/lead-capabilities/native-skill-baseline.js";
import { verifyNativeSkillBaseline } from "../packages/teamlead/dist/lead-capabilities/native-skills.js";

try {
	if (process.argv.length !== 2 || !process.env.CODEX_HOME) throw new Error();
	const executable = realpathSync(join(homedir(), ".local/bin/codex"));
	const output = execFileSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 4096,
		stdio: ["ignore", "pipe", "ignore"],
		env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
	}).trim();
	const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/.exec(output);
	if (!match) throw new Error();
	const sources = verifyNativeSkillBaseline({
		root: realpathSync(join(process.env.CODEX_HOME, "skills/.system")),
		baseline: PINNED_NATIVE_CODEX_SKILLS,
		codexVersion: match[1],
		secrets: [],
	});
	process.stdout.write(
		JSON.stringify({
			status: "passed",
			codexVersion: match[1],
			sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
			modelStarted: false,
			productionMutated: false,
		}) + "\n",
	);
} catch {
	process.stdout.write(
		JSON.stringify({
			status: "failed",
			errorCode: "native_skill_baseline_unverified",
		}) + "\n",
	);
	process.exitCode = 1;
}
