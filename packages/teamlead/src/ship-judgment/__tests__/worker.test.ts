import { describe, expect, it, vi } from "vitest";
import type { FrozenPacket } from "../contract.js";
import type { ShipJudgmentJobs } from "../jobs.js";
import { ShipJudgmentWorker } from "../worker.js";

describe("independent judgment worker", () => {
	it("coalesces ticks and holds the claim until an aborted evaluator actually returns", async () => {
		const packet = {} as FrozenPacket;
		const claim = {
			status: "claimed" as const,
			inputId: "i",
			owner: "worker",
			generation: 1,
		};
		const jobs = {
			queued: () => ["i"],
			recoverExpired: vi.fn(),
			claim: vi.fn(() => claim),
			markSpawned: vi.fn(() => true),
			finish: vi.fn(),
			confirmNotSpawned: vi.fn(),
		};
		let release!: () => void;
		let signal: AbortSignal | undefined;
		const evaluate = vi.fn(
			async (_packet: FrozenPacket, abort: AbortSignal) => {
				signal = abort;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return {
					spawned: true,
					evaluation: {
						alignment: "undetermined" as const,
						coverage: "undetermined" as const,
						result: {},
						resultCode: "model_aborted",
						durationMs: 1,
						usage: null,
						costUsd: null,
					},
				};
			},
		);
		const worker = new ShipJudgmentWorker({
			jobs: jobs as unknown as ShipJudgmentJobs,
			owner: "worker",
			prepare: async () => packet,
			isCurrent: () => true,
			evaluate,
			settled: vi.fn(),
		});
		const running = worker.tick();
		await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
		void worker.tick();
		const stopping = worker.stop();
		expect(signal?.aborted).toBe(true);
		expect(jobs.finish).not.toHaveBeenCalled();
		expect(jobs.confirmNotSpawned).not.toHaveBeenCalled();
		release();
		await running;
		await stopping;
		expect(jobs.finish).toHaveBeenCalledTimes(1);
		await worker.tick();
		expect(evaluate).toHaveBeenCalledTimes(1);
	});
	it("does not launch stale material or spend a failed executable launch", async () => {
		const packet = {} as FrozenPacket;
		const claim = {
			status: "claimed" as const,
			inputId: "i",
			owner: "worker",
			generation: 1,
		};
		const jobs = {
			queued: () => ["i"],
			recoverExpired: vi.fn(),
			claim: vi.fn(() => claim),
			markSpawned: vi.fn(() => true),
			finish: vi.fn(),
			confirmNotSpawned: vi.fn(),
		};
		const evaluate = vi.fn(async () => ({
			spawned: false,
			evaluation: {
				alignment: "undetermined" as const,
				coverage: "undetermined" as const,
				result: {},
				resultCode: "spawn_failed",
				durationMs: 1,
				usage: null,
				costUsd: null,
			},
		}));
		let current = false;
		const worker = new ShipJudgmentWorker({
			jobs: jobs as unknown as ShipJudgmentJobs,
			owner: "worker",
			prepare: async () => packet,
			isCurrent: () => current,
			evaluate,
			settled: vi.fn(),
		});
		await worker.tick();
		expect(evaluate).not.toHaveBeenCalled();
		current = true;
		await worker.tick();
		expect(jobs.confirmNotSpawned).toHaveBeenCalledWith(
			claim,
			"spawn_failed",
			expect.any(Number),
		);
		expect(jobs.finish).not.toHaveBeenCalled();
		await worker.stop();
	});
});
