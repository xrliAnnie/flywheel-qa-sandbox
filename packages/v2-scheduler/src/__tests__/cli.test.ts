import { describe, expect, it } from "vitest";
import { parseSchedulerCliArgs } from "../cli.js";

describe("scheduler-once CLI", () => {
	it("requires an explicit single backend and absolute runtime paths", () => {
		expect(
			parseSchedulerCliArgs([
				"--db",
				"/tmp/flywheel-v2.db",
				"--project",
				"flywheel",
				"--backend",
				"launchd",
				"--gate-bin",
				"/repo/scripts/restart-storm-gate.py",
				"--uid",
				"501",
				"--run-id",
				"run-1",
			]),
		).toMatchObject({
			dbPath: "/tmp/flywheel-v2.db",
			projectName: "flywheel",
			backend: "launchd",
			gateBin: "/repo/scripts/restart-storm-gate.py",
			uid: 501,
			runId: "run-1",
		});
		for (const argv of [
			[
				"--db",
				"relative.db",
				"--project",
				"flywheel",
				"--backend",
				"launchd",
				"--gate-bin",
				"/gate.py",
			],
			[
				"--db",
				"/tmp/db",
				"--project",
				"flywheel",
				"--backend",
				"fallback",
				"--gate-bin",
				"/gate.py",
			],
			[
				"--db",
				"/tmp/db",
				"--project",
				"../bad",
				"--backend",
				"launchd",
				"--gate-bin",
				"/gate.py",
			],
		]) {
			expect(() => parseSchedulerCliArgs(argv)).toThrow();
		}
	});

	it("keeps receipt inspection and probe modes explicit", () => {
		expect(
			parseSchedulerCliArgs([
				"--db",
				"/tmp/flywheel-v2.db",
				"--check-receipt-after",
				"2026-07-27T00:00:00.000Z",
			]),
		).toEqual({
			mode: "check-receipt",
			dbPath: "/tmp/flywheel-v2.db",
			afterIso: "2026-07-27T00:00:00.000Z",
		});
		expect(
			parseSchedulerCliArgs([
				"--db",
				"/tmp/flywheel-v2.db",
				"--backend",
				"launchd",
				"--probe",
				"--run-id",
				"probe-1",
			]),
		).toMatchObject({
			mode: "probe",
			backend: "launchd",
			runId: "probe-1",
		});
	});
});
