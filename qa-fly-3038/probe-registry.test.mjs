// QA-SBX FLY-3038 drill guard: every probe.txt under qa-fly-3038/runs must be
// listed in qa-fly-3038/probes.txt (one repository-relative path per line).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const runs = new URL("./runs/", import.meta.url);
const registry = new URL("./probes.txt", import.meta.url);

test("every drill probe is registered", () => {
	const listed = new Set(
		readFileSync(registry, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#")),
	);
	const probes = existsSync(runs)
		? readdirSync(runs)
				.filter((name) => existsSync(new URL(`./${name}/probe.txt`, runs)))
				.map((name) => `qa-fly-3038/runs/${name}/probe.txt`)
		: [];
	const missing = probes.filter((path) => !listed.has(path));
	assert.deepEqual(
		missing,
		[],
		`register in qa-fly-3038/probes.txt: ${missing.join(", ")}`,
	);
});
