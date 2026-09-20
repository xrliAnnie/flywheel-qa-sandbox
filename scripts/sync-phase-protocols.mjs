#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = "scripts/lib/local-verification-policy.md";
const targets = [
	".flywheel/agents/engineering/engineer-executor.md",
	".flywheel/agents/engineering/qa-executor.md",
	".flywheel/agents/general-executor.md",
];
const begin = "<!-- FLYWHEEL_LOCAL_VERIFICATION:BEGIN -->";
const end = "<!-- FLYWHEEL_LOCAL_VERIFICATION:END -->";
try {
	const args = process.argv.slice(2);
	if (
		args.length > 1 ||
		(args.length && !["--check", "--write"].includes(args[0]))
	)
		throw new Error("usage: sync-phase-protocols.mjs [--check|--write]");
	const raw = readFileSync(resolve(root, source), "utf8");
	if (!raw.trim() || raw.includes("FLYWHEEL_LOCAL_VERIFICATION:"))
		throw new Error("invalid local verification source");
	const expected = `${begin}\n${raw.replace(/\n+$/, "")}\n${end}`;
	const updates = [];
	for (const path of targets) {
		const text = readFileSync(resolve(root, path), "utf8");
		const start = text.indexOf(begin),
			finish = text.indexOf(end);
		if (
			[...text.matchAll(/FLYWHEEL_LOCAL_VERIFICATION:/g)].length !== 2 ||
			start < 0 ||
			finish < start + begin.length ||
			(start > 0 && text[start - 1] !== "\n") ||
			text[start + begin.length] !== "\n" ||
			text[finish - 1] !== "\n" ||
			(finish + end.length < text.length && text[finish + end.length] !== "\n")
		)
			throw new Error(
				`${path}: expected one paired standalone local verification block`,
			);
		const actual = text.slice(start, finish + end.length);
		if (actual !== expected)
			updates.push({
				path,
				content:
					text.slice(0, start) + expected + text.slice(finish + end.length),
			});
	}
	if (args[0] === "--write") {
		for (const update of updates)
			writeFileSync(resolve(root, update.path), update.content);
	} else if (updates.length)
		throw new Error(
			`local verification projection drift: ${updates.map((x) => x.path).join(", ")}`,
		);
	console.log(
		`local verification: 3 projections ${args[0] === "--write" ? "synchronized" : "checked"}`,
	);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
