import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAcceptance } from "../qa-package-gate-host.mjs";

const heads = ["a", "b", "c", "d", "e", "f"];
function manifest() {
	const service = [100, 120, 80, 90, 110, 100];
	return {
		schemaVersion: 1,
		preflight: { liveRequests: [], legacyGateProcesses: 0 },
		psBeforePath: "ps-before.jsonl",
		psAfterPath: "ps-after.jsonl",
		workloads: service.map((duration, index) => ({
			id: `gate-${index + 1}`,
			worktree: `/tmp/worktree-${index + 1}`,
			baselineMs: [duration, duration],
			frozen: {
				head: heads[index].repeat(40),
				dirtyHash: "0".repeat(64),
				lockfileHash: "1".repeat(64),
				nodeVersion: "v22.0.0",
				pnpmVersion: "10.15.1",
			},
			observed: {
				head: heads[index].repeat(40),
				dirtyHash: "0".repeat(64),
				lockfileHash: "1".repeat(64),
				nodeVersion: "v22.0.0",
				pnpmVersion: "10.15.1",
			},
		})),
		runs: [
			[1, 0, 0, 100],
			[2, 0, 0, 120],
			[3, 1, 100, 180],
			[4, 1, 120, 210],
			[5, 2, 180, 290],
			[6, 2, 210, 310],
		].map(([seq, submittedAtMs, admittedAtMs, finishedAtMs]) => ({
			id: `gate-${seq}`,
			seq,
			submittedAtMs,
			admittedAtMs,
			finishedAtMs,
			exitCode: 0,
			rpcArtifactCount: 0,
			receiptPath: `/tmp/receipt-${seq}/summary.json`,
		})),
	};
}

test("computes FIFO theoretical makespan and the 1.2 acceptance bound", () => {
	const result = evaluateAcceptance(manifest(), 2);
	assert.equal(result.status, "passed");
	assert.equal(result.theoreticalMs, 310);
	assert.equal(result.measuredMakespanMs, 310);
	assert.equal(result.thresholdMs, 372);
	assert.equal(result.totalWallMs, 310);
	assert.deepEqual(
		result.rows.map((row) => row.queueWaitMs),
		[0, 0, 99, 119, 178, 208],
	);
});

test("fails a run above the bound without hiding a clean package result", () => {
	const value = manifest();
	value.runs[5].finishedAtMs = 400;
	const result = evaluateAcceptance(value, 2);
	assert.equal(result.status, "failed");
	assert.ok(result.failures.includes("makespan_exceeds_1_2x_theoretical"));
});

test("rejects incomplete, drifted, contaminated, or RPC-artifact evidence", () => {
	const missing = manifest();
	missing.workloads.pop();
	assert.throws(() => evaluateAcceptance(missing, 2), /workloads_exactly_six/);

	const drifted = manifest();
	drifted.workloads[0].observed.head = "9".repeat(40);
	assert.throws(() => evaluateAcceptance(drifted, 2), /workload_drift/);

	const contaminated = manifest();
	contaminated.preflight.liveRequests.push("unknown-request");
	assert.throws(
		() => evaluateAcceptance(contaminated, 2),
		/preflight_not_idle/,
	);

	const rpc = manifest();
	rpc.runs[0].rpcArtifactCount = 1;
	const result = evaluateAcceptance(rpc, 2);
	assert.equal(result.status, "failed");
	assert.ok(result.failures.includes("rpc_artifact_present"));
});

test("capacity three uses the same frozen baselines with three virtual slots", () => {
	const value = manifest();
	value.runs = value.runs.map((run, index) => ({
		...run,
		submittedAtMs: index < 3 ? 0 : run.submittedAtMs,
		admittedAtMs: index < 3 ? 0 : [80, 90, 100][index - 3],
		finishedAtMs: [100, 120, 80, 170, 210, 200][index],
	}));
	const result = evaluateAcceptance(value, 3);
	assert.equal(result.theoreticalMs, 220);
	assert.equal(result.status, "passed");
});
