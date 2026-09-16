import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function execute(args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn("pnpm", args, {
			stdio: "inherit",
			env: { ...process.env, ...env },
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

// Separate invocations keep the serial phase's pool at one isolated fork.
// Vitest 3 pool capacity is global, so per-project maxForks is insufficient.
export async function runShard(shard, run = execute) {
	if (!/^--shard=[1-4]\/4$/.test(shard ?? ""))
		throw new Error("Expected --shard=k/4");
	let exit = 0;
	for (const [project, forks] of [
		["serial", "1"],
		["parallel", "2"],
	]) {
		console.log(`Teamlead ${shard}: ${project}, maxForks=${forks}`);
		const code = await run(
			[
				"--filter",
				"flywheel-teamlead",
				"test:run",
				`--project=${project}`,
				shard,
				// The dedicated CI job owns this wall-clock performance gate.
				"--exclude=src/ship-judgment/__tests__/observation-performance.test.ts",
			],
			{
				VITEST_MAX_FORKS: forks,
				VITEST_MIN_FORKS: "1",
			},
		);
		if (code !== 0) exit = 1;
	}
	return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = await runShard(process.argv[2]);
