import { describe, expect, it, vi } from "vitest";
import {
	CodexLeadRuntime,
	type CodexLeadRuntimeSteps,
	type RuntimeWiring,
} from "../CodexLeadRuntime.js";

const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function harness(over: Partial<CodexLeadRuntimeSteps> = {}) {
	const order: string[] = [];
	const wiring: RuntimeWiring = {
		recover: async () => {
			order.push("recover");
		},
		startGateway: async () => {
			order.push("startGateway");
		},
		stopGateway: async () => {
			order.push("stopGateway");
		},
	};
	const steps: CodexLeadRuntimeSteps = {
		startProcess: async () => {
			order.push("startProcess");
		},
		ensureThread: async () => {
			order.push("ensureThread");
			return "th-1";
		},
		wire: async (threadId) => {
			order.push(`wire:${threadId}`);
			return wiring;
		},
		shutdownProcess: async () => {
			order.push("shutdownProcess");
		},
		logger: silent,
		...over,
	};
	return { order, steps, runtime: new CodexLeadRuntime(steps) };
}

describe("CodexLeadRuntime — start ordering", () => {
	it("starts process → thread → wire → recover → gateway (recover BEFORE gateway)", async () => {
		const { runtime, order } = harness();
		await runtime.start();
		expect(order).toEqual([
			"startProcess",
			"ensureThread",
			"wire:th-1",
			"recover",
			"startGateway",
		]);
		expect(runtime.isStarted()).toBe(true);
	});

	it("start is idempotent (no double startup)", async () => {
		const { runtime, order } = harness();
		await runtime.start();
		await runtime.start();
		expect(order.filter((o) => o === "startProcess")).toHaveLength(1);
	});
});

describe("CodexLeadRuntime — stop ordering", () => {
	it("stops gateway then shuts down the process (reverse)", async () => {
		const { runtime, order } = harness();
		await runtime.start();
		order.length = 0;
		await runtime.stop();
		expect(order).toEqual(["stopGateway", "shutdownProcess"]);
		expect(runtime.isStarted()).toBe(false);
	});

	it("stop before start is safe (best-effort, no throw)", async () => {
		const { runtime } = harness();
		await expect(runtime.stop()).resolves.toBeUndefined();
	});
});

describe("CodexLeadRuntime — start failure tears down what came up", () => {
	it("gateway start failure → stops gateway + shuts down process, then rethrows", async () => {
		const order: string[] = [];
		const wiring: RuntimeWiring = {
			recover: async () => order.push("recover"),
			startGateway: async () => {
				order.push("startGateway");
				throw new Error("gateway boom");
			},
			stopGateway: async () => order.push("stopGateway"),
		};
		const runtime = new CodexLeadRuntime({
			startProcess: async () => order.push("startProcess"),
			ensureThread: async () => {
				order.push("ensureThread");
				return "t";
			},
			wire: async () => {
				order.push("wire");
				return wiring;
			},
			shutdownProcess: async () => order.push("shutdownProcess"),
			logger: silent,
		});
		await expect(runtime.start()).rejects.toThrow(/gateway boom/);
		expect(order).toContain("stopGateway");
		expect(order).toContain("shutdownProcess");
		expect(runtime.isStarted()).toBe(false);
	});

	it("a thread failure shuts the process down (no gateway to stop), rethrows", async () => {
		const order: string[] = [];
		const runtime = new CodexLeadRuntime({
			startProcess: async () => order.push("startProcess"),
			ensureThread: async () => {
				throw new Error("thread boom");
			},
			wire: async () => {
				order.push("wire");
				return {
					recover: async () => {},
					startGateway: async () => {},
					stopGateway: async () => {},
				};
			},
			shutdownProcess: async () => order.push("shutdownProcess"),
			logger: silent,
		});
		await expect(runtime.start()).rejects.toThrow(/thread boom/);
		expect(order).toEqual(["startProcess", "shutdownProcess"]); // never wired
	});
});

describe("CodexLeadRuntime — health", () => {
	it("exposes the injected health verdict", async () => {
		const { steps } = harness({
			healthProbe: () => ({ status: "healthy", reasons: [] }),
		});
		const runtime = new CodexLeadRuntime(steps);
		expect(runtime.healthProbe()?.status).toBe("healthy");
	});
});
