import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserIdleCensus,
	classifyBrowserIdleCensus,
	collectBrowserIdleCensus,
} from "../browser-idle-census.js";
import type { ChromeSweepSample } from "../chrome-session-reaper.js";
import {
	parseMcpPsProcessRow,
	splitMcpPsCommand,
} from "../mcp-descendant-reaper.js";

const PLAYWRIGHT_ROOT = "/Users/x/Library/Caches/ms-playwright-mcp";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_FOR_TESTING =
	"/Users/x/.agent-browser/browsers/chrome-147/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const START = "Mon Aug 24 10:00:00 2026";
const OBSERVED_AT_EPOCH_MS = 2_000_000;

interface FixtureRow {
	pid: number;
	ppid: number;
	comm: string;
	command: string;
	ageMs?: number;
	lstart?: string;
}

const ok = <T>(rows: ReadonlyMap<number, T>) => ({
	status: "ok" as const,
	rows,
});

function sample(rows: readonly FixtureRow[]): ChromeSweepSample {
	return {
		comm: ok(new Map(rows.map((row) => [row.pid, row.comm]))),
		command: ok(
			new Map(
				rows.map((row) => [row.pid, { ppid: row.ppid, command: row.command }]),
			),
		),
		age: ok(
			new Map(
				rows.map((row) => [
					row.pid,
					{ ageMs: row.ageMs ?? 60_000, lstart: row.lstart ?? START },
				]),
			),
		),
	};
}

function inspect(sweep: ChromeSweepSample): BrowserIdleCensus {
	return classifyBrowserIdleCensus({
		sample: sweep,
		observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
		playwrightProfileRoot: PLAYWRIGHT_ROOT,
	});
}

function claude(pid = 10): FixtureRow {
	return {
		pid,
		ppid: 1,
		comm: "/usr/local/bin/claude",
		command: "/usr/local/bin/claude --dangerously-skip-permissions",
	};
}

function cursor(pid = 10): FixtureRow {
	return {
		pid,
		ppid: 1,
		comm: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper: mcp-process",
		command:
			"/Applications/Cursor.app/Contents/Frameworks/Cursor Helper: mcp-process --type=utility",
	};
}

function mcp(pid: number, ppid: number): FixtureRow {
	return {
		pid,
		ppid,
		comm: "/opt/homebrew/bin/npm",
		command: "/opt/homebrew/bin/npm exec @playwright/mcp@latest",
	};
}

function child(pid: number, ppid: number): FixtureRow {
	return {
		pid,
		ppid,
		comm: "/usr/bin/node",
		command: `/usr/bin/node /tmp/ordinary-child-${pid}.js`,
	};
}

function playwrightChrome(pid: number, ppid: number): FixtureRow {
	return {
		pid,
		ppid,
		comm: CHROME,
		command: `${CHROME} --user-data-dir=${PLAYWRIGHT_ROOT}/mcp-chrome-abc1234`,
	};
}

function chromeRenderer(pid: number, ppid: number): FixtureRow {
	return {
		pid,
		ppid,
		comm: CHROME,
		command: `${CHROME} --type=renderer`,
	};
}

function chromeCrashpadHandler(pid: number, ppid: number): FixtureRow {
	const crashpad =
		"/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler";
	return {
		pid,
		ppid,
		comm: crashpad,
		command: `${crashpad} --monitor-self --monitor-self-annotation=ptype=crashpad-handler --database=/Users/x/Library/Application Support/Google/Chrome/Crashpad`,
	};
}

function agentBrowserChrome(
	pid: number,
	ppid: number,
	userDataDir: string,
): FixtureRow {
	return {
		pid,
		ppid,
		comm: CHROME_FOR_TESTING,
		command: `${CHROME_FOR_TESTING} --headless=new --user-data-dir=${userDataDir}`,
	};
}

describe("browser idle census", () => {
	it("reports a healthy empty sweep as single-digit", () => {
		expect(inspect(sample([]))).toMatchObject({
			status: "ok",
			singleDigit: true,
			inScopeProcessCount: 0,
			inScopeProcesses: [],
		});
	});

	it("counts a Claude-held MCP tree as active managed without counting its holder", () => {
		const result = inspect(sample([claude(), mcp(20, 10), child(21, 20)]));
		expect(result.status).toBe("ok");
		expect(
			result.activeManaged.playwrightMcpRoots.map(({ pid }) => pid),
		).toEqual([20]);
		expect(result.activeManaged.processes.map(({ pid }) => pid)).toEqual([
			20, 21,
		]);
		expect(result.inScopeProcessCount).toBe(2);
	});

	it("discloses a positively identified Cursor MCP tree as external", () => {
		const result = inspect(sample([cursor(), mcp(20, 10), child(21, 20)]));
		expect(result.external.mcpRoots).toMatchObject([
			{ pid: 20, holder: { pid: 10 } },
		]);
		expect(result.external.processes.map(({ pid }) => pid)).toEqual([20, 21]);
		expect(result.inScopeProcessCount).toBe(0);
		expect(result.singleDigit).toBe(true);
	});

	it("counts a ppid-1 MCP root and descendants as orphaned managed", () => {
		const result = inspect(sample([mcp(20, 1), child(21, 20)]));
		expect(
			result.orphanedManaged.playwrightMcpRoots.map(({ pid }) => pid),
		).toEqual([20]);
		expect(result.orphanedManaged.processes.map(({ pid }) => pid)).toEqual([
			20, 21,
		]);
		expect(result.inScopeProcessCount).toBe(2);
	});

	it("attributes a Playwright Chrome tree to its managed MCP root without double-counting", () => {
		const result = inspect(
			sample([
				claude(),
				mcp(20, 10),
				playwrightChrome(30, 20),
				chromeRenderer(31, 30),
			]),
		);
		expect(
			result.activeManaged.playwrightChromeMains.map(({ pid }) => pid),
		).toEqual([30]);
		expect(result.inScopeProcesses.map(({ pid }) => pid)).toEqual([20, 30, 31]);
		expect(result.inScopeProcessCount).toBe(3);
	});

	it("counts a ppid-1 Playwright Chrome tree as orphaned managed", () => {
		const result = inspect(
			sample([playwrightChrome(30, 1), chromeRenderer(31, 30)]),
		);
		expect(
			result.orphanedManaged.playwrightChromeMains.map(({ pid }) => pid),
		).toEqual([30]);
		expect(result.orphanedManaged.processes.map(({ pid }) => pid)).toEqual([
			30, 31,
		]);
		expect(result.inScopeProcessCount).toBe(2);
	});

	it("separates Flywheel-owned and system-TMP agent-browser trees", () => {
		const managedProfile =
			"/Users/x/.flywheel/runner-state/exec-abc/browser-tmp/agent-browser-chrome-owned";
		const systemProfile = "/var/folders/xx/T/agent-browser-chrome-unattributed";
		const result = inspect(
			sample([
				agentBrowserChrome(40, 400, managedProfile),
				{
					pid: 400,
					ppid: 1,
					comm: "agent-browser-darwin-arm64",
					command: "/usr/local/bin/agent-browser-darwin-arm64",
				},
				{ ...chromeRenderer(41, 40), comm: CHROME_FOR_TESTING },
				agentBrowserChrome(50, 500, systemProfile),
				{
					pid: 500,
					ppid: 1,
					comm: "agent-browser-darwin-arm64",
					command: "/usr/local/bin/agent-browser-darwin-arm64",
				},
				{ ...chromeRenderer(51, 50), comm: CHROME_FOR_TESTING },
			]),
		);
		expect(
			result.activeManaged.proofshotChromeMains.map(({ pid }) => pid),
		).toEqual([40]);
		expect(
			result.orphanedManaged.agentBrowserChromeMains.map(({ pid }) => pid),
		).toEqual([50]);
		expect(result.inScopeProcesses.map(({ pid }) => pid)).toEqual([
			40, 41, 50, 51,
		]);
		// Holder daemons are ancestors, not members of either Chrome tree.
		expect(result.inScopeProcesses.map(({ pid }) => pid)).not.toContain(500);
	});

	it("excludes founder ordinary Chrome", () => {
		const result = inspect(
			sample([
				{
					pid: 90,
					ppid: 1,
					comm: CHROME,
					command: `${CHROME} --user-data-dir=/Users/x/Library/Application Support/Google/Chrome`,
				},
			]),
		);
		expect(result.inScopeProcessCount).toBe(0);
		expect(result.external.processes).toEqual([]);
	});

	it("discloses an unattributed ppid-1 Chrome crashpad handler without counting it", () => {
		const result = inspect(sample([chromeCrashpadHandler(95, 1)]));

		expect(result.status).toBe("ok");
		expect(
			result.ruledOut.unattributedPpid1CrashpadHandlers.map(({ pid }) => pid),
		).toEqual([95]);
		expect(result.inScopeProcessCount).toBe(0);
		expect(result.singleDigit).toBe(true);
	});

	it("does not mistake a child handler or a Chrome main for an unattributed handler", () => {
		const chromeMainWithCrashpadAnnotation = {
			...chromeRenderer(96, 1),
			command: `${CHROME} --monitor-self-annotation=ptype=crashpad-handler`,
		};
		const result = inspect(
			sample([chromeCrashpadHandler(95, 94), chromeMainWithCrashpadAnnotation]),
		);

		expect(
			result.ruledOut.unattributedPpid1CrashpadHandlers.map(({ pid }) => pid),
		).toEqual([]);
	});

	it("fails closed when a ppid-1 crashpad handler is missing census evidence", () => {
		const sweep = sample([chromeCrashpadHandler(95, 1)]);
		const commandRows = new Map(
			sweep.command.status === "ok" ? sweep.command.rows : [],
		);
		commandRows.delete(95);

		const result = inspect({ ...sweep, command: ok(commandRows) });

		expect(result.status).toBe("unknown");
		expect(result.errors).toContain("join:pid=95:missing=command");
	});

	it("fails closed when a spaced-path ppid-1 crashpad handler is missing comm", () => {
		const sweep = sample([chromeCrashpadHandler(95, 1)]);
		const commRows = new Map(sweep.comm.status === "ok" ? sweep.comm.rows : []);
		commRows.delete(95);

		const result = inspect({ ...sweep, comm: ok(commRows) });

		expect(result.status).toBe("unknown");
		expect(result.errors).toContain("join:pid=95:missing=comm");
	});

	it("fails closed when a spaced-path ppid-1 crashpad handler has blank comm", () => {
		const sweep = sample([chromeCrashpadHandler(95, 1)]);
		const commRows = new Map(sweep.comm.status === "ok" ? sweep.comm.rows : []);
		commRows.set(95, "");

		const result = inspect({ ...sweep, comm: ok(commRows) });

		expect(result.status).toBe("unknown");
		expect(result.errors).toContain("join:pid=95:missing=comm");
	});

	it("fails closed when a whole sweep sensor is unknown", () => {
		const clean = sample([]);
		const result = inspect({
			...clean,
			comm: { status: "unknown", error: "comm probe timed out" },
		});
		expect(result).toMatchObject({
			status: "unknown",
			singleDigit: null,
			inScopeProcessCount: null,
		});
		expect(result.errors).toContain("comm:comm probe timed out");
	});

	it("uses strict less-than-ten over the active plus orphaned union", () => {
		const roots = (count: number) =>
			Array.from({ length: count }, (_, index) => mcp(100 + index, 1));
		expect(inspect(sample(roots(9))).singleDigit).toBe(true);
		expect(inspect(sample(roots(10))).singleDigit).toBe(false);
	});

	it("fails closed when match and classifier-unknown rows coexist", () => {
		const missingBin = join(
			"/tmp",
			"fly2026-missing",
			"node_modules",
			".bin",
			"playwright-mcp",
		);
		const result = inspect(
			sample([
				mcp(20, 1),
				{
					pid: 30,
					ppid: 1,
					comm: "/usr/bin/node",
					command: `/usr/bin/node ${missingBin}`,
				},
			]),
		);
		expect(result.status).toBe("unknown");
		expect(result.singleDigit).toBeNull();
		expect(result.errors.join("\n")).toContain("filesystem_probe_failed");
	});

	it("fails closed when an exact Playwright MCP package token has an unknown wrapper shape", () => {
		const result = inspect(
			sample([
				claude(),
				{
					pid: 20,
					ppid: 10,
					comm: "/opt/homebrew/bin/npx",
					command: "/opt/homebrew/bin/npx -y @playwright/mcp@latest",
				},
				child(21, 20),
			]),
		);

		expect(result.status).toBe("unknown");
		expect(result.singleDigit).toBeNull();
		expect(result.errors).toContain(
			"classifier:pid=20:unmatched_playwright_mcp_package_token",
		);
	});

	it("does not let an unrelated process carrying a package token poison the census", () => {
		const result = inspect(
			sample([
				{
					pid: 20,
					ppid: 1,
					comm: "/usr/bin/sleep",
					command: "/usr/bin/sleep @playwright/mcp@latest",
				},
				{
					pid: 21,
					ppid: 1,
					comm: "/opt/homebrew/bin/npm",
					command: "/opt/homebrew/bin/npm install @playwright/mcp@0.0.79",
				},
			]),
		);

		expect(result.status).toBe("ok");
		expect(result.singleDigit).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("fails closed when a recognized package-local shape fails integrity", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2026-shaped-no-match-"));
		const bin = join(root, "node_modules", ".bin", "playwright-mcp");
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		writeFileSync(bin, "not a symlink\n");

		try {
			const result = inspect(
				sample([
					{
						pid: 20,
						ppid: 1,
						comm: "/usr/bin/node",
						command: `/usr/bin/node ${bin}`,
					},
				]),
			);

			expect(result.status).toBe("unknown");
			expect(result.errors).toContain(
				"classifier:pid=20:integrity_check_failed:bin_not_symlink",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a candidate-relevant missing join", () => {
		const sweep = sample([playwrightChrome(30, 1)]);
		const result = inspect({ ...sweep, age: ok(new Map()) });
		expect(result.status).toBe("unknown");
		expect(result.errors).toContain("join:pid=30:missing=age");
	});

	it("fails closed when an agent-browser profile is missing from the comm pass", () => {
		const sweep = sample([
			agentBrowserChrome(
				50,
				1,
				"/var/folders/xx/T/agent-browser-chrome-unattributed",
			),
		]);
		const commRows = new Map(sweep.comm.status === "ok" ? sweep.comm.rows : []);
		commRows.delete(50);

		const result = inspect({ ...sweep, comm: ok(commRows) });

		expect(result.status).toBe("unknown");
		expect(result.errors).toContain("join:pid=50:missing=comm");
	});

	it("does not let a large external tree change the in-scope threshold", () => {
		const rows: FixtureRow[] = [cursor()];
		for (let index = 0; index < 10; index++) rows.push(mcp(100 + index, 10));
		const result = inspect(sample(rows));
		expect(result.external.processes).toHaveLength(10);
		expect(result.inScopeProcessCount).toBe(0);
		expect(result.singleDigit).toBe(true);
	});

	it("reuses the MCP teardown argv splitter", () => {
		const command = "/opt/homebrew/bin/npm exec @playwright/mcp@latest";
		const parsed = parseMcpPsProcessRow(
			`20 10 00:01 Mon Aug 24 10:00:00 2026 ${command}`,
		);
		expect(parsed).not.toBeNull();
		expect(splitMcpPsCommand(command)).toEqual(parsed?.argv);
	});

	it("derives an absolute start epoch from the observation clock and age", () => {
		const result = inspect(sample([{ ...mcp(20, 1), ageMs: 125_000 }]));
		expect(result.orphanedManaged.playwrightMcpRoots[0]).toMatchObject({
			pid: 20,
			lstart: START,
			startedAtEpochMs: OBSERVED_AT_EPOCH_MS - 125_000,
		});
	});

	it("collects one shared sweep and uses one injected observation clock", async () => {
		const sweep = sample([mcp(20, 1)]);
		const collectSample = vi.fn(async () => sweep);
		const nowMs = vi.fn(() => OBSERVED_AT_EPOCH_MS);

		const result = await collectBrowserIdleCensus({
			collectSample,
			nowMs,
			playwrightProfileRoot: PLAYWRIGHT_ROOT,
		});

		expect(collectSample).toHaveBeenCalledOnce();
		expect(nowMs).toHaveBeenCalledOnce();
		expect(result.observedAtEpochMs).toBe(OBSERVED_AT_EPOCH_MS);
		expect(result.orphanedManaged.playwrightMcpRoots).toHaveLength(1);
	});
});
