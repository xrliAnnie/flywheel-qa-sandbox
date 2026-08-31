import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDaemonSocketPath } from "flywheel-claude-runner";
import { describe, expect, it, vi } from "vitest";
import {
	CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS,
	type CodexAppServerProcess,
	parseCodexAppServerProcessRow,
	sweepCodexRunnerOrphans,
} from "../codex-runner-orphan-reaper.js";

function testEnv(root: string): NodeJS.ProcessEnv {
	return {
		FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(root, "sockets"),
		FLYWHEEL_CODEX_SESSION_DIR: join(root, "sessions"),
		FLYWHEEL_CODEX_HOMES_ROOT: join(root, "homes"),
	};
}

function appServerProcess(input: {
	executionId: string;
	env: NodeJS.ProcessEnv;
	pid?: number;
	pgid?: number;
	ppid?: number;
	elapsedSeconds?: number;
	socketPath?: string;
}): CodexAppServerProcess {
	const pid = input.pid ?? 92593;
	return {
		pid,
		ppid: input.ppid ?? 1,
		pgid: input.pgid ?? pid,
		elapsedSeconds:
			input.elapsedSeconds ?? CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS + 1,
		command: [
			"/Applications/Codex.app/Contents/Resources/codex",
			"app-server",
			"--remote-control",
			"--listen",
			`unix://${input.socketPath ?? resolveDaemonSocketPath(input.executionId, input.env)}`,
		].join(" "),
	};
}

function tuiClientProcess(input: {
	executionId: string;
	env: NodeJS.ProcessEnv;
	pid: number;
}): CodexAppServerProcess {
	const socketPath = resolveDaemonSocketPath(input.executionId, input.env);
	return {
		pid: input.pid,
		ppid: 1,
		pgid: input.pid,
		elapsedSeconds: CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS + 1,
		command: `/Applications/Codex.app/Contents/Resources/codex resume --remote unix://${socketPath} thread-1`,
	};
}

function harness(input: {
	env: NodeJS.ProcessEnv;
	rows: CodexAppServerProcess[];
	ledgers?: Array<{ executionId: string; daemonPgid: number }>;
	homeExecutionIds?: string[];
}) {
	let rows = [...input.rows];
	const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
	const removed: string[] = [];
	const audit = vi.fn();
	return {
		deps: {
			env: input.env,
			listLedgers: async () => ({
				status: "ok" as const,
				ledgers: input.ledgers ?? [],
			}),
			listHomes: async () => ({
				status: "ok" as const,
				executionIds:
					input.homeExecutionIds ??
					(input.ledgers ?? []).map((ledger) => ledger.executionId),
			}),
			listProcesses: async () => ({ status: "ok" as const, rows: [...rows] }),
			socketHolderPids: async (socketPath: string) => ({
				status: "ok" as const,
				pids: rows
					.filter((row) => row.command.includes(`unix://${socketPath}`))
					.map((row) => row.pid),
			}),
			signalGroup: (pgid: number, signal: NodeJS.Signals) => {
				signals.push({ pgid, signal });
				if (signal === "SIGTERM")
					rows = rows.filter((row) => row.pgid !== pgid);
				return true;
			},
			sleep: async () => undefined,
			removeSocket: (path: string) => removed.push(path),
			audit,
		},
		signals,
		removed,
		audit,
		setRows(next: CodexAppServerProcess[]) {
			rows = [...next];
		},
	};
}

describe("parseCodexAppServerProcessRow", () => {
	it("parses the BSD ps shape used by the production sweep", () => {
		const row = parseCodexAppServerProcessRow(
			" 92593 1 92593 11:30:00 /opt/codex app-server --remote-control --listen unix:///tmp/a.sock CODEX_HOME=/tmp/home",
		);
		expect(row).toEqual({
			pid: 92593,
			ppid: 1,
			pgid: 92593,
			elapsedSeconds: 41_400,
			command:
				"/opt/codex app-server --remote-control --listen unix:///tmp/a.sock CODEX_HOME=/tmp/home",
		});
	});
});

describe("sweepCodexRunnerOrphans", () => {
	it("reaps a stale ledger-owned app-server after exact group, socket, and CODEX_HOME proof", async () => {
		const env = testEnv("/tmp/fly2169-positive");
		const executionId = "terminal-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			ledgers: [{ executionId, daemonPgid: process.pgid }],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.reaped).toBe(1);
		expect(h.signals).toEqual([{ pgid: process.pgid, signal: "SIGTERM" }]);
		expect(h.removed).toEqual([resolveDaemonSocketPath(executionId, env)]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_reaped",
			expect.objectContaining({ executionId, source: "ledger" }),
		);
	});

	it("reaps an old reparented app-server whose ledger was deleted", async () => {
		const env = testEnv("/tmp/fly2169-reverse");
		const executionId = "deleted-ledger-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.reaped).toBe(1);
		expect(h.signals).toEqual([{ pgid: process.pgid, signal: "SIGTERM" }]);
		expect(h.removed).toEqual([resolveDaemonSocketPath(executionId, env)]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_reaped",
			expect.objectContaining({ executionId, source: "process" }),
		);
	});

	it("does not touch a healthy active runner daemon", async () => {
		const env = testEnv("/tmp/fly2169-healthy");
		const executionId = "healthy-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			ledgers: [{ executionId, daemonPgid: process.pgid }],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set([executionId]) },
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(h.signals).toEqual([]);
		expect(h.removed).toEqual([]);
	});

	it("rechecks active runway ownership immediately before signaling", async () => {
		const env = testEnv("/tmp/fly2169-readopt-race");
		const executionId = "newly-readopted-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{
				activeExecutionIds: new Set(),
				isExecutionActive: (candidate) => candidate === executionId,
			},
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(h.signals).toEqual([]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_readopted",
			expect.objectContaining({ executionId }),
		);
	});

	it("does not touch a reverse-axis process below the orphan age floor", async () => {
		const env = testEnv("/tmp/fly2169-young");
		const executionId = "young-exec";
		const process = appServerProcess({
			executionId,
			env,
			elapsedSeconds: CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS - 1,
		});
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(h.signals).toEqual([]);
	});

	it.each([
		{ ppid: 5126, elapsedSeconds: 5 * 60 * 60, reason: "still parented" },
		{
			ppid: 1,
			elapsedSeconds: CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS - 1,
			reason: "below the age floor",
		},
	])("does not touch a ledger-owned daemon that is $reason", async (shape) => {
		const env = testEnv(`/tmp/fly2169-ledger-${shape.ppid}`);
		const executionId = `ledger-${shape.reason.replaceAll(" ", "-")}`;
		const process = appServerProcess({ executionId, env, ...shape });
		const h = harness({
			env,
			rows: [process],
			ledgers: [{ executionId, daemonPgid: process.pgid }],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(h.signals).toEqual([]);
	});

	it("refuses a recycled pgid when the ledger group argv is not Codex app-server", async () => {
		const env = testEnv("/tmp/fly2169-recycled");
		const executionId = "old-exec";
		const recycled: CodexAppServerProcess = {
			pid: 31337,
			ppid: 1,
			pgid: 31337,
			elapsedSeconds: 99_999,
			command: "/usr/bin/python3 unrelated-worker.py",
		};
		const h = harness({
			env,
			rows: [recycled],
			ledgers: [{ executionId, daemonPgid: recycled.pgid }],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.identityMismatchSkipped).toBe(1);
		expect(h.signals).toEqual([]);
		expect(h.removed).toEqual([]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_identity_mismatch",
			expect.objectContaining({ executionId, pgid: recycled.pgid }),
		);
	});

	it("refuses a matching socket without a canonical CODEX_HOME inventory mapping", async () => {
		const env = testEnv("/tmp/fly2169-home-mismatch");
		const executionId = "old-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			ledgers: [{ executionId, daemonPgid: process.pgid }],
			homeExecutionIds: ["different-exec"],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.identityMismatchSkipped).toBe(1);
		expect(h.signals).toEqual([]);
	});

	it("does not audit a non-runner app-server outside the Flywheel socket root", async () => {
		const env = testEnv("/tmp/fly2169-unparseable");
		const executionId = "unparseable-exec";
		const process = appServerProcess({ executionId, env });
		process.command = process.command.replace(
			`--listen unix://${resolveDaemonSocketPath(executionId, env)}`,
			"--listen unix:///tmp/codex-lead-sidecar.sock",
		);
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: [executionId],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.unparseableSkipped).toBe(1);
		expect(h.signals).toEqual([]);
		expect(h.audit).not.toHaveBeenCalledWith(
			"codex_app_server_orphan_unparseable",
			expect.anything(),
		);
	});

	it("audits an unknown app-server socket inside the Flywheel socket root", async () => {
		const env = testEnv("/tmp/fly2169-root-unknown");
		const executionId = "unknown-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: ["different-exec"],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.unparseableSkipped).toBe(1);
		expect(h.signals).toEqual([]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_unparseable",
			expect.objectContaining({
				pid: process.pid,
				socketPath: resolveDaemonSocketPath(executionId, env),
			}),
		);
	});

	it("rechecks the exact process identity before signaling", async () => {
		const env = testEnv("/tmp/fly2169-freshness");
		const executionId = "freshness-exec";
		const process = appServerProcess({ executionId, env });
		let calls = 0;
		const signalGroup = vi.fn(() => true);
		const audit = vi.fn();

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			{
				env,
				listLedgers: async () => ({ status: "ok", ledgers: [] }),
				listHomes: async () => ({
					status: "ok",
					executionIds: [executionId],
				}),
				listProcesses: async () => {
					calls++;
					return calls === 1
						? { status: "ok", rows: [process] }
						: {
								status: "ok",
								rows: [
									{
										...process,
										command: "/usr/bin/python3 recycled.py",
									},
								],
							};
				},
				socketHolderPids: async () => ({
					status: "ok",
					pids: [process.pid],
				}),
				signalGroup,
				sleep: async () => undefined,
				removeSocket: vi.fn(),
				audit,
			},
		);

		expect(result.identityMismatchSkipped).toBe(1);
		expect(signalGroup).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_identity_changed",
			expect.objectContaining({ pid: process.pid, pgid: process.pgid }),
		);
	});

	it("refuses to signal when fresh lsof does not prove the exact pid holds the socket", async () => {
		const env = testEnv("/tmp/fly2169-holder-mismatch");
		const executionId = "holder-mismatch-exec";
		const process = appServerProcess({ executionId, env });
		const h = harness({
			env,
			rows: [process],
			homeExecutionIds: [executionId],
		});
		h.deps.socketHolderPids = async () => ({
			status: "ok",
			pids: [process.pid + 1],
		});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			h.deps,
		);

		expect(result.identityMismatchSkipped).toBe(1);
		expect(h.signals).toEqual([]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_socket_holder_mismatch",
			expect.objectContaining({
				pid: process.pid,
				socketPath: resolveDaemonSocketPath(executionId, env),
			}),
		);
	});

	it("re-proves argv and socket ownership before escalating a TERM survivor to KILL", async () => {
		const env = testEnv("/tmp/fly2169-kill");
		const executionId = "kill-exec";
		const process = appServerProcess({ executionId, env });
		let rows = [process];
		const signals: NodeJS.Signals[] = [];
		const removeSocket = vi.fn();

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set() },
			{
				env,
				listLedgers: async () => ({ status: "ok", ledgers: [] }),
				listHomes: async () => ({
					status: "ok",
					executionIds: [executionId],
				}),
				listProcesses: async () => ({ status: "ok", rows: [...rows] }),
				socketHolderPids: async () => ({
					status: "ok",
					pids: rows.map((row) => row.pid),
				}),
				signalGroup: (_pgid, signal) => {
					signals.push(signal);
					if (signal === "SIGKILL") rows = [];
					return true;
				},
				sleep: async () => undefined,
				removeSocket,
			},
		);

		expect(result.reaped).toBe(1);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(removeSocket).toHaveBeenCalledWith(
			resolveDaemonSocketPath(executionId, env),
		);
	});

	it("reaps the App Server socket when only a native TUI client remains after TERM", async () => {
		const env = testEnv("/tmp/fly2168-tui-holder");
		const executionId = "tui-holder-exec";
		const server = appServerProcess({ executionId, env });
		const client = tuiClientProcess({
			executionId,
			env,
			pid: server.pid + 1,
		});
		const h = harness({
			env,
			rows: [server, client],
			homeExecutionIds: [executionId],
		});
		const active = vi.fn(() => false);

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set(), isExecutionActive: active },
			h.deps,
		);

		expect(result.reaped).toBe(1);
		expect(result.identityMismatchSkipped).toBe(0);
		expect(active).toHaveBeenCalledTimes(2);
		expect(h.removed).toEqual([resolveDaemonSocketPath(executionId, env)]);
	});

	it("fails closed before unlink when a TUI-held execution is readopted", async () => {
		const env = testEnv("/tmp/fly2168-tui-readopt");
		const executionId = "tui-readopt-exec";
		const server = appServerProcess({ executionId, env });
		const client = tuiClientProcess({
			executionId,
			env,
			pid: server.pid + 1,
		});
		const h = harness({
			env,
			rows: [server, client],
			homeExecutionIds: [executionId],
		});
		const active = vi
			.fn<(candidate: string) => boolean>()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set(), isExecutionActive: active },
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(active).toHaveBeenCalledTimes(2);
		expect(h.removed).toEqual([]);
		expect(h.audit).toHaveBeenCalledWith(
			"codex_app_server_orphan_readopted",
			expect.objectContaining({
				executionId,
				stage: "before_socket_cleanup",
			}),
		);
	});

	it("fails closed before unlink when the final readopt probe throws", async () => {
		const env = testEnv("/tmp/fly2168-tui-readopt-unknown");
		const executionId = "tui-readopt-unknown-exec";
		const server = appServerProcess({ executionId, env });
		const client = tuiClientProcess({
			executionId,
			env,
			pid: server.pid + 1,
		});
		const h = harness({
			env,
			rows: [server, client],
			homeExecutionIds: [executionId],
		});
		const active = vi
			.fn<(candidate: string) => boolean>()
			.mockReturnValueOnce(false)
			.mockImplementationOnce(() => {
				throw new Error("readopt DB unavailable");
			});

		const result = await sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set(), isExecutionActive: active },
			h.deps,
		);

		expect(result.reaped).toBe(0);
		expect(result.probeUnknown).toBe(1);
		expect(active).toHaveBeenCalledTimes(2);
		expect(h.removed).toEqual([]);
	});
});

describe("Bridge maintenance wiring", () => {
	it("runs the Codex orphan sweep on the existing guarded maintenance tick", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "plugin.ts"),
			"utf8",
		);
		const guard = source.indexOf("if (!worktreeAutocleanEnabled()) return;");
		const codexSweep = source.indexOf("await sweepCodexRunnerOrphans(", guard);
		const mcpSweep = source.indexOf("await reapMcpOrphans(", guard);

		expect(guard).toBeGreaterThan(-1);
		expect(codexSweep).toBeGreaterThan(guard);
		expect(mcpSweep).toBeGreaterThan(codexSweep);
		expect(source.slice(codexSweep, mcpSweep)).toMatch(
			/store\s*\.getReadoptCandidateSessions\(\)/,
		);
		expect(source.slice(codexSweep, mcpSweep)).not.toContain(
			'event !== "codex_app_server_orphan_reaped"',
		);
	});
});
