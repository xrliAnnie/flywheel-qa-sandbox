/**
 * FLY-1185 §2.5 — MCP descendant/orphan reaper unit tests.
 * Pins: double identity re-check (recycled pid never signaled), TERM→KILL
 * sequence, family matching (argv + basename), ppid-1 + 30min orphan gate,
 * reap-only (no throw on failure paths).
 */

import { describe, expect, it } from "vitest";
import {
	collectDescendants,
	MCP_ORPHAN_MIN_ELAPSED_SECONDS,
	matchesMcpFamily,
	type ProcessRow,
	reapMcpDescendants,
	reapMcpOrphans,
} from "../mcp-descendant-reaper.js";
import { reapRunnerMcp } from "../runner-teardown.js";

const row = (
	pid: number,
	ppid: number,
	command: string,
	elapsedSeconds = 60,
): ProcessRow => ({ pid, ppid, command, elapsedSeconds });

const MCP_CMD = "node /x/npm exec @playwright/mcp@latest";

describe("matchesMcpFamily", () => {
	it("matches argv substring + exact basename, not lookalikes", () => {
		expect(matchesMcpFamily(MCP_CMD)).toBeTruthy();
		expect(matchesMcpFamily("/opt/bin/playwright-mcp --port 1")).toBeTruthy();
		expect(matchesMcpFamily("/opt/bin/playwright-mcp-extra")).toBeUndefined();
		expect(matchesMcpFamily("node server.js")).toBeUndefined();
	});
});

describe("collectDescendants", () => {
	it("walks the transitive tree only", () => {
		const rows = [
			row(10, 1, "pane-shell"),
			row(20, 10, "claude"),
			row(30, 20, MCP_CMD),
			row(40, 2, "unrelated"),
		];
		expect(collectDescendants(rows, 10).map((r) => r.pid)).toEqual(
			expect.arrayContaining([20, 30]),
		);
		expect(collectDescendants(rows, 10).map((r) => r.pid)).not.toContain(40);
	});
});

describe("reapMcpDescendants", () => {
	it("TERM → grace → KILL for survivors, with identity re-check each pass", async () => {
		const kills: Array<{ pid: number; sig: string }> = [];
		let snapshot = 0;
		const rows1 = [row(10, 1, "pane"), row(30, 10, MCP_CMD)];
		const res = await reapMcpDescendants(10, {
			listProcesses: async () => {
				snapshot++;
				// snapshots: 1=tree enumeration, 2=pre-TERM verify, 3=pre-KILL verify
				return rows1; // process survives TERM → gets KILL
			},
			kill: (pid, sig) => {
				kills.push({ pid, sig });
				return true;
			},
			sleep: async () => {},
		});
		expect(res.matched).toBe(1);
		expect(res.terminated).toBe(1);
		expect(res.killed).toBe(1);
		expect(kills).toEqual([
			{ pid: 30, sig: "SIGTERM" },
			{ pid: 30, sig: "SIGKILL" },
		]);
		expect(snapshot).toBe(3);
	});

	it("recycled pid (command changed) is NEVER signaled", async () => {
		const kills: Array<{ pid: number; sig: string }> = [];
		let call = 0;
		const res = await reapMcpDescendants(10, {
			listProcesses: async () => {
				call++;
				if (call === 1) return [row(10, 1, "pane"), row(30, 10, MCP_CMD)];
				// fresh snapshot: pid 30 is now a DIFFERENT process
				return [row(10, 1, "pane"), row(30, 10, "vim important.txt")];
			},
			kill: (pid, sig) => {
				kills.push({ pid, sig });
				return true;
			},
			sleep: async () => {},
		});
		expect(kills).toEqual([]);
		expect(res.identityMismatchSkipped).toBe(1);
	});

	it("process exiting after TERM gets no KILL", async () => {
		const kills: Array<{ pid: number; sig: string }> = [];
		let call = 0;
		const res = await reapMcpDescendants(10, {
			listProcesses: async () => {
				call++;
				if (call <= 2) return [row(10, 1, "pane"), row(30, 10, MCP_CMD)];
				return [row(10, 1, "pane")]; // exited during grace
			},
			kill: (pid, sig) => {
				kills.push({ pid, sig });
				return true;
			},
			sleep: async () => {},
		});
		expect(kills).toEqual([{ pid: 30, sig: "SIGTERM" }]);
		expect(res.terminated).toBe(1);
		expect(res.killed).toBe(0);
	});

	it("never throws on listProcesses failure — audits instead", async () => {
		const audits: string[] = [];
		const res = await reapMcpDescendants(10, {
			listProcesses: async () => {
				throw new Error("ps exploded");
			},
			audit: (e) => audits.push(e),
		});
		expect(res.matched).toBe(0);
		expect(audits).toContain("mcp_reap_failed");
	});
});

describe("reapMcpOrphans", () => {
	it("only ppid==1 + family + ≥30min elapsed qualify", async () => {
		const kills: number[] = [];
		const procs = [
			row(100, 1, MCP_CMD, MCP_ORPHAN_MIN_ELAPSED_SECONDS + 5), // qualifies
			row(101, 1, MCP_CMD, 60), // too young
			row(102, 55, MCP_CMD, 99999), // has a live parent
			row(103, 1, "some-daemon", 99999), // not family
		];
		await reapMcpOrphans({
			listProcesses: async () => procs,
			kill: (pid) => {
				kills.push(pid);
				return true;
			},
			sleep: async () => {},
		});
		expect(kills).toContain(100);
		expect(kills).not.toContain(101);
		expect(kills).not.toContain(102);
		expect(kills).not.toContain(103);
	});
});

describe("reapRunnerMcp (reap-only primitive)", () => {
	it("resolves pane pid then reaps descendants; unresolvable pane is a silent skip", async () => {
		const kills: number[] = [];
		const ok = await reapRunnerMcp("flywheel-x:1", {
			resolvePanePid: async () => 10,
			listProcesses: async () => [row(10, 1, "pane"), row(30, 10, MCP_CMD)],
			kill: (pid) => {
				kills.push(pid);
				return true;
			},
			sleep: async () => {},
		});
		expect(ok.panePid).toBe(10);
		expect(kills).toContain(30);

		const skip = await reapRunnerMcp("gone:9", {
			resolvePanePid: async () => undefined,
			listProcesses: async () => {
				throw new Error("must not be called");
			},
		});
		expect(skip.skippedReason).toBe("no_pane_pid");
		expect(skip.matched).toBe(0);
	});
});
