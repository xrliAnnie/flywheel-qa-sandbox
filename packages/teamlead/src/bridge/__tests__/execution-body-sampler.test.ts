import type { BodyObservation } from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionBodySampler } from "../execution-body-sampler.js";

function observation(id: string): BodyObservation {
	return {
		identity: {
			executionId: id,
			activationId: "activation",
			generation: 1,
			lifecycleRevision: 0,
			adapter: "codex-tmux",
		},
		ownerToken: "owner",
		spawnEpoch: 1,
		bindingDigest: "digest",
		verdict: "dead",
		observedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 10_000).toISOString(),
		reason: "all_writers_absent",
	};
}
const candidates = Array.from(
	{ length: 100 },
	(_, i) => `exec-${String(i).padStart(3, "0")}`,
);

describe("FLY-2919 bounded body sampling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
	});
	afterEach(() => vi.useRealTimers());
	it("starts at most eight probes per pass, with two in flight, and visits all 100 candidates", async () => {
		let active = 0;
		let peak = 0;
		const seen = new Set<string>();
		const observe = vi.fn(async (id: string) => {
			active++;
			peak = Math.max(peak, active);
			seen.add(id);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			return observation(id);
		});
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		for (let i = 0; i < 13; i++) {
			const before = observe.mock.calls.length;
			const pass = sampler.runPass();
			await vi.advanceTimersByTimeAsync(40);
			await pass;
			expect(observe.mock.calls.length - before).toBeLessThanOrEqual(8);
		}
		expect(peak).toBe(2);
		expect(active).toBe(0);
		expect(seen.size).toBe(100);
	});
	it("cancels slow probes at five seconds and waits for their owned work to drain", async () => {
		let active = 0;
		let settled = false;
		const observe = vi.fn(
			(_id: string, control: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => {
					active++;
					control.signal?.addEventListener(
						"abort",
						() => {
							setTimeout(() => {
								active--;
								resolve(undefined);
							}, 20);
						},
						{ once: true },
					);
				}),
		);
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		const pass = sampler.runPass().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(5000);
		expect(observe).toHaveBeenCalledTimes(2);
		expect(settled).toBe(false);
		expect(active).toBe(2);
		await vi.advanceTimersByTimeAsync(20);
		await pass;
		expect(active).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		const next = sampler.runPass();
		expect(observe.mock.calls[2][0]).toBe("exec-002");
		await vi.advanceTimersByTimeAsync(5020);
		await next;
	});
	it("coalesces overlapping passes and keeps hot reads synchronous", async () => {
		const observe = vi.fn(async (id: string) => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return observation(id);
		});
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		const pass = sampler.runPass();
		expect(sampler.runPass()).toBe(pass);
		for (const id of candidates) expect(sampler.read(id)).toBeUndefined();
		expect(observe).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(4000);
		await pass;
		expect(sampler.read("exec-000")?.verdict).toBe("dead");
	});
	it("reserves regular capacity so repeated priority demand cannot starve the stable cursor", async () => {
		const seen = new Set<string>();
		const observe = vi.fn(async (id: string) => {
			seen.add(id);
			return observation(id);
		});
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		for (let pass = 0; pass < 25; pass++) {
			for (let i = 0; i < 8; i++) sampler.request(`priority-${pass}-${i}`);
			await sampler.runPass();
		}
		expect(candidates.every((id) => seen.has(id))).toBe(true);
		expect(observe.mock.calls[0][0]).toBe("priority-0-0");
	});
	it("rejects stale or changed-authority observations before a dispatcher can consume them", async () => {
		let current = true;
		const observe = vi.fn(async (id: string) => observation(id));
		const sampler = createExecutionBodySampler({
			listCandidates: () => ["exec"],
			observer: { observe, isCurrent: () => current },
		});
		await sampler.runPass();
		expect(sampler.read("exec")?.verdict).toBe("dead");
		current = false;
		expect(sampler.read("exec")).toBeUndefined();
		current = true;
		await sampler.runPass();
		await vi.advanceTimersByTimeAsync(10_001);
		expect(sampler.read("exec")).toBeUndefined();
	});
	it("does not publish evidence after cancellation even if a collaborator returns a dead result", async () => {
		const observe = vi.fn(
			(id: string, control: { signal?: AbortSignal }) =>
				new Promise<BodyObservation>((resolve) => {
					control.signal?.addEventListener(
						"abort",
						() => resolve(observation(id)),
						{ once: true },
					);
				}),
		);
		const sampler = createExecutionBodySampler({
			listCandidates: () => ["exec"],
			observer: { observe, isCurrent: () => true },
		});
		const pass = sampler.runPass();
		await vi.advanceTimersByTimeAsync(5000);
		await pass;
		expect(sampler.read("exec")).toBeUndefined();
	});
	it("a probe failure does not stop other candidates or strand single-flight state", async () => {
		const observe = vi.fn(async (id: string) => {
			if (id === "exec-000") throw new Error("OS denied");
			return observation(id);
		});
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		await sampler.runPass();
		expect(observe).toHaveBeenCalledTimes(8);
		expect(sampler.read("exec-000")).toBeUndefined();
		expect(sampler.read("exec-001")?.verdict).toBe("dead");
		await sampler.runPass();
		expect(observe).toHaveBeenCalledTimes(16);
	});
	it("stop cancels and drains its probes before resolving and can restart with no old evidence", async () => {
		const observe = vi.fn(
			(_id: string, control: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => {
					control.signal?.addEventListener(
						"abort",
						() => setTimeout(() => resolve(undefined), 20),
						{ once: true },
					);
				}),
		);
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		sampler.start();
		expect(observe).toHaveBeenCalledTimes(2);
		const stopped = sampler.stop();
		await vi.advanceTimersByTimeAsync(20);
		await stopped;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(observe).toHaveBeenCalledTimes(2);
		sampler.start();
		expect(observe).toHaveBeenCalledTimes(4);
		const stoppedAgain = sampler.stop();
		await vi.advanceTimersByTimeAsync(20);
		await stoppedAgain;
	});
	it("samples independently of a five-minute heartbeat", async () => {
		const observe = vi.fn(async (id: string) => observation(id));
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		sampler.start();
		await vi.advanceTimersByTimeAsync(5000);
		expect(observe.mock.calls.length).toBeGreaterThanOrEqual(16);
		await sampler.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("advances the regular cursor even when priority probes use the entire window", async () => {
		const observe = vi.fn(
			(_id: string, control: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => {
					control.signal?.addEventListener("abort", () => resolve(undefined), {
						once: true,
					});
				}),
		);
		const sampler = createExecutionBodySampler({
			listCandidates: () => candidates,
			observer: { observe, isCurrent: () => true },
		});
		for (let pass = 0; pass < 3; pass++) {
			for (let i = 0; i < 8; i++) sampler.request(`priority-${pass}-${i}`);
			const pending = sampler.runPass();
			await vi.advanceTimersByTimeAsync(5000);
			await pending;
		}
		expect(
			observe.mock.calls
				.filter(([id]) => id.startsWith("exec-"))
				.map(([id]) => id),
		).toEqual(["exec-000", "exec-001", "exec-002"]);
	});
});
