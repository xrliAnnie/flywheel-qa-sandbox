import type { ExecFileOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ExecFileLike,
	type KillableChild,
	runWaitAwareExec,
	WaitAwareExecTimeoutError,
} from "../src/wait-aware-exec.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function fakeExec() {
	let callback: Callback | null = null;
	let callbackCount = 0;
	const calls: Array<{
		file: string;
		argv: readonly string[];
		options: ExecFileOptions;
	}> = [];
	const kill = vi.fn(() => {
		callbackCount += 1;
		callback?.(new Error("child killed"), "", "terminated");
		return true;
	});
	const child: KillableChild = { kill };
	const execFile: ExecFileLike = (file, argv, options, cb) => {
		calls.push({ file, argv, options });
		callback = cb;
		return child;
	};
	return {
		calls,
		child,
		execFile,
		kill,
		callbackCount: () => callbackCount,
		succeed(stdout = "ok", stderr = "") {
			callbackCount += 1;
			callback?.(null, stdout, stderr);
		},
	};
}

function start(
	proc: ReturnType<typeof fakeExec>,
	isWaiting: () => boolean,
	overrides: Partial<{
		activeTimeoutMs: number;
		waitingTimeoutMs: number;
		waitRetryMs: number;
		outerTimeoutMs: number;
		onProbeError: (error: unknown) => void;
	}> = {},
) {
	return runWaitAwareExec({
		file: "claude",
		argv: ["--print"],
		options: { cwd: "/repo" },
		activeTimeoutMs: 1_000,
		waitingTimeoutMs: 10_000,
		waitRetryMs: 10,
		outerTimeoutMs: 30_000,
		isWaiting,
		execFile: proc.execFile,
		now: Date.now,
		...overrides,
	});
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

async function timeoutAfter(
	promise: ReturnType<typeof runWaitAwareExec>,
	ms: number,
): Promise<WaitAwareExecTimeoutError> {
	const caught = promise.then(
		() => null,
		(error: unknown) => error,
	);
	await advance(ms);
	const error = await caught;
	expect(error).toBeInstanceOf(WaitAwareExecTimeoutError);
	return error as WaitAwareExecTimeoutError;
}

describe("runWaitAwareExec", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("kills at cumulative active timeout when never waiting", async () => {
		const proc = fakeExec();
		await timeoutAfter(
			start(proc, () => false),
			1_000,
		);
		expect(proc.calls).toHaveLength(1);
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("pauses active accounting while one blocking gate is open", async () => {
		const proc = fakeExec();
		let waiting = false;
		const run = start(proc, () => waiting);
		await advance(390);
		waiting = true;
		await advance(2_000);
		expect(proc.kill).not.toHaveBeenCalled();
		proc.succeed();
		await expect(run).resolves.toEqual({ stdout: "ok", stderr: "" });
	});

	it("continues the same child with remaining active budget after response", async () => {
		const proc = fakeExec();
		let waiting = false;
		const run = start(proc, () => waiting);
		await advance(390);
		waiting = true;
		await advance(500);
		waiting = false;
		await advance(400);
		expect(proc.calls).toHaveLength(1);
		expect(proc.kill).not.toHaveBeenCalled();
		proc.succeed("same child");
		await expect(run).resolves.toEqual({ stdout: "same child", stderr: "" });
	});

	it("does not grant wait time to a checkpoint-less ask", async () => {
		const proc = fakeExec();
		const checkpointLessAskExists = true;
		await timeoutAfter(
			start(proc, () => checkpointLessAskExists && false),
			1_000,
		);
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the wait probe throws", async () => {
		const proc = fakeExec();
		const onProbeError = vi.fn();
		await timeoutAfter(
			start(
				proc,
				() => {
					throw new Error("comm db busy");
				},
				{ onProbeError },
			),
			1_000,
		);
		expect(onProbeError).toHaveBeenCalled();
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("kills when one wait period exceeds waitingTimeoutMs", async () => {
		const proc = fakeExec();
		await timeoutAfter(
			start(proc, () => true, { waitingTimeoutMs: 500 }),
			500,
		);
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("does not refresh active budget across repeated open-close cycles", async () => {
		const proc = fakeExec();
		let waiting = false;
		const run = start(proc, () => waiting);

		await advance(390);
		waiting = true;
		await advance(10); // observe wait open at 400ms active
		await advance(290);
		waiting = false;
		await advance(10); // close after 300ms waiting
		await advance(390);
		waiting = true;
		await advance(10); // observe second wait at 800ms cumulative active
		await advance(290);
		waiting = false;
		await advance(10); // close after another 300ms waiting

		await timeoutAfter(run, 201);
		expect(proc.calls).toHaveLength(1);
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("kills at the absolute outer cap across many gates", async () => {
		const proc = fakeExec();
		await timeoutAfter(
			start(proc, () => true, {
				waitingTimeoutMs: 10_000,
				outerTimeoutMs: 1_500,
			}),
			1_500,
		);
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("clears timers and settles once after child success", async () => {
		const proc = fakeExec();
		const run = start(proc, () => false);
		await advance(100);
		proc.succeed("done", "note");
		await expect(run).resolves.toEqual({ stdout: "done", stderr: "note" });
		await advance(60_000);
		expect(proc.calls).toHaveLength(1);
		expect(proc.kill).not.toHaveBeenCalled();
		expect(proc.callbackCount()).toBe(1);
	});
});
