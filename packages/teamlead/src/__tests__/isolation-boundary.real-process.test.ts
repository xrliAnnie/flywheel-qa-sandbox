import {
	execFileSync,
	type SpawnSyncOptionsWithStringEncoding,
	spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	assertIsolationBoundaryAtBoot,
	codexSessionStateDir,
	type IsolationBootContractEntry,
	resolveDaemonSocketPath,
	resolveExecutionCodexHome,
} from "flywheel-claude-runner";
import { afterAll, describe, expect, it } from "vitest";
import {
	defaultListCodexAppServerProcesses,
	defaultListCodexDaemonLedgers,
	defaultListCodexHomeExecutionIds,
	defaultSocketHolderPids,
	sweepCodexRunnerOrphans,
} from "../bridge/codex-runner-orphan-reaper.js";
import {
	cleanupExactWorkflowTmuxWindow,
	killTmuxWindow,
} from "../bridge/tmux-lookup.js";

function commandAvailable(command: string): boolean {
	return (
		spawnSync(command, [command === "tmux" ? "-V" : "-v"], {
			stdio: "ignore",
		}).status === 0
	);
}

const hasRealTools = commandAvailable("tmux") && commandAvailable("lsof");
const hasProcessListing =
	spawnSync(
		"ps",
		["-o", "pid=,ppid=,pgid=,etime=,command=", "-p", String(process.pid)],
		{ stdio: "ignore" },
	).status === 0;
if (process.env.CI && !hasRealTools) {
	throw new Error(
		"FLY-2454 real-process CI guard requires working tmux and lsof binaries",
	);
}
if (process.env.CI && !hasProcessListing) {
	throw new Error(
		"FLY-2454 real-process CI guard requires working ps process inspection",
	);
}
const describeReal = hasRealTools ? describe : describe.skip;
const itCodex = hasProcessListing ? it : it.skip;
const commandOptions: SpawnSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	timeout: 5_000,
};

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for real-process fixture");
}

function readLedger(root: string): Array<Record<string, unknown>> {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => name.endsWith(".ndjson"))
		.flatMap((name) =>
			readFileSync(join(root, name), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		);
}

function tmuxEnv(root: string): NodeJS.ProcessEnv {
	const env = { ...process.env, TMUX_TMPDIR: root };
	delete env.FLYWHEEL_ISOLATION_ROOT;
	delete env.FLYWHEEL_KILL_LEDGER_ROOT;
	delete env.TMUX;
	delete env.TMUX_PANE;
	delete env.FLYWHEEL_TMUX_SOCKET_OVERRIDE;
	return env;
}

function runTmux(
	args: string[],
	env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
	const result = spawnSync("tmux", args, { ...commandOptions, env });
	if (result.status !== 0) {
		throw new Error(
			`tmux ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
		);
	}
	return result;
}

function tmuxWindowExists(socket: string, target: string): boolean {
	const result = spawnSync(
		"tmux",
		["-S", socket, "display-message", "-p", "-t", target, "#{window_id}"],
		{ encoding: "utf8" },
	);
	return result.status === 0 && result.stdout.trim() === target;
}

describeReal("FLY-2454 real cross-slot mutation boundary", () => {
	const roots: string[] = [];
	let successfulCases = 0;
	let holderPid = 0;
	let holderPgid = 0;
	let tmuxSocket = "";

	afterAll(() => {
		if (holderPgid > 1 && processAlive(holderPid)) {
			try {
				process.kill(-holderPgid, "SIGKILL");
			} catch {
				// The RED control may already have reaped the fixture.
			}
		}
		if (tmuxSocket) {
			spawnSync("tmux", ["-S", tmuxSocket, "kill-server"], {
				stdio: "ignore",
			});
		}
		const expectedCases = hasProcessListing ? 3 : 2;
		if (successfulCases === expectedCases) {
			for (const root of roots) rmSync(root, { recursive: true, force: true });
		} else {
			console.error(
				`[FLY-2454] retained failed real-process fixtures: ${roots.join(", ")}`,
			);
		}
	});

	itCodex(
		"2231 ppid-rewritten: blocks the real orphan reaper, while production mode reaps the same holder",
		async () => {
			const rootA = realpathSync(mkdtempSync("/tmp/fly2454-codex-A-"));
			const rootB = realpathSync(mkdtempSync("/tmp/fly2454-codex-B-"));
			roots.push(rootA, rootB);
			const executionId = `fly2454-${randomUUID()}`;
			const envA: NodeJS.ProcessEnv = {
				...process.env,
				FLYWHEEL_CODEX_HOMES_ROOT: join(rootA, "codex-homes"),
				FLYWHEEL_CODEX_SESSION_DIR: join(rootA, "codex-sessions"),
				FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(rootA, "cdx-sock"),
			};
			delete envA.FLYWHEEL_ISOLATION_ROOT;
			delete envA.FLYWHEEL_KILL_LEDGER_ROOT;
			const socketPath = resolveDaemonSocketPath(executionId, envA);
			const fixtureDir = join(rootA, "holder");
			const pidPath = join(fixtureDir, "pid");
			mkdirSync(fixtureDir, { recursive: true });
			mkdirSync(join(rootA, "cdx-sock"), { recursive: true });
			symlinkSync(process.execPath, join(fixtureDir, "codex"));
			writeFileSync(
				join(fixtureDir, "app-server"),
				[
					'const fs = require("node:fs");',
					'const net = require("node:net");',
					'const raw = process.argv[process.argv.indexOf("--listen") + 1];',
					'const socket = raw.replace(/^unix:\\/\\//, "");',
					"try { fs.unlinkSync(socket); } catch {}",
					"net.createServer(() => {}).listen(socket);",
					"setInterval(() => {}, 60_000);",
				].join("\n"),
			);
			writeFileSync(
				join(fixtureDir, "launcher.cjs"),
				[
					'const fs = require("node:fs");',
					'const { spawn } = require("node:child_process");',
					"const [codex, socket, pidPath, cwd] = process.argv.slice(2);",
					'const child = spawn(codex, ["app-server", "--remote-control", "--listen", "unix://" + socket], { cwd, detached: true, stdio: "ignore" });',
					"child.unref();",
					"fs.writeFileSync(pidPath, String(child.pid));",
				].join("\n"),
			);
			const launch = spawnSync(
				process.execPath,
				[
					join(fixtureDir, "launcher.cjs"),
					join(fixtureDir, "codex"),
					socketPath,
					pidPath,
					fixtureDir,
				],
				commandOptions,
			);
			expect(launch.status).toBe(0);
			holderPid = Number(readFileSync(pidPath, "utf8"));
			await waitFor(() => existsSync(socketPath) && processAlive(holderPid));
			const psIdentity = execFileSync(
				"ps",
				["-o", "ppid=,pgid=,command=", "-p", String(holderPid)],
				{ encoding: "utf8" },
			).trim();
			const identityMatch = psIdentity.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
			expect(identityMatch).not.toBeNull();
			holderPgid = Number(identityMatch?.[2]);
			expect(holderPgid).toBe(holderPid);

			const sessionDir = codexSessionStateDir(executionId, envA);
			const homeResolution = resolveExecutionCodexHome(
				executionId,
				undefined,
				envA,
			);
			expect(homeResolution.kind).toBe("legacy");
			if (homeResolution.kind !== "legacy")
				throw new Error("fixture home unresolved");
			mkdirSync(sessionDir, { recursive: true });
			mkdirSync(homeResolution.home, { recursive: true });
			writeFileSync(
				join(sessionDir, "session.json"),
				`${JSON.stringify({ executionId, daemonPgid: holderPgid })}\n`,
			);

			const [processProbe, ledgerProbe, homeProbe, holderProbe] =
				await Promise.all([
					defaultListCodexAppServerProcesses(),
					defaultListCodexDaemonLedgers(envA),
					defaultListCodexHomeExecutionIds(envA),
					defaultSocketHolderPids(socketPath),
				]);
			expect(processProbe.status).toBe("ok");
			if (processProbe.status !== "ok") throw new Error(processProbe.error);
			const realRow = processProbe.rows.find((row) => row.pid === holderPid);
			expect(realRow?.command).toContain("codex app-server");
			expect(realRow?.command).toContain(`unix://${socketPath}`);
			expect(realRow?.ppid).toBeGreaterThanOrEqual(0);
			expect(ledgerProbe).toMatchObject({
				status: "ok",
				ledgers: [{ executionId, daemonPgid: holderPgid }],
			});
			expect(homeProbe).toMatchObject({ status: "ok" });
			if (homeProbe.status === "ok") {
				expect(homeProbe.executionIds).toContain(executionId);
			}
			expect(holderProbe).toMatchObject({ status: "ok" });
			if (holderProbe.status === "ok")
				expect(holderProbe.pids).toContain(holderPid);
			const activeExecutionIds = new Set<string>();
			expect(activeExecutionIds.size).toBe(0);

			const listProcesses = async () => {
				const probe = await defaultListCodexAppServerProcesses();
				if (probe.status !== "ok") return probe;
				return {
					status: "ok" as const,
					rows: probe.rows.map((row) =>
						row.pid === holderPid ? { ...row, ppid: 1 } : row,
					),
				};
			};
			const ledgerRoot = join(rootB, "kill-ledger");
			const audits: string[] = [];
			const isolated = await sweepCodexRunnerOrphans(
				{ activeExecutionIds },
				{
					env: {
						...envA,
						FLYWHEEL_ISOLATION_ROOT: rootB,
						FLYWHEEL_KILL_LEDGER_ROOT: ledgerRoot,
					},
					listProcesses,
					minElapsedSeconds: 0,
					termGraceMs: 25,
					killConfirmMs: 25,
					audit: (event) => audits.push(event),
				},
			);
			expect(isolated).toMatchObject({ reaped: 0, boundaryRefused: 1 });
			expect(processAlive(holderPid)).toBe(true);
			expect(await defaultSocketHolderPids(socketPath)).toMatchObject({
				status: "ok",
				pids: expect.arrayContaining([holderPid]),
			});
			expect(audits).toContain("isolation_boundary_refused");
			expect(readLedger(ledgerRoot)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						refusal: "isolation_boundary",
						refusalReason: "outside_root",
					}),
				]),
			);

			const production = await sweepCodexRunnerOrphans(
				{ activeExecutionIds },
				{
					env: { ...envA, FLYWHEEL_KILL_LEDGER_ROOT: ledgerRoot },
					listProcesses,
					minElapsedSeconds: 0,
					termGraceMs: 25,
					killConfirmMs: 25,
				},
			);
			expect(production.reaped).toBe(1);
			await waitFor(() => !processAlive(holderPid));
			expect(existsSync(socketPath)).toBe(false);
			successfulCases++;
		},
		20_000,
	);

	it("2287: blocks both exact-socket and plain real-tmux kills, while production mode kills them", async () => {
		const rootA = realpathSync(mkdtempSync("/tmp/fly2454-tmux-A-"));
		const rootB = realpathSync(mkdtempSync("/tmp/fly2454-tmux-B-"));
		roots.push(rootA, rootB);
		const envA = tmuxEnv(rootA);
		const session = `fly2454-${randomUUID().slice(0, 8)}`;
		runTmux(
			["new-session", "-d", "-s", session, "-n", "sentinel", "sleep", "600"],
			envA,
		);
		tmuxSocket = String(
			runTmux(["display-message", "-p", "#{socket_path}"], envA).stdout,
		).trim();
		expect(tmuxSocket).toBe(
			join(rootA, `tmux-${process.getuid?.() ?? 0}`, "default"),
		);
		const serverStartTime = String(
			runTmux(["display-message", "-p", "#{start_time}"], envA).stdout,
		).trim();
		const workflowId = String(
			runTmux(
				[
					"new-window",
					"-d",
					"-P",
					"-F",
					"#{window_id}",
					"-t",
					session,
					"sleep",
					"600",
				],
				envA,
			).stdout,
		).trim();
		const executionId = `exec-${randomUUID()}`;
		const fingerprint = "a".repeat(64);
		const exactWorkflowTarget = `=${session}:${workflowId}`;
		for (const [name, value] of [
			["@flywheel_exec_id", executionId],
			["@flywheel_launch_generation", "1"],
			["@flywheel_launch_fingerprint", fingerprint],
		] as const) {
			runTmux(
				["set-option", "-w", "-t", exactWorkflowTarget, name, value],
				envA,
			);
		}
		expect(
			String(
				runTmux(
					[
						"display-message",
						"-p",
						"-t",
						exactWorkflowTarget,
						"#{window_id}|#{@flywheel_exec_id}|#{@flywheel_launch_generation}|#{@flywheel_launch_fingerprint}",
					],
					envA,
				).stdout,
			).trim(),
		).toBe(`${workflowId}|${executionId}|1|${fingerprint}`);
		const isolatedEnv = {
			...envA,
			FLYWHEEL_ISOLATION_ROOT: rootB,
			FLYWHEEL_KILL_LEDGER_ROOT: join(rootB, "kill-ledger"),
		};
		const identity = {
			socketPath: tmuxSocket,
			serverStartTime,
			windowId: workflowId,
			executionId,
			launchGeneration: 1,
			launchFingerprint: fingerprint,
		};
		await expect(
			cleanupExactWorkflowTmuxWindow(
				identity,
				undefined,
				undefined,
				isolatedEnv,
			),
		).resolves.toBe("unknown");
		expect(tmuxWindowExists(tmuxSocket, workflowId)).toBe(true);
		expect(readLedger(join(rootB, "kill-ledger"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "tmux_lookup_workflow_cleanup",
					target: `${tmuxSocket}:${workflowId}`,
					refusal: "isolation_boundary",
					refusalReason: "outside_root",
				}),
			]),
		);
		await expect(
			cleanupExactWorkflowTmuxWindow(identity, undefined, undefined, {
				...envA,
				FLYWHEEL_KILL_LEDGER_ROOT: join(rootB, "kill-ledger"),
			}),
		).resolves.toBe("cleaned");

		const plainId = String(
			runTmux(
				[
					"new-window",
					"-d",
					"-P",
					"-F",
					"#{window_id}",
					"-t",
					session,
					"sleep",
					"600",
				],
				envA,
			).stdout,
		).trim();
		const plainTarget = `${session}:${plainId}`;
		await expect(
			killTmuxWindow(plainTarget, { env: isolatedEnv }),
		).resolves.toMatchObject({
			killed: false,
			error: "outside_root",
		});
		expect(tmuxWindowExists(tmuxSocket, plainId)).toBe(true);
		await expect(
			killTmuxWindow(plainTarget, {
				env: {
					...envA,
					FLYWHEEL_KILL_LEDGER_ROOT: join(rootB, "kill-ledger"),
				},
			}),
		).resolves.toEqual({ killed: true });
		expect(tmuxWindowExists(tmuxSocket, plainId)).toBe(false);
		expect(readLedger(join(rootB, "kill-ledger"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "tmux_lookup",
					target: plainTarget,
					refusal: "isolation_boundary",
					refusalReason: "outside_root",
				}),
			]),
		);
		successfulCases++;
	});

	it("2287 boot fence rejects a CommDB root from the other slot", () => {
		const rootA = realpathSync(mkdtempSync("/tmp/fly2454-boot-A-"));
		const rootB = realpathSync(mkdtempSync("/tmp/fly2454-boot-B-"));
		roots.push(rootA, rootB);
		mkdirSync(join(rootA, "comm"));
		mkdirSync(join(rootB, "comm"));
		const contract: readonly IsolationBootContractEntry[] = [
			{ name: "FLYWHEEL_COMM_ROOT", boot: "mustBeUnderRoot" },
		];
		expect(
			assertIsolationBoundaryAtBoot(
				{
					FLYWHEEL_ISOLATION_ROOT: rootB,
					FLYWHEEL_COMM_ROOT: join(rootA, "comm"),
				},
				contract,
			),
		).toEqual({
			ok: false,
			offenders: [
				{
					name: "FLYWHEEL_COMM_ROOT",
					value: join(rootA, "comm"),
					kind: "outside_root",
				},
			],
		});
		expect(
			assertIsolationBoundaryAtBoot(
				{
					FLYWHEEL_ISOLATION_ROOT: rootB,
					FLYWHEEL_COMM_ROOT: join(rootB, "comm"),
				},
				contract,
			),
		).toEqual({ ok: true, mode: "isolated" });
		successfulCases++;
	});
});
