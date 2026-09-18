#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const allowedPhases = new Set([
	"GH-before",
	"UBI-week",
	"GH-rollback",
	"canary",
]);
const allowedScopes = new Set(["full", "scoped", "docs", "reused"]);

function fail(message) {
	throw new Error(message);
}

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) {
			fail(`invalid argument near ${flag ?? "<end>"}`);
		}
		const key = flag.slice(2);
		if (key in values) fail(`duplicate --${key}`);
		values[key] = value;
	}
	for (const key of [
		"repo",
		"workflow",
		"start",
		"end",
		"phase",
		"scope",
		"output",
	]) {
		if (!values[key]) fail(`missing --${key}`);
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)) {
		fail("--repo must be owner/name");
	}
	if (!/^(?:[1-9]\d*|[A-Za-z0-9_.-]+\.ya?ml)$/.test(values.workflow)) {
		fail("--workflow must be a positive id or workflow filename");
	}
	if (!allowedPhases.has(values.phase)) fail("unsupported --phase");
	if (!allowedScopes.has(values.scope)) fail("unsupported --scope");
	const explicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i;
	if (!explicitOffset.test(values.start) || !explicitOffset.test(values.end)) {
		fail("--start and --end require an explicit Z or numeric offset");
	}
	const start = new Date(values.start);
	const end = new Date(values.end);
	if (
		!Number.isFinite(start.getTime()) ||
		!Number.isFinite(end.getTime()) ||
		start.getTime() >= end.getTime()
	) {
		fail("--start and --end must be an increasing ISO-8601 window");
	}
	return {
		...values,
		startDate: start,
		endDate: end,
		output: path.resolve(values.output),
	};
}

function callGh(ghBin, args) {
	const result = spawnSync(ghBin, args, {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error) fail(`could not execute gh: ${result.error.message}`);
	if (result.status !== 0) {
		fail(
			`gh failed (${result.status ?? "signal"}): ${result.stderr.trim() || "no stderr"}`,
		);
	}
	return result.stdout;
}

function parseJsonLines(source, label) {
	if (!source.trim()) return [];
	return source
		.trimEnd()
		.split("\n")
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				fail(
					`${label} line ${index + 1} is not compact JSON: ${error.message}`,
				);
			}
		});
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1)
		fail(`${label} must be a positive integer`);
	return number;
}

function providerFor(jobs) {
	const providers = new Set();
	for (const job of jobs) {
		const labels = Array.isArray(job.labels)
			? job.labels.map((label) => String(label).toLowerCase())
			: [];
		const name = String(job.runner_name ?? "").toLowerCase();
		if (
			labels.some((label) => label.startsWith("ubicloud")) ||
			name.includes("ubicloud")
		) {
			providers.add("ubicloud");
		} else if (
			labels.includes("ubuntu-latest") ||
			name.includes("github actions")
		) {
			providers.add("github");
		}
	}
	if (providers.size === 0) return "unknown";
	if (providers.size > 1) return "mixed";
	return [...providers][0];
}

function compactJsonl(records) {
	if (records.length === 0) return "";
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function executedJobFingerprint(runId, job) {
	if (!job.started_at || !job.completed_at) return null;
	return JSON.stringify([
		runId,
		job.name ?? null,
		job.started_at,
		job.completed_at,
		job.runner_id ?? null,
	]);
}

function collect(options) {
	const ghBin = process.env.GH_BIN || "gh";
	const created = `${options.startDate.toISOString()}..${options.endDate.toISOString()}`;
	const listEndpoint = `repos/${options.repo}/actions/workflows/${options.workflow}/runs?per_page=100&created=${created}`;
	const totalText = callGh(ghBin, [
		"api",
		listEndpoint,
		"--jq",
		".total_count",
	]);
	const totalCount = Number(totalText.trim());
	if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
		fail("GitHub returned an invalid workflow run total_count");
	}
	if (totalCount > 1000) {
		fail(
			"workflow run window exceeds 1000 results; split it into smaller UTC windows",
		);
	}
	const listedRuns = parseJsonLines(
		callGh(ghBin, [
			"api",
			"--paginate",
			listEndpoint,
			"--jq",
			".workflow_runs[] | tojson",
		]),
		"workflow runs",
	);
	if (listedRuns.length !== totalCount) {
		fail(
			`workflow run pagination incomplete: expected ${totalCount}, received ${listedRuns.length}`,
		);
	}
	const windowRuns = listedRuns.filter((run) => {
		const createdAt = new Date(run.created_at).getTime();
		if (!Number.isFinite(createdAt))
			fail(`run ${run.id ?? "unknown"} has invalid created_at`);
		return (
			createdAt >= options.startDate.getTime() &&
			createdAt < options.endDate.getTime()
		);
	});

	const runRecords = [];
	const jobRecords = [];
	const executedJobFingerprints = new Set();
	let duplicateJobsDropped = 0;
	for (const listed of windowRuns) {
		const runId = positiveInteger(listed.id, "run id");
		const latestAttempt = positiveInteger(
			listed.run_attempt,
			`run ${runId} attempt count`,
		);
		for (let attempt = 1; attempt <= latestAttempt; attempt += 1) {
			const attemptEndpoint = `repos/${options.repo}/actions/runs/${runId}/attempts/${attempt}`;
			const attemptRows = parseJsonLines(
				callGh(ghBin, ["api", attemptEndpoint]),
				`run ${runId} attempt ${attempt}`,
			);
			if (attemptRows.length !== 1)
				fail(`run ${runId} attempt ${attempt} did not return one object`);
			const detail = attemptRows[0];
			const jobsEndpoint = `${attemptEndpoint}/jobs?per_page=100`;
			const jobs = parseJsonLines(
				callGh(ghBin, [
					"api",
					"--paginate",
					jobsEndpoint,
					"--jq",
					".jobs[] | tojson",
				]),
				`run ${runId} attempt ${attempt} jobs`,
			);
			for (const job of jobs) {
				const fingerprint = executedJobFingerprint(runId, job);
				if (fingerprint && executedJobFingerprints.has(fingerprint)) {
					duplicateJobsDropped += 1;
					continue;
				}
				if (fingerprint) executedJobFingerprints.add(fingerprint);
				jobRecords.push({
					repo: options.repo,
					run_id: runId,
					run_attempt: attempt,
					job_id: positiveInteger(job.id, `run ${runId} job id`),
					name: job.name ?? null,
					labels: Array.isArray(job.labels) ? job.labels : [],
					runner_id: job.runner_id ?? null,
					runner_name: job.runner_name ?? null,
					created_at: job.created_at ?? null,
					started_at: job.started_at ?? null,
					completed_at: job.completed_at ?? null,
					conclusion: job.conclusion ?? null,
				});
			}
			runRecords.push({
				repo: options.repo,
				workflow_id:
					detail.workflow_id ?? listed.workflow_id ?? options.workflow,
				workflow_path: options.workflow,
				run_id: runId,
				run_attempt: attempt,
				head_sha: detail.head_sha ?? listed.head_sha ?? null,
				event: detail.event ?? listed.event ?? null,
				created_at: detail.created_at ?? listed.created_at ?? null,
				run_started_at: detail.run_started_at ?? listed.run_started_at ?? null,
				completed_at: detail.updated_at ?? null,
				status: detail.status ?? null,
				conclusion: detail.conclusion ?? null,
				scope: options.scope,
				provider: providerFor(jobs),
				trialPhase: options.phase,
			});
		}
	}
	return { runRecords, jobRecords, totalCount, duplicateJobsDropped };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (fs.existsSync(options.output))
		fail(`output already exists: ${options.output}`);
	const parent = path.dirname(options.output);
	if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
		fail(`output parent directory does not exist: ${parent}`);
	}
	const stage = fs.mkdtempSync(path.join(parent, ".fly2684-stage-"));
	try {
		const { runRecords, jobRecords, totalCount, duplicateJobsDropped } =
			collect(options);
		const unfinishedRuns = runRecords.filter(
			(run) => run.status !== "completed" || !run.completed_at,
		).length;
		const unfinishedJobs = jobRecords.filter(
			(job) => !job.completed_at || job.conclusion == null,
		).length;
		fs.writeFileSync(path.join(stage, "runs.jsonl"), compactJsonl(runRecords));
		fs.writeFileSync(path.join(stage, "jobs.jsonl"), compactJsonl(jobRecords));
		fs.writeFileSync(
			path.join(stage, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					complete: unfinishedRuns === 0 && unfinishedJobs === 0,
					repo: options.repo,
					workflow: options.workflow,
					start: options.start,
					end: options.end,
					trialPhase: options.phase,
					scope: options.scope,
					listedRuns: totalCount,
					runAttempts: runRecords.length,
					jobs: jobRecords.length,
					duplicateJobsDropped,
					unfinishedRuns,
					unfinishedJobs,
					collectedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
		);
		fs.renameSync(stage, options.output);
	} catch (error) {
		fs.rmSync(stage, { recursive: true, force: true });
		throw error;
	}
	process.stdout.write(`${options.output}\n`);
}

try {
	main();
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
