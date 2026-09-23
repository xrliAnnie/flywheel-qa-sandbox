#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const oldValue = ["claude", "opus", "5"].join("-");
const newValue = ["claude", "opus", "5.5"].join("-");
const files = [];
function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (/\.(?:ts|json)$/.test(entry.name)) files.push(path);
	}
}
walk(root);
const oldMatches = [];
let newMatches = 0;
for (const file of files) {
	const text = readFileSync(file, "utf8");
	if (text.includes(oldValue)) oldMatches.push(relative(root, file));
	newMatches += text.split(newValue).length - 1;
}
const index = readFileSync(join(root, "src/index.ts"), "utf8");
const passed =
	oldMatches.length === 0 &&
	newMatches >= 16 &&
	index.includes("claude-opus-50") &&
	index.includes("claude-sonnet-5");
process.stdout.write(
	`${JSON.stringify({ passed, oldMatches, newMatches, nearValuePreserved: index.includes("claude-opus-50"), unrelatedValuePreserved: index.includes("claude-sonnet-5") })}\n`,
);
process.exitCode = passed ? 0 : 1;
