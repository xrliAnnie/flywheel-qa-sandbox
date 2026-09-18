import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAttempt, summarizeRun } from "../package-gate.mjs";
import { createReceipt } from "../package-gate-reporter.mjs";

const rpc = { message: '[vitest-worker]: Timeout calling "onTaskUpdate"' };
const passing = () => ({
	filepath: "/test/a.test.ts",
	mode: "run",
	result: { state: "pass" },
	tasks: [{ type: "test", mode: "run", result: { state: "pass" } }],
});
const receipt = (files = [passing()], errors = [rpc]) =>
	createReceipt(["/test/a.test.ts"], files, errors, "failed");

test("only complete RPC-only failures qualify; raw failure stays non-green", () => {
	assert.equal(classifyAttempt(1, null, receipt()), "worker_rpc_timeout");
	assert.equal(classifyAttempt(0, null, receipt()), "passed");
	assert.equal(classifyAttempt(2, null, receipt()), "failed");
	assert.equal(classifyAttempt(null, "SIGTERM", receipt()), "failed");
	assert.equal(classifyAttempt(1, null, null), "failed");
	assert.equal(classifyAttempt(1, null, receipt([passing()], [])), "failed");
	assert.equal(
		classifyAttempt(1, null, receipt([passing()], [rpc, { message: "other" }])),
		"failed",
	);
});

test("lost results, missing modules, suite errors and real assertions fail closed", () => {
	for (const state of ["run", "queued", undefined, "fail", "skip"]) {
		const file = passing();
		file.tasks[0].result = state ? { state } : undefined;
		assert.equal(
			classifyAttempt(1, null, receipt([file])),
			"failed",
			String(state),
		);
	}
	const file = passing();
	file.tasks.push({ type: "test", mode: "run", result: { state: "fail" } });
	assert.equal(classifyAttempt(1, null, receipt([file])), "failed");
	assert.equal(classifyAttempt(1, null, receipt([])), "failed");
	const broken = passing();
	broken.result.errors = [{ message: "collection failed" }];
	assert.equal(classifyAttempt(1, null, receipt([broken])), "failed");
	assert.equal(
		classifyAttempt(1, null, { ...receipt(), reason: "interrupted" }),
		"failed",
	);
});

test("declared skip/todo are terminal; runtime missing results are not", () => {
	const file = passing();
	file.tasks.push(
		{ type: "test", mode: "skip" },
		{ type: "test", mode: "todo" },
	);
	assert.equal(classifyAttempt(1, null, receipt([file])), "worker_rpc_timeout");
	assert.equal(
		classifyAttempt(1, null, { ...receipt([file]), complete: false }),
		"failed",
	);
});

test("run status never converts a real package failure to artifact", () => {
	assert.deepEqual(summarizeRun(["passed", "worker_rpc_timeout"]), {
		status: "artifact",
		exitCode: 2,
	});
	assert.deepEqual(summarizeRun(["passed", "failed", "worker_rpc_timeout"]), {
		status: "failed",
		exitCode: 1,
	});
	assert.deepEqual(summarizeRun(["passed"]), { status: "passed", exitCode: 0 });
});

// Execute a fake pnpm process so orchestration (not just the classifier) is proved.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../package-gate.mjs";

function createSupervisorFixture({
	root,
	workerResult,
	supervisorExitCode,
	supervisorResultContent,
}) {
	const stateRoot = join(root, "state");
	const resultDirectory = join(root, "receipts", "worker-receipt");
	mkdirSync(stateRoot, { recursive: true });
	mkdirSync(resultDirectory, { recursive: true });
	writeFileSync(
		join(stateRoot, "control.json"),
		JSON.stringify({
			schemaVersion: 1,
			mode: "enabled",
			generation: "test-generation",
		}),
	);
	const result = {
		schemaVersion: 1,
		directory: resultDirectory,
		root,
		head: null,
		startedAt: "2026-09-18T00:00:00.000Z",
		finishedAt: "2026-09-18T00:00:01.000Z",
		packages: [],
		...workerResult,
	};
	writeFileSync(
		join(resultDirectory, "summary.json"),
		`${JSON.stringify(result)}\n`,
	);
	const supervisor = join(root, "fake-supervisor");
	const resultContent =
		supervisorResultContent === undefined
			? `${JSON.stringify(result)}\n`
			: supervisorResultContent;
	const writeResult =
		resultContent === null
			? ""
			: `fs.writeFileSync(args[index+1],${JSON.stringify(resultContent)});`;
	writeFileSync(
		supervisor,
		`#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);const index=args.indexOf("--result-path");${writeResult}process.exit(${supervisorExitCode});\n`,
		{ mode: 0o755 },
	);
	return { stateRoot, resultDirectory, supervisor };
}

test("build barrier, once-only retry, downstream execution and receipts", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-test-"));
	try {
		for (const name of ["a", "b"]) {
			mkdirSync(join(root, "packages", name), { recursive: true });
			writeFileSync(
				join(root, "packages", name, "package.json"),
				JSON.stringify({ name, scripts: { "test:run": "vitest run" } }),
			);
		}
		const fake = join(root, "pnpm");
		writeFileSync(
			fake,
			`#!/usr/bin/env node\nconst fs=require('fs');const path=require('path');const args=process.argv.slice(2);fs.appendFileSync(path.join(process.cwd(),'commands'),JSON.stringify(args)+'\\n');if(args[0]==='-r'){fs.writeFileSync('built','yes');process.exit(0);}if(!fs.existsSync('built'))process.exit(9);const pkg=args[1];if(pkg==='a'){const output=args.find(arg=>arg.startsWith('--outputFile='));if(output)fs.writeFileSync(output.slice(13),${JSON.stringify(JSON.stringify(receipt()))});process.exit(1);}process.exit(0);\n`,
			{ mode: 0o755 },
		);
		const result = await runGate({
			root,
			pnpm: fake,
			receiptRoot: join(root, "receipts"),
			quiet: true,
			environment: { FLYWHEEL_PACKAGE_GATE_HOST_LIMIT: "0" },
		});
		assert.equal(result.exitCode, 2);
		assert.equal(result.status, "artifact");
		const commands = readFileSync(join(root, "commands"), "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.deepEqual(
			commands.map((args) => (args[0] === "-r" ? "build" : args[1])),
			["build", "a", "a", "b"],
		);
		const stored = JSON.parse(
			readFileSync(join(result.directory, "summary.json"), "utf8"),
		);
		assert.equal(stored.packages[0].attempts.length, 2);
		assert.equal(stored.packages[0].attempts[1].exitCode, 1);
		assert.equal(stored.packages[1].status, "passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("supervisor failure cannot turn a successful worker receipt green", async () => {
	for (const supervisorExitCode of [1, 70, 130, 143]) {
		const root = mkdtempSync(join(tmpdir(), "package-gate-supervisor-exit-"));
		try {
			const fixture = createSupervisorFixture({
				root,
				workerResult: { status: "passed", exitCode: 0 },
				supervisorExitCode,
			});
			const result = await runGate({
				root,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment: {},
				hostQueue: { stateRoot: fixture.stateRoot },
				python: fixture.supervisor,
			});
			assert.equal(
				result.status,
				"failed",
				`supervisor exit ${supervisorExitCode}`,
			);
			assert.equal(
				result.exitCode,
				[130, 143].includes(supervisorExitCode) ? supervisorExitCode : 1,
				`supervisor exit ${supervisorExitCode}`,
			);
			assert.equal(
				result.failureKind,
				"host_queue",
				`supervisor exit ${supervisorExitCode}`,
			);
			const stored = JSON.parse(
				readFileSync(join(fixture.resultDirectory, "summary.json"), "utf8"),
			);
			assert.equal(stored.status, "failed");
			assert.equal(stored.exitCode, result.exitCode);
			assert.equal(stored.failureKind, "host_queue");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("matching supervisor exit preserves worker pass, failure, and RPC artifact receipts", async () => {
	for (const workerResult of [
		{ status: "passed", exitCode: 0 },
		{ status: "failed", exitCode: 1 },
		{ status: "artifact", exitCode: 2 },
	]) {
		const root = mkdtempSync(join(tmpdir(), "package-gate-supervisor-match-"));
		try {
			const fixture = createSupervisorFixture({
				root,
				workerResult,
				supervisorExitCode: workerResult.exitCode,
			});
			const result = await runGate({
				root,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment: {},
				hostQueue: { stateRoot: fixture.stateRoot },
				python: fixture.supervisor,
			});
			assert.equal(result.status, workerResult.status);
			assert.equal(result.exitCode, workerResult.exitCode);
			assert.equal(result.failureKind, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

for (const [scenario, supervisorResultContent, reason] of [
	["missing", null, "host_supervisor_result_missing"],
	["malformed", "{not-json", "host_supervisor_result_invalid"],
]) {
	test(`${scenario} supervisor result fails closed with a diagnostic receipt`, async () => {
		const root = mkdtempSync(
			join(tmpdir(), `package-gate-supervisor-${scenario}-`),
		);
		try {
			const fixture = createSupervisorFixture({
				root,
				workerResult: { status: "passed", exitCode: 0 },
				supervisorExitCode: 0,
				supervisorResultContent,
			});
			const result = await runGate({
				root,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment: {},
				hostQueue: { stateRoot: fixture.stateRoot },
				python: fixture.supervisor,
			});
			assert.equal(result.status, "failed");
			assert.equal(result.exitCode, 1);
			assert.equal(result.failureKind, "host_queue");
			assert.equal(result.hostQueue.reason, reason);
			assert.deepEqual(
				JSON.parse(
					readFileSync(join(result.directory, "summary.json"), "utf8"),
				),
				result,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of [
	"assertion",
	"other-error",
	"build-failure",
	"non-vitest",
]) {
	test(`orchestrator preserves ${scenario} failure and remaining evidence`, async () => {
		const root = mkdtempSync(join(tmpdir(), "package-gate-negative-"));
		try {
			for (const name of ["a", "b"]) {
				mkdirSync(join(root, "packages", name), { recursive: true });
				writeFileSync(
					join(root, "packages", name, "package.json"),
					JSON.stringify({
						name,
						scripts: {
							"test:run":
								scenario === "non-vitest" ? "node --test" : "vitest run",
						},
					}),
				);
			}
			const failed = receipt();
			if (scenario === "assertion") failed.failed = 1;
			else failed.errors.push({ message: "unexpected rejection" });
			const fake = join(root, "pnpm");
			writeFileSync(
				fake,
				`#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync('commands',JSON.stringify(args)+'\\n');if(args[0]==='-r')process.exit(${scenario === "build-failure" ? 1 : 0});if(args[1]==='a'){const output=args.find(arg=>arg.startsWith('--outputFile='));if(output)fs.writeFileSync(output.slice(13),${JSON.stringify(JSON.stringify(failed))});process.exit(1);}process.exit(0);\n`,
				{ mode: 0o755 },
			);
			const result = await runGate({
				root,
				pnpm: fake,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment: { FLYWHEEL_PACKAGE_GATE_HOST_LIMIT: "0" },
			});
			assert.equal(result.exitCode, 1);
			const commands = readFileSync(join(root, "commands"), "utf8")
				.trim()
				.split("\n")
				.map(JSON.parse);
			assert.deepEqual(
				commands.map((args) => (args[0] === "-r" ? "build" : args[1])),
				scenario === "build-failure" ? ["build"] : ["build", "a", "b"],
			);
			if (scenario === "non-vitest")
				assert.ok(
					commands.every(
						(args) => !args.some((arg) => arg.startsWith("--reporter")),
					),
				);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

import { fileURLToPath } from "node:url";

test("root package gate invokes receipt orchestrator", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		manifest.scripts["test:packages:run"],
		"node scripts/package-gate.mjs",
	);
});

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const requireVitest = createRequire(
	new URL("../../packages/core/package.json", import.meta.url),
);
test("real Vitest reporter captures full results and distinguishes injected RPC from assertion failure", () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-vitest-"));
	try {
		for (const scenario of ["pass", "rpc", "assertion"]) {
			writeFileSync(
				join(root, "case.test.js"),
				`test('case',()=>{expect(1).toBe(${scenario === "assertion" ? 2 : 1});${scenario === "rpc" ? `process.emit('unhandledRejection',new Error(${JSON.stringify(rpc.message)}));` : ""}});`,
			);
			const report = join(root, `${scenario}.json`);
			const run = spawnSync(
				process.execPath,
				[
					requireVitest.resolve("vitest/vitest.mjs"),
					"run",
					"--root",
					root,
					"--globals",
					"--maxWorkers=1",
					"--minWorkers=1",
					`--outputFile=${report}`,
					`--reporter=${fileURLToPath(new URL("../package-gate-reporter.mjs", import.meta.url))}`,
				],
				{
					env: process.env,
					encoding: "utf8",
				},
			);
			const actual = JSON.parse(readFileSync(report, "utf8"));
			assert.equal(
				classifyAttempt(run.status, run.signal, actual),
				scenario === "pass"
					? "passed"
					: scenario === "rpc"
						? "worker_rpc_timeout"
						: "failed",
				run.stderr,
			);
			assert.equal(actual.complete, true);
			assert.equal(actual.files, 1);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("heavy package configs bound the worker pool without changing assertion timeouts", () => {
	for (const pkg of ["teamlead", "claude-runner"]) {
		const config = new URL(
			`../../packages/${pkg}/vitest.config.ts`,
			import.meta.url,
		).href;
		const run = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`import assert from 'node:assert/strict'; const {default:config}=await import(${JSON.stringify(config)}); assert.equal(config.test.pool,'forks'); assert.deepEqual(config.test.poolOptions.forks,{minForks:1,maxForks:1}); assert.equal(config.test.teardownTimeout,60000); assert.equal(config.test.testTimeout,undefined); assert.equal(config.test.hookTimeout,undefined);`,
			],
			{ encoding: "utf8" },
		);
		assert.equal(run.status, 0, run.stderr);
	}
});

test("all active runner package gates state the bounded equivalent receipt route", () => {
	for (const name of ["implement", "engineer", "qa"]) {
		const text = readFileSync(
			new URL(`../../.flywheel/agents/nodes/${name}.md`, import.meta.url),
			"utf8",
		);
		assert.ok(text.includes("aggregate green OR"), name);
		assert.ok(text.includes("zero assertion failures"), name);
		assert.ok(
			text.includes("VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run"),
			name,
		);
		assert.ok(text.includes("PACKAGE_GATE_RECEIPT"), name);
		assert.ok(text.includes("no Lead ruling"), name);
	}
});

test("malformed package metadata cannot silently remove a package from the gate", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-manifest-"));
	try {
		for (const name of ["a", "b"])
			mkdirSync(join(root, "packages", name), { recursive: true });
		writeFileSync(
			join(root, "packages/a/package.json"),
			JSON.stringify({ name: "a", scripts: { "test:run": "node --test" } }),
		);
		writeFileSync(join(root, "packages/b/package.json"), "{broken");
		const fake = join(root, "pnpm");
		writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", {
			mode: 0o755,
		});
		await assert.rejects(
			runGate({
				root,
				pnpm: fake,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment: { FLYWHEEL_PACKAGE_GATE_HOST_LIMIT: "0" },
			}),
			SyntaxError,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit local bypass is visible and never invokes the Python supervisor", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-bypass-"));
	try {
		mkdirSync(join(root, "packages", "a"), { recursive: true });
		writeFileSync(
			join(root, "packages", "a", "package.json"),
			JSON.stringify({ name: "a", scripts: { "test:run": "node --test" } }),
		);
		const fake = join(root, "pnpm");
		writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", {
			mode: 0o755,
		});
		const messages = [];
		const result = await runGate({
			root,
			pnpm: fake,
			receiptRoot: join(root, "receipts"),
			quiet: true,
			environment: { FLYWHEEL_PACKAGE_GATE_HOST_LIMIT: "0" },
			python: "/missing/python3",
			statusSink: (message) => messages.push(message),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.hostQueue, {
			state: "bypassed",
			reason: "environment_disabled",
		});
		assert.deepEqual(messages, [
			"PACKAGE_GATE_HOST_BYPASS reason=environment_disabled\n",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const environment of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
	test(`CI bypass ${JSON.stringify(environment)} never invokes Python or the host ledger`, async () => {
		const root = mkdtempSync(join(tmpdir(), "package-gate-ci-"));
		try {
			mkdirSync(join(root, "packages", "a"), { recursive: true });
			writeFileSync(
				join(root, "packages", "a", "package.json"),
				JSON.stringify({ name: "a", scripts: { "test:run": "node --test" } }),
			);
			const fake = join(root, "pnpm");
			writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", {
				mode: 0o755,
			});
			const result = await runGate({
				root,
				pnpm: fake,
				receiptRoot: join(root, "receipts"),
				quiet: true,
				environment,
				python: "/missing/python3",
				statusSink: () => {},
			});
			assert.equal(result.exitCode, 0);
			assert.equal(result.hostQueue.reason, "ci");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("missing host control defaults disabled and does not require Python", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-control-default-"));
	try {
		mkdirSync(join(root, "packages", "a"), { recursive: true });
		const stateRoot = join(root, "state");
		mkdirSync(stateRoot);
		writeFileSync(
			join(root, "packages", "a", "package.json"),
			JSON.stringify({ name: "a", scripts: { "test:run": "node --test" } }),
		);
		const fake = join(root, "pnpm");
		writeFileSync(fake, "#!/usr/bin/env node\nprocess.exit(0);\n", {
			mode: 0o755,
		});
		const messages = [];
		const result = await runGate({
			root,
			pnpm: fake,
			receiptRoot: join(root, "receipts"),
			quiet: true,
			environment: {},
			hostQueue: { stateRoot },
			python: "/missing/python3",
			statusSink: (message) => messages.push(message),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.hostQueue, {
			state: "bypassed",
			reason: "host_control_disabled",
		});
		assert.deepEqual(messages, [
			"PACKAGE_GATE_HOST_BYPASS reason=host_control_disabled\n",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
