/** FLY-1867 P0 — exact identity + classifier + bounded TERM/KILL lifecycle. */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectDescendants,
	defaultListProcesses,
	MCP_DEFAULT_TOTAL_LOGICAL_BUDGET_MS,
	MCP_ORPHAN_MIN_ELAPSED_SECONDS,
	type ProcessProbeResult,
	type ProcessRow,
	parseMcpPsProcessRow,
	reapMcpDescendants,
	reapMcpOrphans,
} from "../mcp-descendant-reaper.js";
import { reapRunnerMcp } from "../runner-teardown.js";

const fixtureRoots: string[] = [];
afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true });
});

const row = (
	pid: number,
	ppid: number,
	argv: string[],
	elapsedSeconds = 60,
	lstart = `Wed Aug 20 08:00:${String(pid % 60).padStart(2, "0")} 2026`,
): ProcessRow => ({
	pid,
	ppid,
	elapsedSeconds,
	lstart,
	comm: basename(argv[0] ?? ""),
	argv,
	command: argv.join(" "),
});

const ok = (rows: ProcessRow[]): ProcessProbeResult => ({ status: "ok", rows });
const unknown = (error = "ps timeout"): ProcessProbeResult => ({
	status: "unknown",
	error,
});
const PANE = row(10, 1, ["pane"]);
const MCP_ARGV = ["npm", "exec", "@playwright/mcp@latest"];

function innerFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "fly1867-reaper-inner-"));
	fixtureRoots.push(root);
	const binDir = join(root, "node_modules", ".bin");
	const packageDir = join(root, "node_modules", "@playwright", "mcp");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "cli.js"), "// fixture\n");
	const bin = join(binDir, "playwright-mcp");
	symlinkSync(join("..", "@playwright", "mcp", "cli.js"), bin);
	return bin;
}

describe("defaultListProcesses", () => {
	it("parses the BSD ps etime + lstart row shape", () => {
		expect(
			parseMcpPsProcessRow(
				" 123 1 2-03:04:05 Wed Aug 20 08:00:00 2026 /usr/bin/node /tmp/worker.js",
			),
		).toEqual({
			pid: 123,
			ppid: 1,
			elapsedSeconds: 183_845,
			lstart: "Wed Aug 20 08:00:00 2026",
			comm: "node",
			argv: ["/usr/bin/node", "/tmp/worker.js"],
			command: "/usr/bin/node /tmp/worker.js",
		});
	});

	it("accepts a fractional probe budget at the real ps sensor", async (context) => {
		const result = await defaultListProcesses({ timeoutMs: 4_999.997_333 });
		if (result.status === "unknown" && /\bEPERM\b/.test(result.error)) {
			context.skip("managed sandbox denies /bin/ps process inspection");
			return;
		}
		expect(result.status, result.status === "unknown" ? result.error : "").toBe(
			"ok",
		);
		if (result.status !== "ok") return;
		const self = result.rows.find((item) => item.pid === process.pid);
		expect(self).toBeDefined();
		expect(self?.ppid).toBeGreaterThan(0);
		expect(self?.elapsedSeconds).toBeGreaterThanOrEqual(0);
		expect(self?.lstart).not.toBe("");
		expect(basename(self?.argv[0] ?? "")).toMatch(/^node(?:$|-)/);
	});
});

describe("collectDescendants", () => {
	it("walks only the root's transitive tree", () => {
		const rows = [
			PANE,
			row(20, 10, ["claude"]),
			row(30, 20, MCP_ARGV),
			row(40, 2, ["unrelated"]),
		];
		expect(collectDescendants(rows, 10).map((item) => item.pid)).toEqual(
			expect.arrayContaining([20, 30]),
		);
		expect(collectDescendants(rows, 10).map((item) => item.pid)).not.toContain(
			40,
		);
	});
});

describe("reapMcpDescendants", () => {
	it("lets a five-second graceful shutdown finish instead of killing it at three", async () => {
		const signals: Array<{ pid: number; signal: string }> = [];
		let elapsed = 0;
		const result = await reapMcpDescendants(10, {
			listProcesses: async () =>
				ok(elapsed < 5_000 ? [PANE, row(30, 10, MCP_ARGV)] : [PANE]),
			kill: (pid, signal) => {
				signals.push({ pid, signal });
				return true;
			},
			sleep: async (ms) => {
				elapsed += ms;
			},
			now: () => elapsed,
		});

		expect(signals).toEqual([{ pid: 30, signal: "SIGTERM" }]);
		expect(result.terminated).toBe(1);
		expect(result.killSent).toBe(0);
		expect(result.confirmedGone).toBe(1);
		expect(elapsed).toBeGreaterThanOrEqual(5_000);
	});

	it("co-delivers the structured classifier so the browser-owning inner gets TERM", async () => {
		const inner = innerFixture();
		const target = row(31, 10, ["/usr/bin/node", inner]);
		const signals: string[] = [];
		let call = 0;
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => ok(++call <= 2 ? [PANE, target] : [PANE]),
			kill: (_pid, signal) => {
				signals.push(signal);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
		});
		expect(result.matched).toBe(1);
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("sends KILL only after exact identity + classifier revalidation", async () => {
		const target = row(30, 10, MCP_ARGV);
		const signals: string[] = [];
		let call = 0;
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => {
				call++;
				return ok(call <= 3 ? [PANE, target] : [PANE]);
			},
			kill: (_pid, signal) => {
				signals.push(signal);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
			confirmationMs: 0,
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result.killSent).toBe(1);
		expect(result.confirmedGone).toBe(1);
		expect(result.survivors).toBe(0);
	});

	it("same pid + same argv but different lstart is never KILLed", async () => {
		const original = row(30, 10, MCP_ARGV, 60, "Wed Aug 20 08:00:00 2026");
		const recycled = row(30, 10, MCP_ARGV, 1, "Wed Aug 20 09:00:00 2026");
		let call = 0;
		const signals: string[] = [];
		const result = await reapMcpDescendants(10, {
			listProcesses: async () =>
				ok(++call <= 2 ? [PANE, original] : [PANE, recycled]),
			kill: (_pid, signal) => {
				signals.push(signal);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(result.identityMismatchSkipped).toBeGreaterThanOrEqual(1);
		expect(result.killSent).toBe(0);
	});

	it("an unknown process probe never authorizes KILL", async () => {
		const target = row(30, 10, MCP_ARGV);
		let call = 0;
		const signals: string[] = [];
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => (++call <= 2 ? ok([PANE, target]) : unknown()),
			kill: (_pid, signal) => {
				signals.push(signal);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(result.probeUnknown).toBeGreaterThanOrEqual(1);
		expect(result.killSent).toBe(0);
		expect(result.survivors).toBe(1);
	});

	it("does not count a successful kill(2) as reclaimed while identity remains alive", async () => {
		const target = row(30, 10, MCP_ARGV);
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => ok([PANE, target]),
			kill: () => true,
			sleep: async () => {},
			now: () => 0,
			graceMs: 0,
			confirmationMs: 0,
		});
		expect(result.killSent).toBe(1);
		expect(result.confirmedGone).toBe(0);
		expect(result.survivors).toBe(1);
	});

	it("authority loss is sticky and stops all later signals", async () => {
		const first = row(30, 10, MCP_ARGV);
		const second = row(31, 10, ["npx", "@playwright/mcp@latest"]);
		let checks = 0;
		const signals: number[] = [];
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => ok([PANE, first, second]),
			authorityCheck: async () => ++checks === 1,
			kill: (pid) => {
				signals.push(pid);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
		});
		expect(signals).toEqual([30]);
		expect(result.authorityLost).toBe(true);
	});

	it("gives the post-grace authority check its own bounded budget", async () => {
		const target = row(30, 10, MCP_ARGV);
		let elapsed = 0;
		let checks = 0;
		const signals: string[] = [];
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => ok([PANE, target]),
			authorityCheck: async () => {
				checks++;
				if (checks === 2) {
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
				}
				return true;
			},
			authorityTimeoutMs: 50,
			kill: (_pid, signal) => {
				signals.push(signal);
				return true;
			},
			sleep: async (ms) => {
				elapsed += ms;
			},
			now: () => elapsed,
			graceMs: 16_000,
			confirmationMs: 0,
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result.authorityLost).toBeUndefined();
	});

	it("does not spend the process-dispatch clock on authority I/O", async () => {
		const targets = [
			row(30, 10, MCP_ARGV),
			row(31, 10, ["npx", "@playwright/mcp@latest"]),
			row(32, 10, MCP_ARGV),
		];
		let elapsed = 0;
		const signals: Array<{ pid: number; signal: string }> = [];
		await reapMcpDescendants(10, {
			listProcesses: async () => ok([PANE, ...targets]),
			authorityCheck: async () => {
				elapsed += 4_000;
				return true;
			},
			authorityTimeoutMs: 50_000,
			kill: (pid, signal) => {
				signals.push({ pid, signal });
				return true;
			},
			sleep: async () => {},
			now: () => elapsed,
			dispatchMs: 5_000,
			graceMs: 0,
			confirmationMs: 0,
		});
		expect(
			signals
				.filter(({ signal }) => signal === "SIGTERM")
				.map(({ pid }) => pid),
		).toEqual([30, 31, 32]);
	});

	it("initial sensor unknown is explicit and audited, never a clean empty result", async () => {
		const audits: string[] = [];
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => unknown("permission denied"),
			audit: (event) => audits.push(event),
		});
		expect(result.probeUnknown).toBe(1);
		expect(result.incompleteReason).toBe("process_probe_unknown");
		expect(audits).toContain("mcp_reap_incomplete");
	});

	it("multiple candidates share one graceful clock instead of waiting N times", async () => {
		const a = row(30, 10, MCP_ARGV);
		const b = row(31, 10, ["npx", "@playwright/mcp@latest"]);
		let elapsed = 0;
		const result = await reapMcpDescendants(10, {
			listProcesses: async () => ok([PANE, a, b]),
			kill: () => true,
			sleep: async (ms) => {
				elapsed += ms;
			},
			now: () => elapsed,
			graceMs: 16_000,
			confirmationMs: 0,
		});
		expect(elapsed).toBe(16_000);
		expect(result.killSent).toBe(2);
	});

	it("pins the three-candidate worst-case logical budget at no more than 34 seconds", async () => {
		const targets = [
			row(30, 10, MCP_ARGV),
			row(31, 10, ["npx", "@playwright/mcp@latest"]),
			row(32, 10, MCP_ARGV),
		];
		let elapsed = 0;
		let probesBeforeTerm = 0;
		let termSent = 0;
		let killSent = 0;
		const result = await reapMcpDescendants(10, {
			listProcesses: async ({ timeoutMs } = {}) => {
				if (termSent === 0) {
					elapsed += probesBeforeTerm++ === 0 ? 2_500 : 2_499;
				} else if (killSent === 0 && elapsed >= 25_999) {
					elapsed += Math.min(timeoutMs ?? 0, 1_000);
				} else if (killSent > 0) {
					elapsed += timeoutMs ?? 0;
				}
				return ok([PANE, ...targets]);
			},
			authorityCheck: async () => {
				if (termSent === 0 || (termSent === targets.length && killSent === 0)) {
					elapsed += 5_000;
				}
				return true;
			},
			kill: (_pid, signal) => {
				if (signal === "SIGTERM") termSent++;
				else killSent++;
				return true;
			},
			sleep: async (ms) => {
				elapsed += ms;
			},
			now: () => elapsed,
		});
		expect(result.killSent).toBe(3);
		expect(elapsed).toBeLessThanOrEqual(MCP_DEFAULT_TOTAL_LOGICAL_BUDGET_MS);
		expect(MCP_DEFAULT_TOTAL_LOGICAL_BUDGET_MS).toBe(34_000);
	});
});

describe("reapMcpOrphans", () => {
	it("only ppid 1 + exact classifier + at least 30 minutes qualifies", async () => {
		const signals: number[] = [];
		const eligible = row(100, 1, MCP_ARGV, MCP_ORPHAN_MIN_ELAPSED_SECONDS + 5);
		const rows = [
			eligible,
			row(101, 1, MCP_ARGV, 60),
			row(102, 55, MCP_ARGV, 99_999),
			row(103, 1, ["node", "server.js", "@playwright/mcp"], 99_999),
		];
		let call = 0;
		await reapMcpOrphans({
			listProcesses: async () =>
				ok(++call <= 3 ? rows : rows.filter((item) => item.pid !== 100)),
			kill: (pid) => {
				signals.push(pid);
				return true;
			},
			sleep: async () => {},
			graceMs: 0,
			confirmationMs: 0,
		});
		expect(signals).toContain(100);
		expect(signals).not.toContain(101);
		expect(signals).not.toContain(102);
		expect(signals).not.toContain(103);
	});

	it("audits an unknown classifier result instead of reporting a clean sweep", async () => {
		const missingInner = row(
			100,
			1,
			["/usr/bin/node", "/missing/node_modules/.bin/playwright-mcp"],
			MCP_ORPHAN_MIN_ELAPSED_SECONDS + 5,
		);
		const audits: Array<{ event: string; detail: Record<string, unknown> }> =
			[];
		const result = await reapMcpOrphans({
			listProcesses: async () => ok([missingInner]),
			audit: (event, detail) => audits.push({ event, detail }),
		});
		expect(result.matched).toBe(0);
		expect(result.classifierBlocked).toBe(1);
		expect(result.incompleteReason).toBe("classifier_unknown");
		expect(audits).toContainEqual({
			event: "mcp_orphan_reap_incomplete",
			detail: { reason: "classifier_unknown", count: 1 },
		});
	});
});

describe("reapRunnerMcp", () => {
	it("resolves the live pane and preserves explicit no-pane skip semantics", async () => {
		const target = row(30, 10, MCP_ARGV);
		let call = 0;
		const result = await reapRunnerMcp("flywheel-x:1", {
			resolvePanePid: async () => 10,
			listProcesses: async () => ok(++call <= 2 ? [PANE, target] : [PANE]),
			kill: () => true,
			sleep: async () => {},
			graceMs: 0,
		});
		expect(result.panePid).toBe(10);
		expect(result.terminated).toBe(1);

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
