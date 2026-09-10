import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseNonNegativeIntEnv,
	probeCommSignalsFromCommDb,
	probeQuietSignals,
	stuckCommActivityMs,
} from "../bridge/commdb-probes.js";

describe("comm probe cadence", () => {
	it("accepts zero for the optional CommDB activity window", () => {
		expect(parseNonNegativeIntEnv("0", 99)).toBe(0);
		expect(parseNonNegativeIntEnv("5", 99)).toBe(5);
		expect(parseNonNegativeIntEnv("abc", 99)).toBe(99);
		expect(stuckCommActivityMs({} as NodeJS.ProcessEnv)).toBe(1_800_000);
		expect(
			stuckCommActivityMs({
				FLYWHEEL_STUCK_COMM_ACTIVITY_MS: "0",
			} as NodeJS.ProcessEnv),
		).toBe(0);
	});
});

describe("CommDB probes", () => {
	let dir: string;
	let oldHome: string | undefined;
	let oldCommRoot: string | undefined;
	let oldCommDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1570-probe-"));
		oldHome = process.env.HOME;
		oldCommRoot = process.env.FLYWHEEL_COMM_ROOT;
		oldCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.HOME = dir;
		delete process.env.FLYWHEEL_COMM_ROOT;
		delete process.env.FLYWHEEL_COMM_DIR;
	});

	afterEach(() => {
		process.env.HOME = oldHome;
		if (oldCommRoot === undefined) delete process.env.FLYWHEEL_COMM_ROOT;
		else process.env.FLYWHEEL_COMM_ROOT = oldCommRoot;
		if (oldCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = oldCommDir;
		rmSync(dir, { recursive: true, force: true });
	});

	function seedCommDb(project: string): CommDB {
		return new CommDB(join(dir, ".flywheel", "comm", project, "comm.db"));
	}

	it("reports pending and recent outbound signals from the real database", () => {
		const db = seedCommDb("geo");
		db.insertQuestion("exec-1", "product-lead", "blocking?");
		db.close();
		expect(probeCommSignalsFromCommDb("exec-1", "geo", 60_000)).toEqual({
			hasPendingGate: true,
			hasRecentOutbound: true,
		});
	});

	it("uses the shared COMM_DIR fallback instead of the production home", () => {
		const commRoot = join(dir, "slot-comm");
		process.env.FLYWHEEL_COMM_DIR = commRoot;
		delete process.env.FLYWHEEL_COMM_ROOT;
		const db = new CommDB(join(commRoot, "geo", "comm.db"));
		db.insertQuestion("exec-slot", "product-lead", "blocking?");
		db.close();
		try {
			expect(
				probeCommSignalsFromCommDb("exec-slot", "geo", 60_000),
			).toMatchObject({ hasPendingGate: true });
		} finally {
			delete process.env.FLYWHEEL_COMM_DIR;
		}
	});

	it("rejects path traversal and short-circuits an activity window of zero", () => {
		expect(probeCommSignalsFromCommDb("exec-1", "../geo", 60_000)).toEqual({
			hasPendingGate: false,
			hasRecentOutbound: false,
		});
		const db = seedCommDb("geo");
		db.insertQuestion("exec-1", "product-lead", "DONE");
		db.close();
		expect(
			probeCommSignalsFromCommDb("exec-1", "geo", 0).hasRecentOutbound,
		).toBe(false);
	});

	it("preserves the done-but-running quiet signal without a CommDB", () => {
		expect(
			probeQuietSignals(
				{
					execution_id: "exec-1",
					project_name: "geo",
					status: "running",
					session_stage: "completed",
					decision_route: null,
					pr_number: null,
				},
				{ activityWindowMs: 60_000, nowMs: 1_000_000 },
			).isDoneButRunning,
		).toBe(true);
	});
});
