import { describe, expect, it } from "vitest";
import { parseSchedulerCliArgs } from "../cli.js";

const DATABASE_CONTRACT_ARGS = [
	"--db",
	"/tmp/flywheel-v2.db",
	"--marker",
	"/tmp/migration-complete.json",
	"--authority",
	"/tmp/cutover-authority.json",
	"--armed",
	"/tmp/cutover-armed.json",
	"--window",
	"window-1",
	"--epoch",
	"1",
] as const;

describe("scheduler-once CLI", () => {
	it("requires an explicit single backend and absolute runtime paths", () => {
		expect(
			parseSchedulerCliArgs([
				...DATABASE_CONTRACT_ARGS,
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
			markerPath: "/tmp/migration-complete.json",
			authorityPath: "/tmp/cutover-authority.json",
			armedPath: "/tmp/cutover-armed.json",
			windowId: "window-1",
			epoch: 1,
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
				...DATABASE_CONTRACT_ARGS.slice(2),
				"--project",
				"flywheel",
				"--backend",
				"launchd",
				"--gate-bin",
				"/gate.py",
			],
			[
				...DATABASE_CONTRACT_ARGS,
				"--project",
				"flywheel",
				"--backend",
				"fallback",
				"--gate-bin",
				"/gate.py",
			],
			[
				...DATABASE_CONTRACT_ARGS,
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
				...DATABASE_CONTRACT_ARGS,
				"--check-receipt-after",
				"2026-07-27T00:00:00.000Z",
			]),
		).toEqual({
			mode: "check-receipt",
			dbPath: "/tmp/flywheel-v2.db",
			markerPath: "/tmp/migration-complete.json",
			authorityPath: "/tmp/cutover-authority.json",
			armedPath: "/tmp/cutover-armed.json",
			windowId: "window-1",
			epoch: 1,
			afterIso: "2026-07-27T00:00:00.000Z",
		});
		expect(
			parseSchedulerCliArgs([
				...DATABASE_CONTRACT_ARGS,
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
