import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const collector = fileURLToPath(
	new URL("../collect-trial-data.mjs", import.meta.url),
);

function writeFakeGh(root) {
	const file = path.join(root, "fake-gh.mjs");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
const joined = args.join(" ");
if (
  process.env.GH_EXPECT_CANONICAL_WINDOW === "1" &&
  joined.includes("actions/workflows/") &&
  !joined.includes("created=2026-09-09T16:00:00.000Z..2026-09-10T16:00:00.000Z")
) {
  process.stderr.write("workflow window was not normalized to UTC: " + joined + "\\n");
  process.exit(4);
}
const run = {
  id: 123,
  run_attempt: 2,
  head_sha: "abc123",
  event: "pull_request",
  created_at: "2026-09-10T01:00:00Z",
  run_started_at: "2026-09-10T01:01:00Z",
  updated_at: "2026-09-10T01:03:00Z",
  status: "completed",
  conclusion: "success"
};
if (joined.includes(".total_count")) {
  process.stdout.write(process.env.GH_ZERO_RUNS === "1" ? "0\\n" : "1\\n");
} else if (joined.includes(".workflow_runs[]")) {
  if (process.env.GH_ZERO_RUNS !== "1") process.stdout.write(JSON.stringify(run) + "\\n");
} else if (joined.includes("/jobs?")) {
  if (process.env.GH_FAIL_AT === "jobs") {
    process.stdout.write(JSON.stringify({ id: 999 }) + "\\n");
    process.stderr.write("simulated jobs failure\\n");
    process.exit(2);
  }
  const attempt = joined.includes("/attempts/2/") ? 2 : 1;
  const job = {
    id: 900 + attempt,
    name: "Quick Gate",
    labels: ["ubuntu-latest"],
    runner_id: attempt,
    runner_name: "GitHub Actions " + attempt,
    created_at: "2026-09-10T01:01:00Z",
    started_at: "2026-09-10T01:02:00Z",
    completed_at: "2026-09-10T01:03:00Z",
    conclusion: "success"
  };
  if (process.env.GH_UNFINISHED === "1" && attempt === 2) {
    process.stdout.write(JSON.stringify({ ...job, completed_at: null, conclusion: null }) + "\\n");
  } else
  if (process.env.GH_DUPLICATE_JOBS === "1" && attempt === 2) {
    const carried = { ...job, id: 9901, runner_id: 1, runner_name: "GitHub Actions 1" };
    const rerun = {
      ...job,
      started_at: "2026-09-10T01:04:00Z",
      completed_at: "2026-09-10T01:05:00Z"
    };
    process.stdout.write(JSON.stringify(carried) + "\\n" + JSON.stringify(rerun) + "\\n");
  } else {
    process.stdout.write(JSON.stringify(job) + "\\n");
  }
} else if (/\\/attempts\\/[12](?:\\?|$)/.test(joined)) {
  const attempt = joined.includes("/attempts/2") ? 2 : 1;
  const detail = process.env.GH_UNFINISHED === "1" && attempt === 2
    ? { ...run, run_attempt: attempt, updated_at: null, status: "in_progress", conclusion: null }
    : { ...run, run_attempt: attempt };
  process.stdout.write(JSON.stringify(detail) + "\\n");
} else {
  process.stderr.write("unexpected gh invocation: " + joined + "\\n");
  process.exit(3);
}
`,
		{ mode: 0o755 },
	);
	return file;
}

function invoke(root, output, extraEnv = {}, overrides = {}) {
	const fakeGh = writeFakeGh(root);
	return spawnSync(
		process.execPath,
		[
			collector,
			"--repo",
			"xrliAnnie/flywheel",
			"--workflow",
			overrides.workflow ?? "ci.yml",
			"--start",
			overrides.start ?? "2026-09-10T00:00:00Z",
			"--end",
			overrides.end ?? "2026-09-11T00:00:00Z",
			"--phase",
			"GH-before",
			"--scope",
			"full",
			"--output",
			output,
		],
		{
			encoding: "utf8",
			env: { ...process.env, GH_BIN: fakeGh, ...extraEnv },
		},
	);
}

function readJsonl(file) {
	const source = fs.readFileSync(file, "utf8");
	if (source === "") return [];
	assert.ok(source.endsWith("\n"));
	return source
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
}

test("collector publishes one complete atomic snapshot with every attempt", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const runs = readJsonl(path.join(output, "runs.jsonl"));
		const jobs = readJsonl(path.join(output, "jobs.jsonl"));
		assert.deepEqual(
			runs.map((run) => [run.run_id, run.run_attempt, run.provider]),
			[
				[123, 1, "github"],
				[123, 2, "github"],
			],
		);
		assert.deepEqual(
			jobs.map((job) => [job.repo, job.run_id, job.run_attempt, job.job_id]),
			[
				["xrliAnnie/flywheel", 123, 1, 901],
				["xrliAnnie/flywheel", 123, 2, 902],
			],
		);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.complete, true);
		assert.equal(manifest.runAttempts, 2);
		assert.equal(manifest.jobs, 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector counts a carried partial-rerun job only once", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output, { GH_DUPLICATE_JOBS: "1" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const jobs = readJsonl(path.join(output, "jobs.jsonl"));
		assert.deepEqual(
			jobs.map((job) => [job.run_attempt, job.job_id]),
			[
				[1, 901],
				[2, 902],
			],
		);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.jobs, 2);
		assert.equal(manifest.duplicateJobsDropped, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector rejects time windows without an explicit UTC offset", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(
			root,
			output,
			{ TZ: "America/Los_Angeles" },
			{ start: "2026-09-10T00:00:00", end: "2026-09-11T00:00:00" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /explicit Z or numeric offset/);
		assert.equal(fs.existsSync(output), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector normalizes positive-offset windows before building the API query", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(
			root,
			output,
			{ GH_EXPECT_CANONICAL_WINDOW: "1" },
			{
				start: "2026-09-10T00:00:00+08:00",
				end: "2026-09-11T00:00:00+08:00",
			},
		);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector rejects workflow path traversal", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output, {}, { workflow: "../actions/secrets" });
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/workflow must be a positive id or workflow filename/,
		);
		assert.equal(fs.existsSync(output), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector marks a snapshot incomplete while runs or jobs are unfinished", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output, { GH_UNFINISHED: "1" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.complete, false);
		assert.equal(manifest.unfinishedRuns, 1);
		assert.equal(manifest.unfinishedJobs, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector writes valid empty JSONL files for an empty window", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output, { GH_ZERO_RUNS: "1" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.deepEqual(readJsonl(path.join(output, "runs.jsonl")), []);
		assert.deepEqual(readJsonl(path.join(output, "jobs.jsonl")), []);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.complete, true);
		assert.equal(manifest.listedRuns, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector failure leaves no partial output directory", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		const result = invoke(root, output, { GH_FAIL_AT: "jobs" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /simulated jobs failure/);
		assert.equal(fs.existsSync(output), false);
		assert.deepEqual(
			fs.readdirSync(root).filter((name) => name.startsWith(".fly2684-stage-")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("collector refuses to overwrite an existing receipt", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2684-collector-"));
	try {
		const output = path.join(root, "snapshot");
		fs.mkdirSync(output);
		fs.writeFileSync(path.join(output, "keep"), "original\n");
		const result = invoke(root, output);
		assert.notEqual(result.status, 0);
		assert.equal(
			fs.readFileSync(path.join(output, "keep"), "utf8"),
			"original\n",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
