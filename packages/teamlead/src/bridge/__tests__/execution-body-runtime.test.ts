import type { BodyObservation } from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionBodyRuntime } from "../execution-body-runtime.js";

function observation(
	id: string,
	verdict: BodyObservation["verdict"] = "dead",
): BodyObservation {
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
		verdict,
		reason: verdict === "unknown" ? "recovery_active" : "writers_absent",
		observedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 10000).toISOString(),
	};
}
describe("FLY-2919 independent body lifecycle runtime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(100000);
	});
	afterEach(() => vi.useRealTimers());
	function fixture(ids = ["exec"]) {
		const observe = vi.fn(async (id: string) => observation(id));
		const onDead = vi.fn(async (_id: string) => {});
		const onRecoveryActive = vi.fn(async (_id: string) => {});
		const replayPending = vi.fn(async () => {});
		const runtime = createExecutionBodyRuntime({
			listCandidates: () => ids,
			observer: { observe, isCurrent: () => true },
			onDead,
			onRecoveryActive,
			replayPending,
		});
		return { runtime, observe, onDead, onRecoveryActive, replayPending };
	}
	it("starts independently, handles death in the same pass and never reprobes on hot reads", async () => {
		const f = fixture();
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.onDead).toHaveBeenCalledExactlyOnceWith("exec");
		for (let i = 0; i < 100; i++)
			expect(f.runtime.read("exec")?.verdict).toBe("dead");
		expect(f.observe).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.observe).toHaveBeenCalledTimes(2);
		await f.runtime.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("serves an awaited point-in-time demand after a cold cache miss", async () => {
		const f = fixture(Array.from({ length: 100 }, (_, i) => `exec-${i}`));
		f.observe.mockImplementation(async (id) => observation(id, "alive"));

		const result = await f.runtime.observe("target");

		expect(result).toMatchObject({
			verdict: "alive",
			identity: { executionId: "target" },
		});
		expect(f.observe).toHaveBeenCalledWith(
			"target",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
	it("keeps OS sampling bounded and moving while lifecycle consumers await", async () => {
		const ids = Array.from(
			{ length: 20 },
			(_, i) => `exec-${i.toString().padStart(2, "0")}`,
		);
		const f = fixture(ids);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		f.onDead.mockImplementation(async () => gate);
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.observe).toHaveBeenCalledTimes(8);
		expect(f.onDead).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.observe).toHaveBeenCalledTimes(16);
		expect(f.onDead).toHaveBeenCalledTimes(2);
		let stopped = false;
		const pending = f.runtime.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(stopped).toBe(false);
		release();
		await pending;
		expect(f.onDead).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("hands recovery_active to existing reown and queues a fresh sample after it finishes", async () => {
		const f = fixture();
		f.observe.mockResolvedValueOnce(observation("exec", "unknown"));
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.onRecoveryActive).toHaveBeenCalledExactlyOnceWith("exec");
		expect(f.onDead).not.toHaveBeenCalled();
		expect(f.observe).toHaveBeenCalledOnce();
		expect(f.runtime.read("exec")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.onDead).toHaveBeenCalledOnce();
		await f.runtime.stop();
	});
	it("does not treat other unknown reasons as recovery or death", async () => {
		const f = fixture();
		f.observe.mockResolvedValue({
			...observation("exec", "unknown"),
			reason: "body_death_authorization_disabled",
		});
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.onDead).not.toHaveBeenCalled();
		expect(f.onRecoveryActive).not.toHaveBeenCalled();
		await f.runtime.stop();
	});
	it("deduplicates in-flight lifecycle work for repeated samples", async () => {
		const f = fixture();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		f.onDead.mockImplementation(async () => gate);
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(10000);
		expect(f.observe).toHaveBeenCalledTimes(3);
		expect(f.onDead).toHaveBeenCalledOnce();
		release();
		await vi.advanceTimersByTimeAsync(0);
		await f.runtime.stop();
	});
	it("replays duties on empty passes and recovers from consumer failure", async () => {
		const f = fixture([]);
		f.replayPending.mockRejectedValueOnce(new Error("temporary store failure"));
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.replayPending).toHaveBeenCalledTimes(2);
		await f.runtime.stop();
	});
	it("retries an unavailable inventory on the independent cadence", async () => {
		let available = false;
		const onDead = vi.fn(async () => {});
		const runtime = createExecutionBodyRuntime({
			listCandidates: () => {
				if (!available) throw new Error("database busy");
				return ["exec"];
			},
			observer: {
				observe: async (id) => observation(id),
				isCurrent: () => true,
			},
			onDead,
			onRecoveryActive: async () => {},
			replayPending: async () => {},
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(onDead).not.toHaveBeenCalled();
		available = true;
		await vi.advanceTimersByTimeAsync(5000);
		expect(onDead).toHaveBeenCalledExactlyOnceWith("exec");
		await runtime.stop();
	});
	it("hot read misses queue a candidate without an OS await or probe", async () => {
		const f = fixture([]);
		expect(f.runtime.read("demand")).toBeUndefined();
		expect(f.observe).not.toHaveBeenCalled();
		f.runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.observe).toHaveBeenCalledWith("demand", expect.anything());
		await f.runtime.stop();
	});
});
