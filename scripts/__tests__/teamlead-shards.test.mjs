import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceSpecs } from "../../packages/teamlead/vitest.shards.mjs";

test("balances measured costs, independent of input order, without dropping unknown files", () => {
	const specs = ["a", "b", "c", "d", "new"].map((moduleId) => ({ moduleId }));
	const costs = { a: 90, b: 80, c: 20, d: 10 };
	const bins = balanceSpecs(specs, 2, (spec) => costs[spec.moduleId] ?? 5);
	assert.deepEqual(
		bins.map((bin) => bin.map((s) => s.moduleId)),
		[
			["a", "d", "new"],
			["b", "c"],
		],
	);
	assert.deepEqual(
		balanceSpecs([...specs].reverse(), 2, (spec) => costs[spec.moduleId] ?? 5),
		bins,
	);
	assert.deepEqual(
		bins
			.flat()
			.map((s) => s.moduleId)
			.sort(),
		specs.map((s) => s.moduleId).sort(),
	);
	assert.equal(new Set(bins.flat()).size, specs.length);
});

test("every supplied Vitest specification is assigned once for every shard count", () => {
	const specs = Array.from({ length: 1028 }, (_, i) => ({
		moduleId: `file-${i}`,
	}));
	for (const count of [1, 3, 4, 7]) {
		const bins = balanceSpecs(specs, count, (spec) => spec.moduleId.length);
		assert.equal(bins.length, count);
		assert.equal(bins.flat().length, specs.length);
		assert.equal(new Set(bins.flat()).size, specs.length);
	}
	assert.throws(() => balanceSpecs(specs, 0, () => 1));
});

import { spawnSync } from "node:child_process";

test("teamlead uses the measured sequencer for the real Vitest shard command", () => {
	const config = new URL(
		"../../packages/teamlead/vitest.config.ts",
		import.meta.url,
	).href;
	const run = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`import assert from 'node:assert/strict'; const {default:config}=await import(${JSON.stringify(config)});assert.equal(config.test.sequence?.sequencer?.name,'TeamleadSequencer');`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(run.status, 0, run.stderr);
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import TeamleadSequencer from "../../packages/teamlead/vitest.shards.mjs";

const requireVitest = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
test("Vitest-discovered files form an exact disjoint four-shard partition", async () => {
	const root = fileURLToPath(
		new URL("../../packages/teamlead", import.meta.url),
	);
	// Vitest 3 list --filesOnly ignores --shard: use it only as discovery truth,
	// then invoke the configured sequencer on those exact specifications.
	const discovery = spawnSync(
		process.execPath,
		[requireVitest.resolve("vitest/vitest.mjs"), "list", "--filesOnly"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(discovery.status, 0, discovery.stderr);
	const paths = discovery.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((p) => p.replace(/^\[[^\]]+\]\s*/, ""));
	assert.ok(paths.length > 1000);
	const specs = paths.map((path) => ({ moduleId: join(root, path) }));
	const bins = [];
	for (let index = 1; index <= 4; index++)
		bins.push(
			await new TeamleadSequencer({
				config: { root, shard: { index, count: 4 } },
			}).shard(specs),
		);
	assert.deepEqual(
		bins
			.flat()
			.map((s) => s.moduleId)
			.sort(),
		specs.map((s) => s.moduleId).sort(),
	);
	assert.equal(new Set(bins.flat()).size, specs.length);
	const { filesMs, unknownFileMs } = JSON.parse(
		readFileSync(
			new URL("../../packages/teamlead/ci-test-costs.json", import.meta.url),
		),
	);
	const costs = bins.map((bin) =>
		bin.reduce(
			(sum, s) =>
				sum +
				(filesMs[relative(root, s.moduleId).replaceAll("\\", "/")] ??
					unknownFileMs),
			0,
		),
	);
	assert.ok(
		Math.max(...costs) - Math.min(...costs) <= unknownFileMs,
		JSON.stringify(costs),
	);
});

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

test("real Vitest --shard executes the weighted partition, not equal file counts", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "teamlead-shard-runtime-")),
	);
	try {
		const heavy = "src/__tests__/fly247-bash-suites.test.ts";
		const paths = [heavy, "src/a.test.ts", "src/b.test.ts", "src/c.test.ts"];
		for (const path of paths) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(
				join(root, path),
				"test('fixture',()=>expect(true).toBe(true));\n",
			);
		}
		const sequencer = new URL(
			"../../packages/teamlead/vitest.shards.mjs",
			import.meta.url,
		).href;
		writeFileSync(
			join(root, "vitest.config.mjs"),
			`import Sequencer from ${JSON.stringify(sequencer)}; export default {test:{globals:true,sequence:{sequencer:Sequencer},maxWorkers:1,minWorkers:1}};`,
		);
		const results = [];
		for (const index of [1, 2]) {
			const output = join(root, `shard-${index}.json`);
			const run = spawnSync(
				process.execPath,
				[
					requireVitest.resolve("vitest/vitest.mjs"),
					"run",
					`--shard=${index}/2`,
					"--reporter=json",
					`--outputFile=${output}`,
				],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			results.push(
				JSON.parse(readFileSync(output))
					.testResults.map((result) =>
						relative(root, result.name).replaceAll("\\", "/"),
					)
					.sort(),
			);
		}
		assert.deepEqual(results, [
			[heavy],
			["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CI defaults to one fork and uses the serial/parallel helper for each teamlead shard", () => {
	const workflow = requireVitest("yaml").parse(
		readFileSync(
			new URL("../../.github/workflows/ci.yml", import.meta.url),
			"utf8",
		),
	);
	assert.equal(workflow.jobs["unit-tests"].env?.VITEST_MAX_FORKS, "1");
	assert.equal(workflow.jobs["unit-tests"].env?.VITEST_MIN_FORKS, "1");
});

test("CI runs serial then parallel projects with bounded isolated forks, preserving failures", async () => {
	const { runShard } = await import("../teamlead-ci-shard.mjs");
	const calls = [];
	const exit = await runShard("--shard=2/4", async (args, env) => {
		calls.push({ args, env });
		return calls.length === 1 ? 1 : 0;
	});
	assert.equal(exit, 1);
	assert.equal(calls.length, 2);
	assert.deepEqual(
		calls.map((c) => c.args),
		[
			[
				"--filter",
				"flywheel-teamlead",
				"test:run",
				"--project=serial",
				"--shard=2/4",
				"--exclude=src/ship-judgment/__tests__/observation-performance.test.ts",
			],
			[
				"--filter",
				"flywheel-teamlead",
				"test:run",
				"--project=parallel",
				"--shard=2/4",
				"--exclude=src/ship-judgment/__tests__/observation-performance.test.ts",
			],
		],
	);
	assert.deepEqual(
		calls.map((c) => c.env.VITEST_MAX_FORKS),
		["1", "2"],
	);
	assert.ok(calls.every((c) => c.env.VITEST_MIN_FORKS === "1"));
	await assert.rejects(() => runShard("--shard=0/4", () => 0));
});

test("CI projects discover every test except the dedicated performance test", async () => {
	const root = fileURLToPath(
		new URL("../../packages/teamlead", import.meta.url),
	);
	const discover = (args = []) => {
		const run = spawnSync(
			process.execPath,
			[
				requireVitest.resolve("vitest/vitest.mjs"),
				"list",
				"--filesOnly",
				...args,
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(run.status, 0, run.stderr);
		// Named project prefixes are display metadata, not paths.
		return run.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((p) => p.replace(/^\[[^\]]+\]\s*/, ""));
	};
	const all = discover();
	const projects = [];
	const { runShard } = await import("../teamlead-ci-shard.mjs");
	await runShard("--shard=2/4", async (args) => {
		projects.push(discover(args.slice(3)));
		return 0;
	});
	const [serial, parallel] = projects;
	const performance =
		"src/ship-judgment/__tests__/observation-performance.test.ts";
	assert.ok(all.includes(performance));
	const expected = all.filter((path) => path !== performance);
	const workflow = requireVitest("yaml").parse(
		readFileSync(
			new URL("../../.github/workflows/ci.yml", import.meta.url),
			"utf8",
		),
	);
	assert.equal(
		workflow.jobs["unit-tests"].strategy.matrix.include.find(
			(job) => job.name === "observation performance",
		).cmd,
		`pnpm --filter flywheel-teamlead exec vitest run ${performance}`,
	);
	assert.ok(serial.length > 100);
	assert.ok(parallel.length > 500);
	assert.equal(new Set([...serial, ...parallel]).size, expected.length);
	assert.deepEqual([...serial, ...parallel].sort(), expected.sort());
	assert.ok(
		serial.some((p) => p.endsWith("automated-message-inventory.test.ts")),
	);
	const { filesMs } = JSON.parse(
		readFileSync(
			new URL("../../packages/teamlead/ci-test-costs.json", import.meta.url),
		),
	);
	assert.ok(serial.every((p) => filesMs[p] >= 2500));
	assert.ok(parallel.every((p) => !(filesMs[p] >= 2500)));
});

import { hasMutationFailures } from "../fly-2453-narrow-gate-mutations.mjs";

test("mutation evidence accepts default and project reporters but requires both assertion failures", () => {
	const mutant = { gate: "gate1", unitFailure: "blocks when machine fails" };
	for (const label of [
		"",
		" serial ",
		"|parallel| ",
		"\u001b[32m serial \u001b[0m",
	]) {
		const writer = ` FAIL  ${label}src/__tests__/StateStore.auto-narrow-approval.test.ts > QA writer-level three-gate negatives > gate1 negative: denied`;
		const unit = ` FAIL  ${label}src/auto-narrow/__tests__/eligibility.test.ts > eligibility > blocks when machine fails`;
		assert.equal(
			hasMutationFailures(`${writer}\n${unit}`, mutant),
			true,
			label,
		);
		assert.equal(hasMutationFailures(writer, mutant), false);
		assert.equal(hasMutationFailures(unit, mutant), false);
		assert.equal(
			hasMutationFailures(
				`${writer}\n${unit}`.replaceAll("FAIL", "PASS"),
				mutant,
			),
			false,
		);
		assert.equal(
			hasMutationFailures(
				`${writer}\n${unit}`.replaceAll("gate1 negative", "gate2 negative"),
				mutant,
			),
			false,
		);
	}
});
