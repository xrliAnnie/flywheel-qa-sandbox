#!/usr/bin/env node
// Read-only native skill admission check for a designated Codex home.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const DESIGNATED_HOME_NAMES = new Set([
	".codex-259-qa",
	".codex-raya",
	".codex-mufasa",
	".codex-infra-bot",
]);

try {
	if (process.argv.length !== 2 || !process.env.CODEX_HOME) throw new Error();
	const userHome = realpathSync(homedir());
	const requestedHome = process.env.CODEX_HOME;
	if (!isAbsolute(requestedHome)) throw new Error();
	const codexHome = realpathSync(requestedHome);
	const homeRelative = relative(userHome, codexHome);
	if (
		codexHome !== requestedHome ||
		homeRelative.startsWith(`..${sep}`) ||
		homeRelative === ".." ||
		homeRelative.includes(sep) ||
		!DESIGNATED_HOME_NAMES.has(homeRelative)
	)
		throw new Error();

	const executable = realpathSync(
		join(codexHome, "packages/standalone/current/codex"),
	);
	const releasesRoot = `${realpathSync(
		join(codexHome, "packages/standalone/releases"),
	)}${sep}`;
	if (!executable.startsWith(releasesRoot)) throw new Error();
	const output = execFileSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 4096,
		stdio: ["ignore", "pipe", "ignore"],
		env: {
			HOME: "/dev/null",
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
		},
	}).trim();
	const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/.exec(output);
	if (!match) throw new Error();
	const { resolvePinnedNativeSkillBaseline } = await import(
		"../packages/teamlead/dist/lead-capabilities/native-skill-baseline.js"
	);
	const { verifyNativeSkillOrigin } = await import(
		"../packages/teamlead/dist/lead-capabilities/native-home.js"
	);
	const baseline = resolvePinnedNativeSkillBaseline(match[1]);
	if (!baseline.origin) throw new Error();
	const sources = verifyNativeSkillOrigin({
		root: realpathSync(join(codexHome, "skills/.system")),
		baseline,
		codexVersion: match[1],
		secrets: [],
	});
	process.stdout.write(
		`${JSON.stringify({
			status: "passed",
			codexVersion: match[1],
			selectedOrigin: baseline.origin.root,
			sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
			modelStarted: false,
			productionMutated: false,
		})}\n`,
	);
} catch {
	process.stdout.write(
		`${JSON.stringify({
			status: "failed",
			errorCode: "native_skill_baseline_unverified",
		})}\n`,
	);
	process.exitCode = 1;
}
