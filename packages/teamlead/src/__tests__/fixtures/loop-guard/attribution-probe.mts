/** QA host: pnpm exec tsx packages/teamlead/src/__tests__/fixtures/loop-guard/attribution-probe.mts */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
	assert.deepEqual(result, { code: null, signal: "SIGKILL" });
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
	for (let round = 1; round <= 20; round += 1) {
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
				"production kill:",
			],
			{ cwd, stdio: "inherit", timeout: 60_000 },
		);
		assert.ifError(run.error);
		assert.equal(run.status, 0, `GREEN round ${round}/20 failed`);
		console.log(`GREEN ${round}/20 PASS (direct sleep + delayed exec)`);
	}
	console.log("GREEN complete: 20/20 rounds, 40/40 kill cases");
}
