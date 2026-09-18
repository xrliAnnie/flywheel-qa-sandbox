import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	activityEvidence,
	runPatrolContinuity,
} from "../patrol-continuity-cli.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("patrol helper CLI", () => {
	it("projects verified package queue fields into machine evidence", () => {
		const line = activityEvidence(
			{
				key: "a".repeat(64),
				activity: "WAITING",
				reason: "package_gate_queue",
				last_change_basis: "baseline",
				interval_start: 1,
				interval_end: 2,
				branch_activity: false,
				last_change_epoch: 1,
				entry: {
					identity: { activationId: "activation:test" },
					refs: [],
					sourcesComplete: true,
					semanticDigest: "b".repeat(64),
					coverageSinceMs: 1_000,
					queueEvidence: {
						requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						status: "queued",
						seq: 1,
						position: 3,
						enqueuedAt: "2026-09-18T02:00:00.000Z",
						observedAt: "2026-09-18T02:01:05.000Z",
						revision: 2,
						waitMs: 65_000,
					},
				},
			} as never,
			"exec",
			2_000,
		)[0];
		expect(line).toContain(
			"queue_request=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa queue_position=3 queue_wait_seconds=65",
		);
	});
	it("validates reports without opening any production data source", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(
			path,
			"patrol_schema=2\nMECHANISM_REVIEW result=none count=0\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).toBe(0);
		writeFileSync(
			path,
			"patrol_schema=2\nMECHANISM_REVIEW result=findings count=1\nMECHANISM_DEFECT id=" +
				"a".repeat(64) +
				" step=2 class_key=" +
				"b".repeat(64) +
				" root_cause_ref=root counterexample_ref=counter\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).not.toBe(0);
	});
	it("rejects tampered machine identity and ref digests in report validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(
			path,
			"patrol_schema=2\nMECHANISM_REVIEW result=none count=0\nACTIVITY_RECORD " +
				JSON.stringify({
					id: "a".repeat(64),
					entry: { identity: { executionId: "fake" }, refs: [] },
					sampledAtMs: 1,
					activity: "ACTIVE",
					interval_start: 0,
					interval_end: 1,
				}) +
				"\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).not.toBe(0);
	});
	it("rejects duplicate or arbitrary loader options", async () => {
		expect(
			await runPatrolContinuity(["sample", "--module", "/tmp/evil.js"]),
		).not.toBe(0);
		expect(
			await runPatrolContinuity([
				"validate-report",
				"--report",
				"a",
				"--report",
				"b",
			]),
		).not.toBe(0);
	});
	it("fails closed when recheck has no exact machine record", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(path, "patrol_schema=2\n");
		expect(
			await runPatrolContinuity([
				"--recheck",
				"--report",
				path,
				"--evidence-id",
				"a".repeat(64),
			]),
		).not.toBe(0);
	});
});
