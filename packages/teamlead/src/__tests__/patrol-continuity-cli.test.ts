import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPatrolContinuity } from "../patrol-continuity-cli.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("patrol helper CLI", () => {
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
