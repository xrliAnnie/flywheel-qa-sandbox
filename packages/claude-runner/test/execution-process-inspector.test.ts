import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as Inspector from "../src/execution-process-inspector.js";
import {
	bindSpawnedExecutionProcessGroup,
	captureExecutionProcessSample,
	type ExecutionProcessInspectorOptions,
	readExecutionProcessIdentity,
	runExecutionProbeCommand,
} from "../src/execution-process-inspector.js";
import type { ExecutionProcessBinding } from "../src/execution-process-liveness.js";

const start = "Sat Sep 26 10:00:00 2026";
const boot = "ABCDEF00-1234-4567-8901-ABCDEF123456";
const binding: ExecutionProcessBinding = {
	version: 1,
	adapter: "claude-tmux",
	pid: 42,
	pgid: 42,
	startIdentity: start,
	hostBootId: boot,
	executable: "/bin/claude",
	cwd: "/work",
	nonce: "nonce-42",
	nativeSessionId: null,
	writers: [],
};
type Row = {
	pid: number;
	pgid?: number;
	argv?: string;
	env?: string;
	start?: string;
	state?: string;
};
function fixture(rows: Row[] = [{ pid: 42 }]) {
	const calls: Array<{
		file: string;
		args: readonly string[];
		timeoutMs: number;
	}> = [];
	const options: ExecutionProcessInspectorOptions = {
		platform: "darwin",
		uid: 501,
		now: () => 1000,
		runCommand: async (file, args, control) => {
			calls.push({ file, args, timeoutMs: control.timeoutMs });
			if (file.endsWith("sysctl")) return { stdout: boot };
			if (file.endsWith("lsof"))
				return { stdout: "p42\nfcwd\nn/work\nftxt\nn/bin/claude\n" };
			if (args.includes("pid=,ppid=,pgid=,uid=,stat=,lstart="))
				return {
					stdout: rows
						.map(
							(r) =>
								`${r.pid} 1 ${r.pgid ?? r.pid} 501 ${r.state ?? "S"} ${r.start ?? start}`,
						)
						.join("\n"),
				};
			const withEnv = args.includes("-axwwE");
			return {
				stdout: rows
					.map(
						(r) =>
							`${r.pid} ${r.start ?? start} ${r.argv ?? "rewritten title"}${withEnv ? ` ${r.env ?? "PATH=/bin FLYWHEEL_EXECUTION_NONCE=nonce-42"}` : ""}`,
					)
					.join("\n"),
			};
		},
	};
	return { options, calls };
}
describe("execution process inspector", () => {
	it("FLY-2919 tracks legacy execution writers without inventing a launch nonce", async () => {
		const { options } = fixture([
			{ pid: 42, env: "PATH=/bin FLYWHEEL_EXEC_ID=exec-legacy" },
			{ pid: 88, env: "PATH=/bin FLYWHEEL_EXEC_ID=exec-legacy" },
			{ pid: 99, env: "PATH=/bin FLYWHEEL_EXEC_ID=other" },
		]);
		const sample = await captureExecutionProcessSample(
			{
				...binding,
				nonce: null,
				nativeSessionId: "11111111-2222-3333-4444-555555555555",
				legacyExecutionId: "exec-legacy",
			},
			{ ...options, executionId: "exec-legacy" },
		);
		expect(sample?.writersComplete).toBe(true);
		expect(sample?.discoveredWriters?.map((p) => p.pid)).toEqual([42, 88]);
		expect(sample?.nonceWriters).toEqual([]);
	});
	it("FLY-2919 refuses a second native worker appearing during legacy discovery", async () => {
		const nativeSessionId = "11111111-2222-3333-4444-555555555555";
		const rows: Row[] = [
			{
				pid: 42,
				argv: `/bin/claude --session-id ${nativeSessionId}`,
				env: "PATH=/bin FLYWHEEL_EXEC_ID=exec-legacy",
			},
		];
		const { options } = fixture(rows);
		let reads = 0;
		const candidate = await Inspector.discoverLegacyClaudeProcessBinding(
			{
				executionId: "exec-legacy",
				nativeSessionId,
				executable: "/bin/claude",
				cwd: "/work",
			},
			{
				...options,
				runCommand: async (f, a, c) => {
					if (
						a.includes("pid=,ppid=,pgid=,uid=,stat=,lstart=") &&
						++reads === 2
					)
						rows.push({ ...rows[0]!, pid: 43 });
					if (f.endsWith("lsof"))
						return {
							stdout: `p${a[a.indexOf("-p") + 1]}\nfcwd\nn/work\nftxt\nn/bin/claude\n`,
						};
					return options.runCommand!(f, a, c);
				},
			},
		);
		expect(candidate).toBeNull();
	});
	it.each([
		"unique",
		"missing",
		"ambiguous",
		"foreign_session",
		"foreign_execution",
		"foreign_executable",
		"foreign_cwd",
		"changed_start",
	])(
		"FLY-2919 independently discovers a legacy Claude body: %s",
		async (mode) => {
			const nativeSessionId = "11111111-2222-3333-4444-555555555555";
			const worker = {
				pid: 42,
				argv: `/bin/claude --session-id ${mode === "foreign_session" ? "other" : nativeSessionId}`,
				env: `PATH=/bin FLYWHEEL_EXEC_ID=${mode === "foreign_execution" ? "other" : "exec-legacy"}`,
			};
			const { options } = fixture(
				mode === "missing"
					? [{ pid: 99, argv: "viewer", env: "PATH=/bin" }]
					: mode === "ambiguous"
						? [worker, { ...worker, pid: 43 }]
						: [worker],
			);
			let censusReads = 0;
			const candidate = await Inspector.discoverLegacyClaudeProcessBinding(
				{
					executionId: "exec-legacy",
					nativeSessionId,
					executable: "/bin/claude",
					cwd: "/work",
				},
				{
					...options,
					runCommand: async (f, a, c) => {
						if (f.endsWith("lsof"))
							return {
								stdout: `p${a[a.indexOf("-p") + 1]}\nfcwd\nn${mode === "foreign_cwd" ? "/foreign" : "/work"}\nftxt\nn${mode === "foreign_executable" ? "/bin/viewer" : "/bin/claude"}\n`,
							};
						const result = await options.runCommand!(f, a, c);
						if (
							a.includes("pid=,ppid=,pgid=,uid=,stat=,lstart=") &&
							++censusReads > 1 &&
							mode === "changed_start"
						)
							return {
								stdout: result.stdout.replaceAll(
									start,
									"Sat Sep 26 10:00:01 2026",
								),
							};
						return result;
					},
				},
			);
			if (mode === "unique")
				expect(candidate).toMatchObject({
					pid: 42,
					pgid: 42,
					nonce: null,
					nativeSessionId,
					legacyExecutionId: "exec-legacy",
					executable: "/bin/claude",
					cwd: "/work",
				});
			else expect(candidate).toBeNull();
		},
	);

	it.each([
		"native",
		"forked",
		"wrong_executable",
		"wrong_cwd",
		"wrong_nonce",
		"ambiguous",
		"wrong_group",
	])("binds only a proven %s launch", async (mode) => {
		const rows: Row[] =
			mode === "ambiguous"
				? [{ pid: 42 }, { pid: 43, pgid: 42 }]
				: [
						{
							pid: mode === "forked" ? 43 : 42,
							pgid: mode === "wrong_group" ? 90 : 42,
							env:
								mode === "wrong_nonce"
									? "PATH=/bin FLYWHEEL_EXECUTION_NONCE=foreign"
									: undefined,
						},
					];
		const { options } = fixture(rows);
		const result = await bindSpawnedExecutionProcessGroup(binding, {
			...options,
			runCommand: async (f, a, c) => {
				if (f.endsWith("lsof"))
					return {
						stdout: `p${a[a.indexOf("-p") + 1]}\nfcwd\nn${mode === "wrong_cwd" ? "/foreign" : "/work"}\nftxt\nn${mode === "wrong_executable" ? "/foreign" : "/bin/claude"}\n`,
					};
				return options.runCommand!(f, a, c);
			},
		});
		if (mode === "native" || mode === "forked")
			expect(result).toMatchObject({
				pid: mode === "forked" ? 43 : 42,
				pgid: 42,
				executable: "/bin/claude",
				nonce: "nonce-42",
			});
		else expect(result).toBeNull();
	});
	it.each(["same", "forked", "reused", "boot", "changed_during_sample"])(
		"ties a registered launch to its exact pre-exec leader: %s",
		async (mode) => {
			const { options } = fixture([
				{ pid: mode === "forked" ? 43 : 42, pgid: 42 },
			]);
			let censusReads = 0;
			const result = await bindSpawnedExecutionProcessGroup(
				{
					...binding,
					expectedLeader: {
						pid: 42,
						startIdentity: mode === "reused" ? "previous-start" : start,
						hostBootId: mode === "boot" ? "previous-boot" : boot,
					},
				},
				{
					...options,
					runCommand: async (f, a, c) => {
						const output = await options.runCommand!(f, a, c);
						if (f.endsWith("lsof"))
							return {
								stdout: output.stdout.replace(
									"p42",
									`p${a[a.indexOf("-p") + 1]}`,
								),
							};
						if (
							mode === "changed_during_sample" &&
							a.includes("pid=,ppid=,pgid=,uid=,stat=,lstart=") &&
							++censusReads > 1
						)
							return {
								stdout: output.stdout.replace(
									start,
									"Sat Sep 26 10:00:01 2026",
								),
							};
						return output;
					},
				},
			);
			if (mode === "same") expect(result?.pid).toBe(42);
			else expect(result).toBeNull();
		},
	);
	it("reads native identity independently of a rewritten process title", async () => {
		const { options } = fixture();
		expect(await readExecutionProcessIdentity(42, options)).toEqual({
			pid: 42,
			pgid: 42,
			startIdentity: start,
			hostBootId: boot,
			executable: "/bin/claude",
			cwd: "/work",
		});
	});
	it("rejects executable replacement during identity capture", async () => {
		const { options } = fixture();
		let reads = 0;
		expect(
			await readExecutionProcessIdentity(42, {
				...options,
				runCommand: async (f, a, c) => {
					const result = await options.runCommand!(f, a, c);
					return f.endsWith("lsof") && ++reads > 1
						? { stdout: result.stdout.replace("/bin/claude", "/bin/other") }
						: result;
				},
			}),
		).toBeNull();
	});
	it("reads Linux executable and cwd through proc links", async () => {
		const { options } = fixture();
		expect(
			await readExecutionProcessIdentity(42, {
				...options,
				platform: "linux",
				runCommand: async (f, a, c) => {
					if (f === "/bin/cat") return { stdout: boot };
					if (f.endsWith("readlink"))
						return {
							stdout: a[0]!.endsWith("/exe") ? "/bin/claude\n" : "/work\n",
						};
					return options.runCommand!(f, a, c);
				},
			}),
		).toMatchObject({
			executable: "/bin/claude",
			cwd: "/work",
			hostBootId: boot,
		});
	});
	it("samples live worker without any window evidence and discovers detached writers", async () => {
		const { options } = fixture([{ pid: 42 }, { pid: 90, pgid: 90 }]);
		const sample = await captureExecutionProcessSample(binding, options);
		expect(sample?.worker).toEqual({ executable: "/bin/claude", cwd: "/work" });
		expect(sample?.writersComplete).toBe(true);
		expect(sample?.discoveredWriters).toContainEqual({
			pid: 90,
			startIdentity: start,
			hostBootId: boot,
		});
	});
	it("does not let an unrelated same-uid process with hidden environment invalidate the binding census", async () => {
		const { options } = fixture([{ pid: 42 }, { pid: 90, pgid: 90, env: "" }]);
		const sample = await captureExecutionProcessSample(binding, options);
		expect(sample?.writersComplete).toBe(true);
		expect(sample?.worker).toEqual({ executable: "/bin/claude", cwd: "/work" });
	});
	it.each(["?", "?s", "?E", "?Es"])(
		"accepts the macOS ps question state %s as a live census row",
		async (state) => {
			const { options } = fixture([{ pid: 42, state }]);
			await expect(
				readExecutionProcessIdentity(42, options),
			).resolves.toMatchObject({
				pid: 42,
				pgid: 42,
			});
		},
	);
	it("retains previously bound detached writers even after their nonce disappears", async () => {
		const { options } = fixture([{ pid: 90, env: "PATH=/bin" }]);
		const sample = await captureExecutionProcessSample(
			{
				...binding,
				writers: [{ pid: 90, startIdentity: start, hostBootId: boot }],
			},
			options,
		);
		expect(sample?.worker).toBeNull();
		expect(sample?.discoveredWriters).toContainEqual({
			pid: 90,
			startIdentity: start,
			hostBootId: boot,
		});
	});
	it("never treats an argv-shaped nonce as environment evidence", async () => {
		const { options } = fixture([
			{
				pid: 90,
				argv: "tool FLYWHEEL_EXECUTION_NONCE=nonce-42",
				env: "PATH=/bin",
			},
		]);
		expect(
			(await captureExecutionProcessSample(binding, options))
				?.discoveredWriters,
		).toEqual([]);
	});
	it("excludes only explicitly registered viewers by exact identity", async () => {
		const { options } = fixture([
			{ pid: 90, pgid: 42, env: "PATH=/bin" },
			{ pid: 91, pgid: 42, argv: "dev-server" },
		]);
		const viewer = { pid: 90, startIdentity: start, hostBootId: boot };
		const sample = await captureExecutionProcessSample(binding, {
			...options,
			registeredViewers: [viewer],
		});
		expect(sample?.worker).toBeNull();
		expect(sample?.viewers).toEqual([viewer]);
		expect(sample?.discoveredWriters?.map((r) => r.pid)).toEqual([91]);
	});
	it("a registered viewer inheriting the launch nonce is still a writer", async () => {
		const { options } = fixture([{ pid: 90, pgid: 90 }]);
		const viewer = { pid: 90, startIdentity: start, hostBootId: boot };
		const sample = await captureExecutionProcessSample(binding, {
			...options,
			registeredViewers: [viewer],
		});
		expect(sample?.viewers).toEqual([]);
		expect(sample?.discoveredWriters).toEqual([viewer]);
	});
	it.each(["boot", "start", "pgid"])(
		"rejects a changed accepted %s identity",
		async (mismatch) => {
			const { options } = fixture();
			const bad = {
				...binding,
				...(mismatch === "boot"
					? { hostBootId: "other" }
					: mismatch === "start"
						? { startIdentity: "other" }
						: { pgid: 99 }),
			};
			expect(await captureExecutionProcessSample(bad, options)).toBeNull();
		},
	);
	it("fails closed on permissions, malformed and duplicate census rows", async () => {
		const { options } = fixture();
		for (const output of [
			"not a census",
			`42 1 42 501 nonsense ${start}`,
			`42 1 42 501 S ${start}\n42 1 42 501 S ${start}`,
		]) {
			expect(
				await captureExecutionProcessSample(binding, {
					...options,
					runCommand: async (file, args, c) =>
						args.includes("pid=,ppid=,pgid=,uid=,stat=,lstart=")
							? { stdout: output }
							: options.runCommand!(file, args, c),
				}),
			).toBeNull();
		}
		expect(
			await captureExecutionProcessSample(binding, {
				...options,
				runCommand: async () => {
					throw new Error("EPERM private argv");
				},
			}),
		).toBeNull();
	});
	it("cannot establish a complete nonce census with unstable argv or hidden environment", async () => {
		const { options } = fixture();
		let count = 0;
		const sample = await captureExecutionProcessSample(binding, {
			...options,
			runCommand: async (f, a, c) => {
				const result = await options.runCommand!(f, a, c);
				if (a.includes("-axww") && ++count === 2)
					return { stdout: `${42} ${start} changed` };
				return result;
			},
		});
		expect(sample?.writersComplete).toBe(false);
		const hidden = fixture([{ pid: 42, env: "" }]);
		expect(
			(await captureExecutionProcessSample(binding, hidden.options))
				?.writersComplete,
		).toBe(false);
	});
	it("passes one decreasing deadline capped at five seconds to every command", async () => {
		const { options, calls } = fixture();
		let time = 1000;
		const sample = await captureExecutionProcessSample(binding, {
			...options,
			deadlineMs: 9000,
			now: () => time,
			runCommand: async (f, a, c) => {
				const result = await options.runCommand!(f, a, c);
				time += 100;
				return result;
			},
		});
		expect(sample?.sampledAtMs).toBe(1000);
		expect(calls[0]!.timeoutMs).toBe(5000);
		expect(calls.at(-1)!.timeoutMs).toBeLessThan(5000);
	});
	it("rejects unsupported platforms and already-cancelled captures", async () => {
		const { options, calls } = fixture();
		expect(
			await readExecutionProcessIdentity(42, { ...options, platform: "win32" }),
		).toBeNull();
		expect(
			await captureExecutionProcessSample(binding, {
				...options,
				signal: AbortSignal.abort(),
			}),
		).toBeNull();
		expect(calls).toHaveLength(0);
	});
	it.each(["valid", "missing", "wrong-group", "wrong-holder", "absent"])(
		"uses bounded census/socket evidence with a %s Codex ledger",
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), "fly2919-inspector-"));
			try {
				const execId = "test-execution";
				mkdirSync(join(root, execId));
				if (mode !== "missing")
					writeFileSync(
						join(root, execId, "session.json"),
						JSON.stringify({ daemonPgid: mode === "wrong-group" ? 90 : 42 }),
					);
				const { options } = fixture(
					mode === "absent" ? [{ pid: 90, env: "PATH=/bin" }] : [{ pid: 42 }],
				);
				const sample = await captureExecutionProcessSample(
					{ ...binding, adapter: "codex-tmux" },
					{
						...options,
						executionId: execId,
						env: {
							FLYWHEEL_CODEX_SESSION_DIR: root,
							FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: root,
						},
						socketProbe: async () => mode !== "absent",
						runCommand: async (f, a, c) =>
							a.includes("-t")
								? { stdout: mode === "wrong-holder" ? "90\n" : "42\n" }
								: options.runCommand!(f, a, c),
					},
				);
				expect(sample?.daemon).toBe(
					mode === "valid" ? "alive" : mode === "absent" ? "absent" : "unknown",
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("rejects PID reuse during the socket probe", async () => {
		const { options } = fixture();
		let socketRead = false;
		const sample = await captureExecutionProcessSample(
			{ ...binding, adapter: "codex-tmux" },
			{
				...options,
				executionId: "test-execution",
				socketProbe: async () => {
					socketRead = true;
					return true;
				},
				runCommand: async (f, a, c) => {
					if (a.includes("-t")) return { stdout: "42\n" };
					const output = await options.runCommand!(f, a, c);
					return socketRead && a.includes("pid=,ppid=,pgid=,uid=,stat=,lstart=")
						? {
								stdout: output.stdout.replace(
									start,
									"Sat Sep 26 11:00:00 2026",
								),
							}
						: output;
				},
			},
		);
		expect(sample).toBeNull();
	});
	it("kills only its owned probe on timeout and waits for close before resolving", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 999,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
		});
		let settled = false;
		const spawnProbe = vi.fn(() => child);
		const promise = runExecutionProbeCommand(
			"/bin/ps",
			[],
			{ timeoutMs: 5 },
			spawnProbe as never,
		).catch(() => {
			settled = true;
		});
		expect(spawnProbe).toHaveBeenCalledWith(
			"/bin/ps",
			[],
			expect.objectContaining({
				env: expect.objectContaining({ TZ: "UTC0" }),
			}),
		);
		await new Promise((r) => setTimeout(r, 15));
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		await promise;
		expect(settled).toBe(true);
	});
	it("drains an owned probe before returning caller cancellation", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 999,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
		});
		const controller = new AbortController();
		const promise = runExecutionProbeCommand(
			"/bin/ps",
			[],
			{ timeoutMs: 1000, signal: controller.signal },
			(() => child) as never,
		);
		controller.abort();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		child.emit("close", null, "SIGKILL");
		await expect(promise).rejects.toThrow("process_probe_unavailable");
	});
});

describe("FLY-2919 failed native spawn absence", () => {
	it.each([
		"empty",
		"group_alive",
		"detached_writer",
		"argv_spoof",
		"environment_unknown",
		"socket_alive",
		"boot_changed",
	])("requires independent %s evidence", async (mode) => {
		const row: Row = { pid: 90, env: "PATH=/bin" };
		if (mode === "group_alive") row.pgid = 42;
		if (mode === "detached_writer")
			row.env = "PATH=/bin FLYWHEEL_EXECUTION_NONCE=nonce-42";
		if (mode === "argv_spoof")
			row.argv = "tool FLYWHEEL_EXECUTION_NONCE=nonce-42";
		if (mode === "environment_unknown") row.env = "";
		const { options } = fixture([row]);
		const result = await (Inspector as any).capturePendingExecutionSpawnAbsence(
			{
				hostBootId: mode === "boot_changed" ? "foreign-boot" : boot,
				nonce: "nonce-42",
				pgid: 42,
			},
			{
				...options,
				executionId: "exec-failed",
				socketProbe: async () => mode === "socket_alive",
			},
		);
		if (
			mode === "empty" ||
			mode === "argv_spoof" ||
			mode === "environment_unknown"
		)
			expect(result).toEqual({
				hostBootId: boot,
				nonce: "nonce-42",
				pgid: 42,
				observedAtMs: 1000,
				expiresAtMs: 11000,
			});
		else expect(result).toBeNull();
	});
	it("can prove a canceled pre-spawn permit with no group only when the nonce census is complete", async () => {
		const { options } = fixture([{ pid: 90, env: "PATH=/bin" }]);
		expect(
			await (Inspector as any).capturePendingExecutionSpawnAbsence(
				{ hostBootId: boot, nonce: "nonce-42", pgid: null },
				{
					...options,
					executionId: "exec-failed",
					socketProbe: async () => false,
				},
			),
		).toMatchObject({ pgid: null, nonce: "nonce-42" });
	});
});
