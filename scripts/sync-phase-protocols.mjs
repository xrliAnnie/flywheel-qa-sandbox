#!/usr/bin/env node
// Reviewed initial extraction is manual. This tool only maintains exact blocks.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Each record maps a legacy role file to its formal workflow node type.
const projections = [
	{ role: "eng_design", type: "design" },
	{ role: "implement", type: "implement" },
	{ role: "qa", type: "qa" },
	{ role: "general", type: "generic" },
	{ role: "general.bare", type: "generic" },
	{ role: "general.matt", type: "generic" },
	{ role: "pm", type: "generic" },
	{ role: "product_design", type: "generic" },
	{ role: "proto", type: "generic" },
];
const args = process.argv.slice(2);
if (
	args.length > 1 ||
	(args.length === 1 && !["--check", "--write"].includes(args[0]))
) {
	console.error("usage: sync-phase-protocols.mjs [--check|--write]");
	process.exit(1);
}
try {
	const sources = new Map(
		["design", "implement", "qa", "generic", "review"].map((type) => {
			const path = `packages/teamlead/phase-protocols/${type}.md`;
			const content = readFileSync(resolve(root, path), "utf8");
			if (!content.trim() || content.includes("FLYWHEEL_PHASE_PROTOCOL:"))
				throw new Error(`${path}: invalid canonical protocol`);
			return [type, content.replace(/\n+$/, "") + "\n"];
		}),
	);
	const migrationPath =
		"engineering/doc/FLY-2533-snapshot-phase-protocol/protocol-extraction.md";
	const migration = readFileSync(resolve(root, migrationPath), "utf8");
	for (const { role: name, type } of projections) {
		const row = migration
			.split("\n")
			.find(
				(line) =>
					line.startsWith("| ") &&
					line.includes(`.flywheel/agents/nodes/${name}.md`) &&
					line.includes(`packages/teamlead/phase-protocols/${type}.md`),
			);
		if (!row)
			throw new Error(
				`${migrationPath}: missing migration entry for ${name} (${type})`,
			);
	}
	const updates = [];
	for (const { role: name, type } of projections) {
		const path = `.flywheel/agents/nodes/${name}.md`;
		const content = readFileSync(resolve(root, path), "utf8");
		const begin = `<!-- FLYWHEEL_PHASE_PROTOCOL:${type}:BEGIN -->`;
		const end = `<!-- FLYWHEEL_PHASE_PROTOCOL:${type}:END -->`;
		const markers = [...content.matchAll(/FLYWHEEL_PHASE_PROTOCOL:/g)];
		const start = content.indexOf(begin);
		const finish = content.indexOf(end);
		if (
			markers.length !== 2 ||
			start < 0 ||
			finish < start + begin.length ||
			content[start + begin.length] !== "\n"
		) {
			throw new Error(
				`${path}: expected one paired ${type} managed block; missing, duplicate, nested or wrong-type markers`,
			);
		}
		const expected = begin + "\n" + sources.get(type) + end;
		const actual = content.slice(start, finish + end.length);
		if (actual !== expected)
			updates.push({
				path,
				content:
					content.slice(0, start) +
					expected +
					content.slice(finish + end.length),
			});
	}
	// Validate every file before allowing the first write.
	if (args[0] === "--write") {
		for (const update of updates)
			writeFileSync(resolve(root, update.path), update.content);
	} else if (updates.length) {
		throw new Error(
			`phase protocol projection drift: ${updates.map(({ path }) => path).join(", ")}; run --write after reviewing canonical changes`,
		);
	}
	console.log(
		`phase protocols: ${projections.length} projections ${args[0] === "--write" ? "synchronized" : "checked"}`,
	);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
