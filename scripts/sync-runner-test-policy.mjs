#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = "packages/teamlead/phase-protocols/local-test-policy.md";
const targetPaths = [
	"packages/teamlead/phase-protocols/implement.md",
	"packages/teamlead/phase-protocols/qa.md",
	".flywheel/agents/nodes/engineer.md",
	"packages/claude-runner/agents/codex-runner-contract.md",
];
const begin = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
const end = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";
const args = process.argv.slice(2);

if (
	args.length > 1 ||
	(args.length === 1 && !new Set(["--check", "--write"]).has(args[0]))
) {
	console.error("usage: sync-runner-test-policy.mjs [--check|--write]");
	process.exit(1);
}

function markerCount(content, marker) {
	return content.split(marker).length - 1;
}

try {
	const source = readFileSync(resolve(root, sourcePath), "utf8").trim();
	if (
		!source ||
		markerCount(source, begin) !== 1 ||
		markerCount(source, end) !== 1 ||
		!source.includes("local-test-policy/v1")
	)
		throw new Error(`${sourcePath}: invalid canonical policy block`);

	const updates = [];
	for (const path of targetPaths) {
		const content = readFileSync(resolve(root, path), "utf8");
		if (markerCount(content, begin) !== 1 || markerCount(content, end) !== 1)
			throw new Error(`${path}: expected exactly one paired policy block`);
		const start = content.indexOf(begin);
		const finish = content.indexOf(end, start);
		if (finish < start)
			throw new Error(`${path}: policy markers are reversed or nested`);
		const actual = content.slice(start, finish + end.length);
		if (actual !== source)
			updates.push({
				path,
				content:
					content.slice(0, start) + source + content.slice(finish + end.length),
			});
	}

	if (args[0] === "--write") {
		for (const update of updates)
			writeFileSync(resolve(root, update.path), update.content);
	} else if (updates.length) {
		throw new Error(
			`local test policy projection drift: ${updates.map(({ path }) => path).join(", ")}; run --write after reviewing the canonical change`,
		);
	}
	console.log(
		`local test policy: ${targetPaths.length} projections ${args[0] === "--write" ? "synchronized" : "checked"}`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
