import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
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
							(r) => `${r.pid} 1 ${r.pgid ?? r.pid} 501 S ${r.start ?? start}`,
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
		const promise = runExecutionProbeCommand(
			"/bin/ps",
			[],
			{ timeoutMs: 5 },
			(() => child) as never,
		).catch(() => {
			settled = true;
		});
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
