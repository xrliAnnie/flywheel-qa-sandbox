import {
	fsyncSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	it("refuses a nonleader/shared process group and PID reuse", async () => {
		const m = manifest();
		for (const identity of [
			{ ...native, pgid: 10 },
			{ ...native, pid: 43 },
		])
			await expect(
				registerExecutionProcessLaunchCandidate(m.requestPath, 42, {
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
