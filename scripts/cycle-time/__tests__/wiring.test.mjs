import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root package and CI expose the explicit cycle-time test glob after sqlite preflight", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		pkg.scripts["test:cycle-time"],
		"node --test scripts/cycle-time/__tests__/*.test.mjs",
	);
	const ci = await readFile(
		new URL("../../../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	);
	const preflight = ci.indexOf("sqlite3 --version");
	const testStep = ci.indexOf("pnpm test:cycle-time");
	const dependencyStep = ci.indexOf(
		"bash scripts/ci-apt-install.sh tmux lsof sqlite3 ripgrep",
	);
	assert.ok(dependencyStep >= 0);
	assert.ok(preflight > dependencyStep);
	assert.ok(testStep > preflight);
});

test("cycle-time CLI entrypoint exists and advertises required arguments", async () => {
	const source = await readFile(
		new URL("../cycle-time-report.mjs", import.meta.url),
		"utf8",
	);
	assert.match(source, /parseReportArgs\(process\.argv\.slice\(2\)\)/);
	assert.match(source, /data-\$\{issue\}\.json/);
	assert.match(source, /cycle-time-report\.html/);
});
