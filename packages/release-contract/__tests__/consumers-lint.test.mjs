import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN_ROOTS = [
	path.join(ROOT, "packages/payload-endpoint/src"),
	path.join(ROOT, "scripts/release"),
];

async function filesUnder(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(fullPath)));
		else if (entry.isFile() && entry.name.endsWith(".mjs"))
			found.push(fullPath);
	}
	return found;
}

test("runtime consumers do not redefine payload channels or version regexes", async () => {
	const violations = [];
	for (const scanRoot of SCAN_ROOTS) {
		for (const file of await filesUnder(scanRoot)) {
			const lines = (await readFile(file, "utf8")).split("\n");
			for (const [index, rawLine] of lines.entries()) {
				const line = rawLine.trim();
				if (line.startsWith("//") || line.startsWith("#")) continue;
				if (
					line.includes('"internal-beta"') ||
					line.includes('"customer-release"') ||
					line.includes("'internal-beta'") ||
					line.includes("'customer-release'") ||
					line.includes("-beta\\.")
				) {
					violations.push(`${path.relative(ROOT, file)}:${index + 1}: ${line}`);
				}
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("payload cleanup consumes the shared retention and pointer helpers", async () => {
	const relativePath = "scripts/release/payload-cleanup.mjs";
	const source = await readFile(path.join(ROOT, relativePath), "utf8");
	assert.match(
		source,
		/import\s*{[^}]*(?=[^}]*RETENTION_WINDOW_MS)(?=[^}]*latestSet)[^}]*}\s*from\s*["']\.\.\/\.\.\/packages\/release-contract\/src\/index\.mjs["']/s,
		`${relativePath} must import RETENTION_WINDOW_MS and latestSet from the contract`,
	);
	assert.doesNotMatch(source, /const\s+WINDOW_MS\s*=/);
	assert.doesNotMatch(source, /function\s+latestSet\s*\(/);
});

test("onboard shell publish path stays independent from the payload base version", async () => {
	for (const relativePath of [
		"scripts/release/shell-prepare.mjs",
		"scripts/release/shell-publish-preflight.sh",
	]) {
		const source = await readFile(path.join(ROOT, relativePath), "utf8");
		assert.equal(
			source.includes("doc/VERSION"),
			false,
			`${relativePath} must not derive the shell version from doc/VERSION`,
		);
	}
});
