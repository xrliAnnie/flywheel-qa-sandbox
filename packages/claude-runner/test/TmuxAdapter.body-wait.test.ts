import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BodyObservation } from "../src/execution-process-liveness.js";
import { TmuxAdapter } from "../src/TmuxAdapter.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

function harness(hooks = false, window = "absent") {
	let verdict: BodyObservation["verdict"] = "alive";
	let disposition = "abnormal_process_exit";
	let current = true;
	const observation = (): BodyObservation => ({
		identity: {
			executionId: "exec",
			activationId: "act",
			generation: 1,
			lifecycleRevision: 0,
			adapter: "claude-tmux",
		},
		ownerToken: "owner",
		spawnEpoch: 1,
		bindingDigest: "digest",
		verdict,
		reason: "fixture",
		observedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 10000).toISOString(),
	});
	const lease = {
		observeBody: vi.fn(async () => observation()),
		isCurrentBody: vi.fn(() => current),
		classifyBodyExit: vi.fn(async () => disposition),
	};
	const exec = vi.fn(() => {
		if (window === "absent") throw new Error("server missing");
		return { stdout: "0|" };
	});
	let stop: (event: object) => void = () => {};
	const hookServer = hooks
		? {
				waitForCompletion: vi.fn(
					() =>
						new Promise((resolve) => {
							stop = resolve;
						}),
				),
				cancelWait: vi.fn(),
			}
		: undefined;
	const adapter = new TmuxAdapter("test", exec, 10, 1000, hookServer as never);
	const ctx: AdapterExecutionContext = {
		executionId: "exec",
		issueId: "FLY-2919",
		cwd: "/tmp",
		prompt: "task",
		workflowActivationId: "act",
	};
	let result: any;
	const wait = (sentinelPath?: string) =>
		(adapter as any)
			.waitForCompletion(
				ctx,
				"native",
				"@1",
				1000,
				hooks ? "token" : undefined,
				sentinelPath,
				lease,
			)
			.then((r: unknown) => {
				result = r;
				return r;
			});
	return {
		lease,
		ctx,
		wait,
		exec,
		stop: () => stop({}),
		result: () => result,
		setVerdict: (v: BodyObservation["verdict"]) => {
			verdict = v;
		},
		setCurrent: (v: boolean) => {
			current = v;
		},
		setDisposition: (v: string) => {
			disposition = v;
		},
	};
}

describe("FLY-2919 process-authoritative Tmux wait", () => {
	it("preserves the legacy sentinel grace without using windows as process proof", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2919-sentinel-"));
		try {
			const sentinel = join(dir, "land-status.json");
			writeFileSync(sentinel, JSON.stringify({ status: "ready_to_merge" }));
			const h = harness();
			delete h.ctx.workflowActivationId;
			h.wait(sentinel);
			await vi.advanceTimersByTimeAsync(25);
			expect(h.result()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(60);
			expect(h.result()).toMatchObject({
				timedOut: false,
				exitKind: "completion_observed",
			});
			expect(h.exec).not.toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["activation", "resume"])(
		"a legacy sentinel cannot complete a generalized worker (%s)",
		async (mode) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2919-sentinel-"));
			try {
				const sentinel = join(dir, "land-status.json");
				writeFileSync(sentinel, JSON.stringify({ status: "merged" }));
				const h = harness();
				if (mode === "resume") {
					delete h.ctx.workflowActivationId;
					h.ctx.processLifecycle = { mode: "resume", generation: 1 };
				}
				h.wait(sentinel);
				await vi.advanceTimersByTimeAsync(85);
				expect(h.result()).toBeUndefined();
				expect(h.lease.observeBody).toHaveBeenCalled();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("heartbeat reporting failure cannot suppress physical death observation", async () => {
		const h = harness();
		h.setVerdict("dead");
		h.ctx.onHeartbeat = () => {
			throw new Error("diagnostics unavailable");
		};
		h.wait();
		await vi.advanceTimersByTimeAsync(25);
		expect(h.result()).toMatchObject({
			timedOut: false,
			exitKind: "abnormal_process_exit",
		});
	});

	it.each([false, true])(
		"keeps a live or unknown worker when its window disappears (hooks=%s)",
		async (hooks) => {
			const h = harness(hooks);
			const pending = h.wait();
			await vi.advanceTimersByTimeAsync(25);
			expect(h.result()).toBeUndefined();
			expect(h.lease.observeBody).toHaveBeenCalled();
			h.setVerdict("unknown");
			await vi.advanceTimersByTimeAsync(25);
			expect(h.result()).toBeUndefined();
			h.setVerdict("dead");
			await vi.advanceTimersByTimeAsync(25);
			await expect(pending).resolves.toMatchObject({
				timedOut: false,
				exitKind: "abnormal_process_exit",
			});
			expect(h.exec).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"observes a dead worker despite a live window (hooks=%s)",
		async (hooks) => {
			const h = harness(hooks, "present");
			h.setVerdict("dead");
			const pending = h.wait();
			await vi.advanceTimersByTimeAsync(25);
			expect(h.result()).toMatchObject({
				timedOut: false,
				exitKind: "abnormal_process_exit",
			});
			await pending;
		},
	);
	it("rechecks authority after awaited completion reconciliation", async () => {
		const h = harness();
		h.setVerdict("dead");
		h.lease.classifyBodyExit.mockImplementation(async () => {
			h.setCurrent(false);
			return "abnormal_process_exit";
		});
		h.wait();
		await vi.advanceTimersByTimeAsync(25);
		expect(h.result()).toBeUndefined();
	});
	it("keeps pending completion evidence and preserves an accepted receipt", async () => {
		const h = harness();
		h.setVerdict("dead");
		h.setDisposition("pending");
		const pending = h.wait();
		await vi.advanceTimersByTimeAsync(25);
		expect(h.result()).toBeUndefined();
		h.setDisposition("completed");
		await vi.advanceTimersByTimeAsync(25);
		await expect(pending).resolves.toMatchObject({
			timedOut: false,
			exitKind: "process_exit",
		});
	});
	it.each(["activation", "resume"])(
		"a provider Stop callback cannot complete a live generalized worker (%s)",
		async (mode) => {
			const h = harness(true);
			if (mode === "resume") {
				delete h.ctx.workflowActivationId;
				h.ctx.processLifecycle = { mode: "resume", generation: 1 };
			}
			h.wait();
			h.stop();
			await vi.advanceTimersByTimeAsync(25);
			expect(h.result()).toBeUndefined();
		},
	);
	it("retirement grace requests cleanup without asserting physical death", async () => {
		const h = harness();
		const onRetired = vi.fn();
		h.ctx.processLifecycle = {
			mode: "initial",
			generation: 1,
			retirementApproved: () => true,
			retirementGraceMs: 20,
			onRetired,
		};
		const pending = h.wait();
		await vi.advanceTimersByTimeAsync(35);
		await expect(pending).resolves.toMatchObject({
			timedOut: false,
			exitKind: "retirement_requested",
		});
		expect(onRetired).not.toHaveBeenCalled();
	});
});
