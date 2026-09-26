/** QA host: pnpm exec tsx packages/teamlead/src/__tests__/fixtures/loop-guard/attribution-probe.mts */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canInspectProcesses, runKillHarness } from "./run-kill-harness.js";

if (!canInspectProcesses()) {
	console.error(
		"UNVERIFIED: /bin/ps unavailable; fallback green cannot prove attribution. Run on the authorized QA host.",
	);
	process.exit(2);
}
const mode = process.argv[2] ?? "--all";
assert.ok(
	["--all", "--red-only", "--green-only"].includes(mode),
	"Use --all, --red-only or --green-only",
);
if (mode !== "--green-only") {
	// Original guard-before-spawn ordering with a controlled same-PID exec
	// delay. This models the startup window, not a naturally occurring CI red.
	const { result, forensic } = await runKillHarness({
		psAvailable: true,
		execDelayMs: 800,
		legacy: true,
	});
	console.log(JSON.stringify({ phase: "RED", result, forensic }));
	assert.deepEqual(result, { code: 0, signal: null });
	assert.equal(forensic.attribution, "child");
	assert.ok(forensic.children, "RED needs a real process snapshot");
	assert.ok(
		forensic.children?.some((child) => child.comm === "node"),
		"RED must reproduce node attribution",
	);
	assert.ok(
		!forensic.children.some((child) => child.comm === "sleep"),
		"RED must fail the original sleep assertion",
	);
	console.log(
		"RED reproduced: original sleep assertion fails with node attribution",
	);
}
if (mode !== "--red-only") {
	const cwd = fileURLToPath(new URL("../../../../../../", import.meta.url));
	const rounds = Number(process.env.LOOP_GUARD_PROBE_ROUNDS ?? 20);
	assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20);
	const reportDir = mkdtempSync(join(tmpdir(), "loop-attribution-probe-"));
	try {
		for (let round = 1; round <= rounds; round += 1) {
			const report = join(reportDir, `round-${round}.json`);
			const run = spawnSync(
				"pnpm",
				[
					"--filter",
					"flywheel-teamlead",
					"exec",
					"vitest",
					"run",
					"src/__tests__/bridge-event-loop-guard.test.ts",
					"-t",
					"production observation:",
					"--reporter=json",
					`--outputFile=${report}`,
					"--maxWorkers=1",
					"--minWorkers=1",
				],
				{ cwd, stdio: "inherit", timeout: 60_000 },
			);
			assert.ifError(run.error);
			assert.equal(run.status, 0, `GREEN round ${round}/${rounds} failed`);
			const result = JSON.parse(readFileSync(report, "utf8")) as {
				testResults: Array<{
					assertionResults: Array<{ fullName: string; status: string }>;
				}>;
			};
			const selected = result.testResults
				.flatMap((suite) => suite.assertionResults)
				.filter((test) => test.fullName.includes("production observation:"));
			assert.equal(
				selected.length,
				2,
				"GREEN must select direct sleep and delayed exec tests",
			);
			assert.ok(
				selected.every((test) => test.status === "passed"),
				"GREEN must execute both selected tests, not skip them",
			);
			console.log(
				`GREEN ${round}/${rounds} PASS (direct sleep + delayed exec)`,
			);
		}
		console.log(
			`GREEN complete: ${rounds}/${rounds} rounds, ${rounds * 2}/${rounds * 2} observation cases`,
		);
	} finally {
		rmSync(reportDir, { recursive: true, force: true });
	}
}
