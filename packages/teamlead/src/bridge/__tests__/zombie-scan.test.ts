/**
 * FLY-1082 (Task 2.6): the three-shape zombie taxonomy (FLY-1066 口径) —
 * detection only, indeterminate never counts, sample formatting.
 */
import { describe, expect, it } from "vitest";
import {
	formatZombieSamples,
	scanZombies,
	type ZombieFinding,
} from "../zombie-scan.js";

const NOW = Date.parse("2026-07-09T21:00:00Z");
const STALE = "2026-07-08 20:00:00"; // 25h before NOW
const FRESH = "2026-07-09 20:59:00";

describe("scanZombies (three shapes)", () => {
	it("shape ①: CommDB running with NO StateStore row", async () => {
		const out = await scanZombies({
			commRunning: [
				{ execution_id: "a", project_name: "fw", tmux_window: "s:@1" },
			],
			storeSession: () => undefined,
			targetAlive: async () => true,
			nowMs: NOW,
		});
		expect(out).toHaveLength(1);
		expect(out[0]!.shape).toBe("commdb_orphan");
	});

	it("shape ②: StateStore terminal but CommDB still running", async () => {
		const out = await scanZombies({
			commRunning: [{ execution_id: "b", project_name: "fw" }],
			storeSession: () => ({ status: "failed", heartbeat_at: FRESH }),
			targetAlive: async () => true,
			nowMs: NOW,
		});
		expect(out[0]!.shape).toBe("terminal_desync");
	});

	it("shape ③: both running + tmux provably dead + heartbeat ≥24h stale", async () => {
		const out = await scanZombies({
			commRunning: [
				{ execution_id: "c", project_name: "fw", tmux_window: "s:@2" },
			],
			storeSession: () => ({ status: "running", heartbeat_at: STALE }),
			targetAlive: async () => false,
			nowMs: NOW,
		});
		expect(out[0]!.shape).toBe("stale_target");
	});

	it("healthy running session is NOT a zombie; indeterminate probe never counts", async () => {
		const healthy = await scanZombies({
			commRunning: [
				{ execution_id: "d", project_name: "fw", tmux_window: "s:@3" },
			],
			storeSession: () => ({ status: "running", heartbeat_at: FRESH }),
			targetAlive: async () => false, // dead target but FRESH heartbeat → not stale
			nowMs: NOW,
		});
		expect(healthy).toHaveLength(0);
		const indeterminate = await scanZombies({
			commRunning: [
				{ execution_id: "e", project_name: "fw", tmux_window: "s:@4" },
			],
			storeSession: () => ({ status: "running", heartbeat_at: STALE }),
			targetAlive: async () => null, // cannot tell → never a zombie
			nowMs: NOW,
		});
		expect(indeterminate).toHaveLength(0);
	});

	it("awaiting_review (non-terminal, non-running) is left alone", async () => {
		const out = await scanZombies({
			commRunning: [{ execution_id: "f", project_name: "fw" }],
			storeSession: () => ({ status: "awaiting_review", heartbeat_at: STALE }),
			targetAlive: async () => false,
			nowMs: NOW,
		});
		expect(out).toHaveLength(0);
	});
});

describe("formatZombieSamples", () => {
	const finding = (i: number): ZombieFinding => ({
		shape: "commdb_orphan",
		executionId: `z-${i}`,
		projectName: "fw",
		detail: "d",
	});

	it("lists up to 10 samples; truncation note carries the total", () => {
		const short = formatZombieSamples([finding(1), finding(2)]);
		expect(short).toContain("z-1");
		expect(short).not.toContain("共");
		const long = formatZombieSamples(
			Array.from({ length: 12 }, (_, i) => finding(i)),
		);
		expect(long).toContain("共 12 个");
		expect(long).not.toContain("z-10\n"); // only the first 10 listed
	});
});
