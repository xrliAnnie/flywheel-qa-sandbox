import {
	chmodSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Launch from "../src/execution-process-launch.js";
import {
	createExecutionProcessLaunchManifest,
	type ExecutionProcessLaunchRequest,
	readExecutionProcessLaunchCandidate,
	registerExecutionProcessLaunchCandidate,
	waitForExecutionProcessLaunchCandidate,
} from "../src/execution-process-launch.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const dirs: string[] = [];
const request: ExecutionProcessLaunchRequest = {
	version: 1,
	executionId: "exec-1",
	generation: 2,
	ownerToken: "owner-1",
	nonce: "nonce-1",
	adapter: "claude-tmux",
	binaryName: "claude",
	nativeSessionId: "session-1",
	cwd: "/work",
};
const native = {
	pid: 42,
	pgid: 42,
	startIdentity: "Sat Sep 26 10:00:00 2026",
	hostBootId: "boot-1",
	executable: "/bin/sh",
	cwd: "/work",
};
function manifest() {
	const directory = mkdtempSync(join(tmpdir(), "fly2919-a5-manifest-"));
	dirs.push(directory);
	return createExecutionProcessLaunchManifest(directory, request);
}
afterEach(() => {
	for (const path of dirs.splice(0))
		rmSync(path, { recursive: true, force: true });
});
describe("FLY-2919 provisional tmux process launch", () => {
	it("atomically records the supplied shell PID with OS identity, never the helper PID", async () => {
		const m = manifest();
		await registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
			launchArgv: ["claude", "--session-id", "session-1"],
			readIdentity: async (pid) => {
				expect(pid).toBe(42);
				return native;
			},
		});
		const candidate = readExecutionProcessLaunchCandidate(m);
		expect(candidate).toEqual({
			...request,
			pid: 42,
			pgid: 42,
			startIdentity: native.startIdentity,
			hostBootId: "boot-1",
			shellExecutable: "/bin/sh",
		});
		expect(statSync(m.requestPath).mode & 0o777).toBe(0o600);
		expect(statSync(m.candidatePath).mode & 0o777).toBe(0o600);
	});
	it.each([
		["wrong binary", ["other", "--session-id", "session-1"]],
		["wrong session", ["claude", "--session-id", "foreign"]],
		["missing session", ["claude", "--print", "hello"]],
		[
			"duplicate session",
			["claude", "--session-id", "session-1", "--resume", "foreign"],
		],
		["prefix match", ["claude", "--session-id", "session-10"]],
		["prompt impersonates flag", ["claude", "--", "--session-id", "session-1"]],
	] as const)(
		"does not register %s as a verified launch",
		async (_name, argv) => {
			const m = manifest();
			await expect(
				registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
					launchArgv: [...argv],
					readIdentity: async () => native,
				}),
			).rejects.toThrow("process_launch_arguments_mismatch");
			expect(readdirSync(dirs.at(-1)!)).toHaveLength(1);
		},
	);
	it.each(["kimi-tmux", "antigravity-tmux"] as const)(
		"does not require a nonexistent Claude session argument for %s",
		async (adapter) => {
			const directory = mkdtempSync(join(tmpdir(), "fly2919-a8-other-"));
			dirs.push(directory);
			const binaryName = adapter === "kimi-tmux" ? "kimi" : "agy";
			const m = createExecutionProcessLaunchManifest(directory, {
				...request,
				adapter,
				binaryName,
				nativeSessionId: null,
			});
			await registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
				launchArgv: [binaryName, "--prompt", "hello"],
				readIdentity: async () => native,
			});
			expect(readExecutionProcessLaunchCandidate(m).nativeSessionId).toBeNull();
		},
	);
	it("accepts an exact resume argument without inspecting the future process title", async () => {
		const m = manifest();
		await registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
			launchArgv: ["claude", "--resume", "session-1"],
			readIdentity: async () => native,
		});
		expect(readExecutionProcessLaunchCandidate(m).nativeSessionId).toBe(
			"session-1",
		);
	});
	it("refuses a nonleader/shared process group and PID reuse", async () => {
		const m = manifest();
		for (const identity of [
			{ ...native, pgid: 10 },
			{ ...native, pid: 43 },
		])
			await expect(
				registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
					launchArgv: ["claude", "--session-id", "session-1"],
					readIdentity: async () => identity,
				}),
			).rejects.toThrow("process_launch_identity_unavailable");
	});
	it("rejects symlinks, oversized input, wrong nonce and generation", async () => {
		const m = manifest();
		const target = join(dirs[0]!, "target");
		writeFileSync(target, "{}");
		symlinkSync(target, m.candidatePath);
		expect(() => readExecutionProcessLaunchCandidate(m)).toThrow();
		rmSync(m.candidatePath);
		writeFileSync(m.candidatePath, "x".repeat(17000));
		expect(() => readExecutionProcessLaunchCandidate(m)).toThrow();
		await registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
			launchArgv: ["claude", "--session-id", "session-1"],
			readIdentity: async () => native,
		});
		const valid = JSON.parse(readFileSync(m.candidatePath, "utf8"));
		for (const change of [
			{ nonce: "wrong" },
			{ generation: 3 },
			{ pgid: 10 },
		]) {
			writeFileSync(m.candidatePath, JSON.stringify({ ...valid, ...change }));
			expect(() => readExecutionProcessLaunchCandidate(m)).toThrow();
		}
	});
	it("removes a partial temporary file if flush fails before rename", () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2919-a5-flush-"));
		dirs.push(directory);
		vi.mocked(fsyncSync).mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		expect(() =>
			createExecutionProcessLaunchManifest(directory, request),
		).toThrow("flush failed");
		expect(readdirSync(directory)).toEqual([]);
	});
	it("fails closed when waiting is cancelled or its budget expires", async () => {
		const m = manifest();
		await expect(
			waitForExecutionProcessLaunchCandidate(m, {
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow("process_launch_cancelled");
		let now = 0;
		await expect(
			waitForExecutionProcessLaunchCandidate(m, {
				timeoutMs: 5,
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			}),
		).rejects.toThrow("process_launch_timeout");
	});
});

describe("FLY-2919 trusted launch executable", () => {
	it.each(["native", "absolute_shebang", "env_shebang", "symlink"])(
		"resolves %s independently of a future process title",
		async (mode) => {
			const directory = realpathSync(
				mkdtempSync(join(tmpdir(), "fly2919-a9-executable-")),
			);
			dirs.push(directory);
			const tool = join(directory, "tool"),
				runtime = join(directory, "runtime");
			writeFileSync(runtime, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
			chmodSync(runtime, 0o755);
			if (mode === "symlink") symlinkSync(runtime, tool);
			else {
				writeFileSync(
					tool,
					mode === "native"
						? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
						: mode === "absolute_shebang"
							? `#!${runtime}\nsource`
							: "#!/usr/bin/env runtime\nsource",
				);
				chmodSync(tool, 0o755);
			}
			const resolver = (Launch as any).resolveExecutionLaunchExecutable;
			expect(resolver).toBeTypeOf("function");
			expect(await resolver("tool", directory)).toEqual({
				launchPath: mode === "symlink" ? runtime : tool,
				executable: mode === "native" ? tool : runtime,
				launchEnvPath: directory,
			});
		},
	);
	it("pins only absolute PATH entries when the host PATH contains an unexpanded tilde", async () => {
		const directory = realpathSync(
			mkdtempSync(join(tmpdir(), "fly2919-a9-mixed-path-")),
		);
		dirs.push(directory);
		const tool = join(directory, "tool");
		writeFileSync(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
		chmodSync(tool, 0o755);
		expect(
			await Launch.resolveExecutionLaunchExecutable(
				"tool",
				`${directory}:~/.dotnet/tools:.`,
			),
		).toEqual({ launchPath: tool, executable: tool, launchEnvPath: directory });
	});
	it.each([
		"missing",
		"relative_path",
		"nonexec",
		"directory",
		"unsupported_env",
		"interpreter_loop",
	])("refuses ambiguous launch: %s", async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "fly2919-a9-refused-"));
		dirs.push(directory);
		const tool = join(directory, "tool");
		if (mode === "directory") mkdirSync(tool);
		else if (mode !== "missing") {
			writeFileSync(
				tool,
				mode === "unsupported_env"
					? "#!/usr/bin/env -S runtime --flag\n"
					: mode === "interpreter_loop"
						? `#!${tool}\n`
						: "native",
			);
			chmodSync(tool, mode === "nonexec" ? 0o600 : 0o755);
		}
		const resolver = (Launch as any).resolveExecutionLaunchExecutable;
		expect(resolver).toBeTypeOf("function");
		await expect(
			resolver("tool", mode === "relative_path" ? "." : directory),
		).rejects.toThrow("process_launch_executable_unavailable");
	});
});
