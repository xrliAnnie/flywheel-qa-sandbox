import { describe, expect, it, vi } from "vitest";
import {
	type ProcessRow,
	parseLsofCwdOutput,
	type ReapDeps,
	type ReapTarget,
	reapWorktreeProcesses,
} from "../worktree-process-reaper.js";

const target: ReapTarget = {
	lexicalPath: "/private/tmp/flywheel-FLY-1759",
	canonicalPath: "/private/tmp/flywheel-FLY-1759",
	expectedParentDir: "/private/tmp",
	repoSlugPrefix: "flywheel-",
	rootProof: "live-dir",
};

function processRow(
	pid: number,
	ppid: number,
	pgid: number,
	command = `fixture-${pid}`,
): ProcessRow {
	return {
		pid,
		ppid,
		pgid,
		lstart: `Wed Aug 13 21:14:${String(pid % 60).padStart(2, "0")} 2026`,
		command,
	};
}

function makeDeps(input?: {
	rows?: ProcessRow[];
	cwdPids?: number[];
	selfPid?: number;
}): {
	deps: ReapDeps;
	alive: Set<number>;
	pointSignals: Array<[number, "SIGTERM" | "SIGKILL"]>;
	groupSignals: Array<[number, "SIGTERM" | "SIGKILL"]>;
} {
	const rows = input?.rows ?? [];
	const alive = new Set(rows.map((row) => row.pid));
	const cwdPids = new Set(input?.cwdPids ?? []);
	let clock = 0;
	const pointSignals: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
	const groupSignals: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
	const deps: ReapDeps = {
		listCwds: async () =>
			[...cwdPids]
				.filter((pid) => alive.has(pid))
				.map((pid) => ({
					pid,
					rawCwd: target.canonicalPath,
					logicalCwd: target.canonicalPath,
					deletedMarker: false,
				})),
		listProcesses: async () => rows.filter((row) => alive.has(row.pid)),
		kill: (pid, signal) => {
			if (signal === 0) return alive.has(pid);
			pointSignals.push([pid, signal]);
			return alive.delete(pid);
		},
		killGroup: (pgid, signal) => {
			groupSignals.push([pgid, signal]);
			let found = false;
			for (const row of rows) {
				if (row.pgid === pgid && alive.delete(row.pid)) found = true;
			}
			return found;
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		lstat: () => ({ isDir: true, isSymlink: false }),
		realpath: (candidate) => candidate,
		selfPid: input?.selfPid ?? 900,
	};
	return { deps, alive, pointSignals, groupSignals };
}

describe("parseLsofCwdOutput", () => {
	it("normalizes Linux deleted cwd markers while retaining the raw path", () => {
		expect(
			parseLsofCwdOutput(
				"p41\nfcwd\nn/private/tmp/flywheel-FLY-1 (deleted)\np42\nfcwd\nn/private/tmp/live\n",
			),
		).toEqual([
			{
				pid: 41,
				rawCwd: "/private/tmp/flywheel-FLY-1 (deleted)",
				logicalCwd: "/private/tmp/flywheel-FLY-1",
				deletedMarker: true,
			},
			{
				pid: 42,
				rawCwd: "/private/tmp/live",
				logicalCwd: "/private/tmp/live",
				deletedMarker: false,
			},
		]);
	});

	it("keeps malformed cwd rows visible but never matchable", () => {
		expect(parseLsofCwdOutput("p41\nfcwd\nnnot-an-absolute-path\n")).toEqual([
			{
				pid: 41,
				rawCwd: "not-an-absolute-path",
				logicalCwd: null,
				deletedMarker: false,
			},
		]);
	});
});

describe("reapWorktreeProcesses", () => {
	it("takes the empty-match fast path without a process census or signals", async () => {
		const { deps } = makeDeps();
		deps.listProcesses = vi.fn(async () => []);
		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary).toEqual({
			matched: 0,
			reaped: [],
			survivors: [],
			verified: true,
			identityMismatchSkipped: 0,
		});
		expect(deps.listProcesses).not.toHaveBeenCalled();
	});

	it("reaps a cwd match and its descendant as a complete process group", async () => {
		const { deps, alive, pointSignals, groupSignals } = makeDeps({
			rows: [processRow(101, 1, 101), processRow(102, 101, 101)],
			cwdPids: [101],
		});

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary).toMatchObject({
			matched: 1,
			reaped: [101, 102],
			survivors: [],
			verified: true,
		});
		expect(groupSignals).toEqual([[101, "SIGTERM"]]);
		expect(pointSignals).toEqual([]);
		expect(alive).toEqual(new Set());
	});

	it("does not group-signal an unrelated same-group sibling", async () => {
		const { deps, alive, pointSignals, groupSignals } = makeDeps({
			rows: [processRow(101, 1, 200), processRow(102, 1, 200)],
			cwdPids: [101],
		});

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.verified).toBe(true);
		expect(groupSignals).toEqual([]);
		expect(pointSignals).toEqual([[101, "SIGTERM"]]);
		expect(alive.has(101)).toBe(false);
		expect(alive.has(102)).toBe(true);
	});

	it("refuses a lexical symlink target before any scan or signal", async () => {
		const { deps, pointSignals, groupSignals } = makeDeps();
		deps.listCwds = vi.fn(async () => []);
		deps.lstat = () => ({ isDir: false, isSymlink: true });

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.refusedReason).toContain("symlink");
		expect(summary.verified).toBe(false);
		expect(deps.listCwds).not.toHaveBeenCalled();
		expect(pointSignals).toEqual([]);
		expect(groupSignals).toEqual([]);
	});

	it("fails closed before signaling when the initial process census fails", async () => {
		const { deps, pointSignals, groupSignals } = makeDeps({
			rows: [processRow(101, 1, 101)],
			cwdPids: [101],
		});
		deps.listProcesses = async () => {
			throw new Error("ps unavailable");
		};

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.scanError).toContain("ps unavailable");
		expect(summary.verified).toBe(false);
		expect(pointSignals).toEqual([]);
		expect(groupSignals).toEqual([]);
	});

	it("does not signal a reused PID whose exact identity changed", async () => {
		const original = processRow(101, 1, 101, "original-command");
		const reused = { ...original, lstart: "Thu Aug 14 01:00:00 2026" };
		const { deps, pointSignals, groupSignals } = makeDeps({
			rows: [original],
			cwdPids: [101],
		});
		let census = 0;
		deps.listProcesses = async () => (++census === 1 ? [original] : [reused]);

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.identityMismatchSkipped).toBeGreaterThan(0);
		expect(summary.verified).toBe(false);
		expect(pointSignals).toEqual([]);
		expect(groupSignals).toEqual([]);
	});

	it("stops after TERM when a later census becomes uncertain", async () => {
		const row = processRow(101, 1, 101);
		const { deps, pointSignals, groupSignals } = makeDeps({
			rows: [row],
			cwdPids: [101],
		});
		let census = 0;
		deps.listProcesses = async () => {
			census += 1;
			if (census >= 3) throw new Error("post-TERM ps failure");
			return [row];
		};
		deps.killGroup = (pgid, signal) => {
			groupSignals.push([pgid, signal]);
			return true; // TERM was sent, but the fixture deliberately survives it.
		};

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.verifyError).toContain("post-TERM ps failure");
		expect(summary.verified).toBe(false);
		expect(groupSignals).toEqual([[101, "SIGTERM"]]);
		expect(pointSignals).toEqual([]);
	});

	it("escalates a TERM-resistant complete group to SIGKILL", async () => {
		const rows = [processRow(101, 1, 101), processRow(102, 101, 101)];
		const { deps, alive, groupSignals } = makeDeps({
			rows,
			cwdPids: [101],
		});
		deps.killGroup = (pgid, signal) => {
			groupSignals.push([pgid, signal]);
			if (signal === "SIGKILL") {
				for (const row of rows) alive.delete(row.pid);
			}
			return true;
		};

		const summary = await reapWorktreeProcesses(target, deps);

		expect(groupSignals).toEqual([
			[101, "SIGTERM"],
			[101, "SIGKILL"],
		]);
		expect(summary).toMatchObject({ verified: true, survivors: [] });
	});

	it("fails stop when the lexical root drifts after TERM", async () => {
		const row = processRow(101, 1, 101);
		const { deps, groupSignals } = makeDeps({
			rows: [row],
			cwdPids: [101],
		});
		deps.killGroup = (pgid, signal) => {
			groupSignals.push([pgid, signal]);
			return true;
		};
		let realpathChecks = 0;
		deps.realpath = (candidate) => {
			realpathChecks += 1;
			return realpathChecks >= 3 ? `${candidate}-replaced` : candidate;
		};

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.verifyError).toContain("realpath drifted");
		expect(summary.verified).toBe(false);
		expect(groupSignals).toEqual([[101, "SIGTERM"]]);
	});

	it("does not enter KILL when the monotonic deadline expires after TERM", async () => {
		const row = processRow(101, 1, 101);
		const { deps, groupSignals } = makeDeps({
			rows: [row],
			cwdPids: [101],
		});
		deps.killGroup = (pgid, signal) => {
			groupSignals.push([pgid, signal]);
			return true;
		};
		let nowCalls = 0;
		deps.now = () => (++nowCalls >= 3 ? 30_000 : 0);

		const summary = await reapWorktreeProcesses(target, deps);

		expect(summary.verifyError).toContain("deadline");
		expect(summary.verified).toBe(false);
		expect(groupSignals).toEqual([[101, "SIGTERM"]]);
	});

	it("keeps survivors non-empty when the final cwd census fails", async () => {
		const row = processRow(101, 1, 101);
		const { deps, groupSignals } = makeDeps({
			rows: [row],
			cwdPids: [101],
		});
		let cwdScans = 0;
		const initial = deps.listCwds;
		deps.listCwds = async () => {
			cwdScans += 1;
			if (cwdScans > 1) throw new Error("final lsof failed");
			return initial();
		};

		const summary = await reapWorktreeProcesses(target, deps);

		expect(groupSignals).toEqual([[101, "SIGTERM"]]);
		expect(summary.verifyError).toContain("final lsof failed");
		expect(summary.verified).toBe(false);
		expect(summary.survivors).toEqual([101]);
	});

	it.each([
		["relative lexical path", { ...target, lexicalPath: "flywheel-FLY-1" }],
		[
			"wrong expected parent",
			{ ...target, expectedParentDir: "/private/elsewhere" },
		],
		["wrong repo prefix", { ...target, repoSlugPrefix: "geoforge3d-" }],
		["gone target recreated", { ...target, rootProof: "gone" as const }],
	])("refuses %s without scanning or signaling", async (_label, unsafe) => {
		const { deps, pointSignals, groupSignals } = makeDeps();
		deps.listCwds = vi.fn(async () => []);
		const summary = await reapWorktreeProcesses(unsafe, deps);

		expect(summary.refusedReason).toBeTruthy();
		expect(deps.listCwds).not.toHaveBeenCalled();
		expect(pointSignals).toEqual([]);
		expect(groupSignals).toEqual([]);
	});
});
