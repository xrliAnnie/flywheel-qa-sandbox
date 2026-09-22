#!/usr/bin/env node
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,100}$/;

function fail(reason) {
	throw new Error(reason);
}

function integer(value, minimum = 0) {
	return Number.isSafeInteger(value) && value >= minimum;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function sameFrozen(left, right) {
	return [
		"head",
		"dirtyHash",
		"lockfileHash",
		"nodeVersion",
		"pnpmVersion",
	].every((field) => left[field] === right[field]);
}

function validateWorkload(workload) {
	if (
		!workload ||
		!TOKEN.test(workload.id ?? "") ||
		typeof workload.worktree !== "string" ||
		!isAbsolute(workload.worktree) ||
		!Array.isArray(workload.baselineMs) ||
		workload.baselineMs.length < 2 ||
		!workload.baselineMs.every((value) => integer(value, 1)) ||
		!workload.frozen ||
		!workload.observed ||
		!SHA.test(workload.frozen.head ?? "") ||
		!DIGEST.test(workload.frozen.dirtyHash ?? "") ||
		!DIGEST.test(workload.frozen.lockfileHash ?? "") ||
		!/^v\d+\.\d+\.\d+/.test(workload.frozen.nodeVersion ?? "") ||
		!/^\d+\.\d+\.\d+/.test(workload.frozen.pnpmVersion ?? "")
	)
		fail("workload_invalid");
	if (!sameFrozen(workload.frozen, workload.observed))
		fail(`workload_drift:${workload.id}`);
}

function validateRun(run, workloadIds) {
	if (
		!run ||
		!workloadIds.has(run.id) ||
		!integer(run.seq, 1) ||
		!integer(run.submittedAtMs) ||
		!integer(run.admittedAtMs) ||
		!integer(run.finishedAtMs) ||
		run.submittedAtMs > run.admittedAtMs ||
		run.admittedAtMs > run.finishedAtMs ||
		!Number.isSafeInteger(run.exitCode) ||
		!integer(run.rpcArtifactCount) ||
		typeof run.receiptPath !== "string" ||
		!isAbsolute(run.receiptPath)
	)
		fail("run_invalid");
}

function theoreticalMakespan(rows, capacity) {
	const slots = Array(capacity).fill(0);
	for (const row of rows) {
		let slot = 0;
		for (let index = 1; index < slots.length; index++)
			if (slots[index] < slots[slot]) slot = index;
		slots[slot] += row.baselineMedianMs;
	}
	return Math.max(...slots);
}

export function evaluateAcceptance(manifest, capacity) {
	if (!manifest || manifest.schemaVersion !== 1) fail("manifest_invalid");
	if (![2, 3].includes(capacity)) fail("capacity_must_be_2_or_3");
	if (
		!manifest.preflight ||
		!Array.isArray(manifest.preflight.liveRequests) ||
		manifest.preflight.liveRequests.length !== 0 ||
		manifest.preflight.legacyGateProcesses !== 0
	)
		fail("preflight_not_idle");
	if (
		typeof manifest.psBeforePath !== "string" ||
		!manifest.psBeforePath ||
		typeof manifest.psAfterPath !== "string" ||
		!manifest.psAfterPath
	)
		fail("ps_evidence_missing");
	if (!Array.isArray(manifest.workloads) || manifest.workloads.length !== 6)
		fail("workloads_exactly_six");
	for (const workload of manifest.workloads) validateWorkload(workload);
	const workloadIds = new Set(manifest.workloads.map((row) => row.id));
	if (workloadIds.size !== 6) fail("workload_ids_not_unique");
	if (!Array.isArray(manifest.runs) || manifest.runs.length !== 6)
		fail("runs_exactly_six");
	for (const run of manifest.runs) validateRun(run, workloadIds);
	if (
		new Set(manifest.runs.map((row) => row.id)).size !== 6 ||
		new Set(manifest.runs.map((row) => row.seq)).size !== 6
	)
		fail("run_identity_not_unique");
	const workloadById = new Map(manifest.workloads.map((row) => [row.id, row]));
	const rows = [...manifest.runs]
		.sort((left, right) => left.seq - right.seq)
		.map((run) => {
			const workload = workloadById.get(run.id);
			return {
				id: run.id,
				seq: run.seq,
				worktree: workload.worktree,
				head: workload.frozen.head,
				baselineMedianMs: median(workload.baselineMs),
				submittedAtMs: run.submittedAtMs,
				admittedAtMs: run.admittedAtMs,
				finishedAtMs: run.finishedAtMs,
				queueWaitMs: run.admittedAtMs - run.submittedAtMs,
				serviceMs: run.finishedAtMs - run.admittedAtMs,
				totalMs: run.finishedAtMs - run.submittedAtMs,
				exitCode: run.exitCode,
				rpcArtifactCount: run.rpcArtifactCount,
				receiptPath: run.receiptPath,
			};
		});
	const theoreticalMs = theoreticalMakespan(rows, capacity);
	const firstSubmitted = Math.min(...rows.map((row) => row.submittedAtMs));
	const firstAdmitted = Math.min(...rows.map((row) => row.admittedAtMs));
	const lastFinished = Math.max(...rows.map((row) => row.finishedAtMs));
	const measuredMakespanMs = lastFinished - firstAdmitted;
	const thresholdMs = theoreticalMs * 1.2;
	const failures = [];
	if (measuredMakespanMs > thresholdMs)
		failures.push("makespan_exceeds_1_2x_theoretical");
	if (rows.some((row) => row.exitCode !== 0)) failures.push("gate_failed");
	if (rows.some((row) => row.rpcArtifactCount !== 0))
		failures.push("rpc_artifact_present");
	return {
		schemaVersion: 1,
		status: failures.length ? "failed" : "passed",
		capacity,
		theoreticalMs,
		measuredMakespanMs,
		thresholdMs,
		totalWallMs: lastFinished - firstSubmitted,
		failures,
		psBeforePath: manifest.psBeforePath,
		psAfterPath: manifest.psAfterPath,
		rows,
	};
}

function csv(result) {
	const fields = [
		"id",
		"seq",
		"worktree",
		"head",
		"baselineMedianMs",
		"submittedAtMs",
		"admittedAtMs",
		"finishedAtMs",
		"queueWaitMs",
		"serviceMs",
		"totalMs",
		"exitCode",
		"rpcArtifactCount",
		"receiptPath",
	];
	const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
	return `${fields.join(",")}\n${result.rows
		.map((row) => fields.map((field) => quote(row[field])).join(","))
		.join("\n")}\n`;
}

function writeAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, value, { mode: 0o600 });
	renameSync(temporary, path);
}

function parseArgs(argv) {
	if (argv[0] !== "evaluate") fail("usage");
	const values = {};
	for (let index = 1; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (
			!["--manifest", "--capacity", "--out"].includes(key) ||
			!value ||
			key in values
		)
			fail("usage");
		values[key] = value;
	}
	if (!values["--manifest"] || !values["--capacity"] || !values["--out"])
		fail("usage");
	return values;
}

export function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const manifestPath = resolve(args["--manifest"]);
	const output = resolve(args["--out"]);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	for (const evidence of [manifest.psBeforePath, manifest.psAfterPath]) {
		const path = isAbsolute(evidence)
			? evidence
			: resolve(dirname(manifestPath), evidence);
		if (!existsSync(path)) fail("ps_evidence_missing");
	}
	const result = evaluateAcceptance(manifest, Number(args["--capacity"]));
	mkdirSync(output, { recursive: true, mode: 0o700 });
	writeAtomic(
		join(output, "qa-evaluation.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	writeAtomic(join(output, `after-n${result.capacity}.csv`), csv(result));
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result.status === "passed" ? 0 : 1;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.exitCode = main();
	} catch (error) {
		process.stderr.write(
			`PACKAGE_GATE_QA_ERROR ${error instanceof Error ? error.message : "unknown"}\n`,
		);
		process.exitCode = 70;
	}
}
