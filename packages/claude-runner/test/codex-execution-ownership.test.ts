import { describe, expect, it, vi } from "vitest";
import {
	CodexExecutionOwnershipRegistry,
	type CodexStopReason,
} from "../src/codex-execution-ownership.js";

describe("CodexExecutionOwnershipRegistry", () => {
	it("FLY-2919: exposes the same controlled owner token to the durable store and stop lease", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const first = registry.claim("exec-1", "dispatch", {
			ownerToken: "durable-owner-1",
		});
		expect(first?.ownerToken).toBe("durable-owner-1");
		const stopped = registry.requestStop("exec-1", "process_retirement");
		first?.release();
		await expect(stopped).resolves.toBe("stopped");
		const next = registry.claim("exec-1", "rescue", {
			ownerToken: "durable-owner-2",
		});
		expect(next?.ownerToken).toBe("durable-owner-2");
		first?.release();
		expect(registry.ownershipState("exec-1")).toBe("active");
		next?.release();
	});

	it.each(["", "x".repeat(257), "owner\nforeign"])(
		"FLY-2919: invalid owner token cannot consume a reservation",
		(ownerToken) => {
			const registry = new CodexExecutionOwnershipRegistry();
			registry.reserve("exec-1");
			expect(
				registry.claim("exec-1", "dispatch", { ownerToken }),
			).toBeUndefined();
			expect(registry.ownershipState("exec-1")).toBe("reserved");
		},
	);

	it("FLY-2919: legacy claims still receive unique exposed tokens", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const first = registry.claim("exec-1", "dispatch");
		expect(first?.ownerToken).toEqual(expect.any(String));
		first?.release();
		const second = registry.claim("exec-1", "rescue");
		expect(second?.ownerToken).not.toBe(first?.ownerToken);
		second?.release();
	});

	it("FLY-2211: reservation makes a dispatch visible as owned before adapter activation", () => {
		const registry = new CodexExecutionOwnershipRegistry();

		expect(registry.reserve("exec-1")).toBe(true);
		expect(registry.isExecutionOwned("exec-1")).toBe(true);
		const lease = registry.claim("exec-1", "dispatch");
		expect(lease).toBeDefined();
		expect(registry.claim("exec-1", "rescue")).toBeUndefined();

		lease?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(false);
	});

	it("FLY-2211: release is token-bound so a stale lease cannot delete a successor owner", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const first = registry.claim("exec-1", "rescue");
		expect(first).toBeDefined();
		first?.release();

		const successor = registry.claim("exec-1", "dispatch");
		expect(successor).toBeDefined();
		first?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(true);

		successor?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(false);
	});

	it("FLY-2211: only an unactivated reservation can be cancelled", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		registry.reserve("reserved");
		expect(registry.releaseReservation("reserved")).toBe(true);
		expect(registry.isExecutionOwned("reserved")).toBe(false);

		registry.reserve("active");
		const lease = registry.claim("active", "dispatch");
		expect(registry.releaseReservation("active")).toBe(false);
		expect(registry.isExecutionOwned("active")).toBe(true);
		lease?.release();
	});
});

describe("FLY-2903 requestStop channel", () => {
	it("active: marks the lease synchronously, fires the callback once, resolves stopped on release", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const onStop = vi.fn();
		const lease = registry.claim("exec-a", "dispatch", {
			onStopRequested: onStop,
		});
		expect(lease?.stopRequested).toBeNull();

		const pending = registry.requestStop("exec-a", "terminate", {
			timeoutMs: 1_000,
		});
		expect(lease?.stopRequested).toBe("terminate");
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onStop).toHaveBeenCalledWith("terminate");
		expect(registry.isStopRequested("exec-a")).toBe(true);

		lease?.release();
		await expect(pending).resolves.toBe("stopped");
	});

	it("active: resolves timeout when the owner never releases", async () => {
		vi.useFakeTimers();
		try {
			const registry = new CodexExecutionOwnershipRegistry();
			registry.claim("exec-t", "dispatch");
			const pending = registry.requestStop("exec-t", "terminal_sweep", {
				timeoutMs: 5_000,
			});
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(pending).resolves.toBe("timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses per-reason default waits (retirement 8s, sweep 5s, HTTP paths 25s)", async () => {
		vi.useFakeTimers();
		try {
			const registry = new CodexExecutionOwnershipRegistry();
			const settle = (exec: string, reason: CodexStopReason) => {
				registry.claim(exec, "dispatch");
				let outcome: string | undefined;
				void registry.requestStop(exec, reason).then((r) => {
					outcome = r;
				});
				return () => outcome;
			};
			const retirement = settle("r", "process_retirement");
			const sweep = settle("s", "terminal_sweep");
			const terminate = settle("t", "terminate");
			await vi.advanceTimersByTimeAsync(4_999);
			expect(sweep()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(sweep()).toBe("timeout");
			await vi.advanceTimersByTimeAsync(3_000);
			expect(retirement()).toBe("timeout");
			expect(terminate()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(17_000);
			expect(terminate()).toBe("timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reserved: fenced immediately and every later claim is refused", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		registry.reserve("exec-r");
		expect(registry.ownershipState("exec-r")).toBe("reserved");
		await expect(
			registry.requestStop("exec-r", "terminal_sweep"),
		).resolves.toBe("reserved_fenced");
		expect(registry.claim("exec-r", "dispatch")).toBeUndefined();
		expect(registry.isStopRequested("exec-r")).toBe(true);
	});

	it("unowned: not_owned, recorded as stop-requested, later claims refused", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		await expect(registry.requestStop("exec-n", "terminate")).resolves.toBe(
			"not_owned",
		);
		expect(registry.isStopRequested("exec-n")).toBe(true);
		expect(registry.claim("exec-n", "rescue")).toBeUndefined();
		expect(registry.ownershipState("exec-n")).toBe("none");
	});

	it("ownershipState reports none / reserved / active", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		expect(registry.ownershipState("x")).toBe("none");
		registry.reserve("x");
		expect(registry.ownershipState("x")).toBe("reserved");
		const lease = registry.claim("x", "dispatch");
		expect(registry.ownershipState("x")).toBe("active");
		lease?.release();
		expect(registry.ownershipState("x")).toBe("none");
	});

	it("a claimed lease keeps its stop mark after the bounded map evicts the exec", async () => {
		const registry = new CodexExecutionOwnershipRegistry({ stopMarkLimit: 2 });
		const lease = registry.claim("keep", "dispatch");
		void registry.requestStop("keep", "terminate", { timeoutMs: 50 });
		await registry.requestStop("e1", "terminate");
		await registry.requestStop("e2", "terminate");
		await registry.requestStop("e3", "terminate");
		expect(lease?.stopRequested).toBe("terminate");
		expect(registry.isStopRequested("keep")).toBe(true);
		// The oldest unclaimed marks are evicted once the limit is exceeded.
		expect(registry.isStopRequested("e1")).toBe(false);
		expect(registry.isStopRequested("e3")).toBe(true);
		lease?.release();
	});

	it("a throwing callback is contained and the wait still resolves", async () => {
		const logs: string[] = [];
		const registry = new CodexExecutionOwnershipRegistry({
			log: (line) => logs.push(line),
		});
		const lease = registry.claim("exec-x", "dispatch", {
			onStopRequested: () => {
				throw new Error("boom");
			},
		});
		const pending = registry.requestStop("exec-x", "close_runner", {
			timeoutMs: 1_000,
		});
		expect(lease?.stopRequested).toBe("close_runner");
		lease?.release();
		await expect(pending).resolves.toBe("stopped");
		expect(logs.some((line) => line.includes("exec-x"))).toBe(true);
	});

	it("repeated requestStop does not fire the callback again; both waits resolve", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const onStop = vi.fn();
		const lease = registry.claim("exec-d", "dispatch", {
			onStopRequested: onStop,
		});
		const first = registry.requestStop("exec-d", "terminate", {
			timeoutMs: 1_000,
		});
		const second = registry.requestStop("exec-d", "close_tmux", {
			timeoutMs: 1_000,
		});
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(lease?.stopRequested).toBe("terminate");
		lease?.release();
		await expect(first).resolves.toBe("stopped");
		await expect(second).resolves.toBe("stopped");
	});

	it("a stale lease's late release does not wake a successor's waiter", async () => {
		vi.useFakeTimers();
		try {
			const registry = new CodexExecutionOwnershipRegistry();
			const first = registry.claim("exec-s", "rescue");
			first?.release();
			const successor = registry.claim("exec-s", "dispatch");
			let outcome: string | undefined;
			void registry
				.requestStop("exec-s", "terminate", { timeoutMs: 1_000 })
				.then((r) => {
					outcome = r;
				});
			first?.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toBeUndefined();
			successor?.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toBe("stopped");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("FLY-2903 process_retirement is not a permanent fence", () => {
	it("stops the active owner but admits the later standby resume of the same execution", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const onStop = vi.fn();
		const lease = registry.claim("exec-body", "dispatch", {
			onStopRequested: onStop,
		});
		const pending = registry.requestStop("exec-body", "process_retirement", {
			timeoutMs: 1_000,
		});
		expect(onStop).toHaveBeenCalledWith("process_retirement");
		expect(lease?.stopRequested).toBe("process_retirement");
		lease?.release();
		await expect(pending).resolves.toBe("stopped");

		// FLY-2808 standby resume re-claims the SAME execution id.
		expect(registry.isStopRequested("exec-body")).toBe(false);
		const resumed = registry.claim("exec-body", "dispatch");
		expect(resumed).toBeDefined();
		expect(resumed?.stopRequested).toBeNull();
		resumed?.release();
	});

	it("an unowned or reserved retirement request leaves no fence", async () => {
		const registry = new CodexExecutionOwnershipRegistry();
		await expect(
			registry.requestStop("exec-none", "process_retirement"),
		).resolves.toBe("not_owned");
		expect(registry.claim("exec-none", "dispatch")).toBeDefined();

		registry.reserve("exec-res");
		await expect(
			registry.requestStop("exec-res", "process_retirement"),
		).resolves.toBe("not_owned");
		expect(registry.claim("exec-res", "dispatch")).toBeDefined();
	});
});
