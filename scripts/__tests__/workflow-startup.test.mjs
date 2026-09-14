import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");

function validateWiring(workflow) {
	const quick = workflow.jobs["quick-gate"];
	assert.equal(quick.if, undefined);
	assert.equal(quick["continue-on-error"], undefined);
	const step = quick.steps.find((entry) =>
		entry.run?.includes("node scripts/check-workflow-startup.mjs"),
	);
	assert.ok(step);
	assert.equal(step.if, undefined);
	assert.equal(step["continue-on-error"], undefined);
	assert.match(step.run, /sha256sum -c -/);
	assert.match(step.run, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
	assert.match(
		step.run,
		/8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/,
	);
	assert.match(
		step.run,
		/node --test scripts\/__tests__\/workflow-startup\.test\.mjs/,
	);
	assert.ok(workflow.jobs["ci-ok"].needs.includes("quick-gate"));
	assert.match(
		workflow.jobs["ci-ok"].steps[0].run,
		/\$needs\["quick-gate"\]\.result == "success"/,
	);
}

test("startup guard is mandatory in the CI OK dependency chain", () => {
	const workflow = parse(
		fs.readFileSync(
			new URL("../../.github/workflows/ci.yml", import.meta.url),
			"utf8",
		),
	);
	validateWiring(workflow);
	for (const mutate of [
		(w) => {
			w.jobs["quick-gate"].if = "false";
		},
		(w) => {
			w.jobs["quick-gate"]["continue-on-error"] = true;
		},
		(w) => {
			w.jobs["quick-gate"].steps = w.jobs["quick-gate"].steps.filter(
				(s) => !s.run?.includes("node scripts/check-workflow-startup.mjs"),
			);
		},
		(w) => {
			w.jobs["quick-gate"].steps.find((s) =>
				s.run?.includes("node scripts/check-workflow-startup.mjs"),
			).if = "false";
		},
		(w) => {
			w.jobs["quick-gate"].steps.find((s) =>
				s.run?.includes("node scripts/check-workflow-startup.mjs"),
			)["continue-on-error"] = true;
		},
	]) {
		const changed = structuredClone(workflow);
		mutate(changed);
		assert.throws(() => validateWiring(changed));
	}
});

const checker = fileURLToPath(
	new URL("../check-workflow-startup.mjs", import.meta.url),
);
const valid =
	"on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ready\n";

test("required validator accepts workflows and rejects startup regressions", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2534-"));
	try {
		fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
		assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
		const file = path.join(root, ".github/workflows/test.yaml");
		fs.writeFileSync(file, valid);
		assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
		const check = () =>
			spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
		let result = check();
		assert.equal(result.status, 0, result.stdout + result.stderr);
		for (const [name, source] of [
			[
				"illegal job env",
				valid.replace(
					"    steps:",
					"    env:\n      BAD: ${{ runner.temp }}\n    steps:",
				),
			],
			["malformed YAML", "on: [push\njobs: {}"],
			["empty jobs", "on: push\njobs: {}\n"],
			["missing jobs", "on: push\n"],
			["unknown jobs key", valid.replace("jobs:", "jbos:")],
			["unknown on key", valid.replace("on:", "onn:")],
			[
				"bad top queue",
				`${valid}concurrency:\n  group: publish\n  queue: min\n`,
			],
			[
				"bad job queue",
				valid.replace(
					"    steps:",
					"    concurrency:\n      group: publish\n      queue: min\n    steps:",
				),
			],
			[
				"cancelled queue",
				`${valid}concurrency:\n  group: publish\n  queue: max\n  cancel-in-progress: true\n`,
			],
			[
				"misspelled queue",
				`${valid}concurrency:\n  group: publish\n  queu: max\n`,
			],
		]) {
			fs.writeFileSync(file, source);
			result = check();
			assert.notEqual(result.status, 0, name);
			assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/, name);
		}
		fs.writeFileSync(
			file,
			`${valid}concurrency:\n  group: publish\n  queue: max\n  cancel-in-progress: false\n`,
		);
		result = check();
		assert.equal(result.status, 0, result.stdout + result.stderr);
		fs.writeFileSync(
			file,
			valid.replace(
				"    steps:",
				"    concurrency:\n      group: publish\n      queue: max\n    steps:",
			),
		);
		result = check();
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		result = spawnSync(process.execPath, [checker], {
			cwd: root,
			env: { ...process.env, PATH: bin },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /actionlint.*ENOENT/);
		fs.writeFileSync(path.join(bin, "actionlint"), "#!/bin/sh\necho 1.7.11\n", {
			mode: 0o755,
		});
		result = spawnSync(process.execPath, [checker], {
			cwd: root,
			env: { ...process.env, PATH: bin },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /actionlint 1.7.12 required/);
		fs.writeFileSync(
			path.join(root, ".github/workflows/second.yml"),
			"on: push\njobs: {}\n",
		);
		assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
		assert.notEqual(
			check().status,
			0,
			"all tracked yml and yaml files are checked",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("trusted receiver initialization reaches later steps with the same path", () => {
	const workflow = parse(
		fs.readFileSync(
			new URL(
				"../../.github/workflows/payload-beta-release.yml",
				import.meta.url,
			),
			"utf8",
		),
	);
	const job = workflow.jobs["beta-release"];
	assert.equal(job.env?.TRUSTED_BETA_ROOT, undefined);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2534 receiver "));
	try {
		const envFile = path.join(root, "env");
		const result = spawnSync("bash", ["-euc", job.steps[0].run], {
			env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: envFile },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			fs.readFileSync(envFile, "utf8"),
			`TRUSTED_BETA_ROOT=${root}/beta-receiver\n`,
		);
		const consumers = job.steps
			.slice(1)
			.filter((step) =>
				/TRUSTED_BETA_ROOT/.test(step.run ?? step.with?.script ?? ""),
			);
		assert.equal(consumers.length, 4);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const queueException =
	'^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$';

test("beta workflow passes expression-context validation", () => {
	const result = spawnSync(
		"actionlint",
		[
			"-shellcheck=",
			"-pyflakes=",
			"-ignore",
			queueException,
			".github/workflows/payload-beta-release.yml",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
