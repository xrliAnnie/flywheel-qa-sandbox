import { describe, expect, it } from "vitest";
import {
	CodexTurnBarrier,
	TurnBarrierError,
} from "../src/codex-turn-barrier.js";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("CodexTurnBarrier", () => {
	it("serializes notification writes in arrival order", async () => {
		const first = deferred<void>();
		const order: string[] = [];
		const barrier = new CodexTurnBarrier();
		barrier.enqueue(async () => {
			order.push("first:start");
			await first.promise;
			order.push("first:end");
		});
		barrier.enqueue(async () => {
			order.push("second");
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		first.resolve();
		await barrier.settled();
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("drains work enqueued while settled is awaiting the prior tail", async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		const order: string[] = [];
		const barrier = new CodexTurnBarrier();
		barrier.enqueue(() => first.promise);
		const settling = barrier.settled().then(() => order.push("settled"));
		await Promise.resolve();
		barrier.enqueue(async () => {
			await second.promise;
			order.push("second");
		});

		first.resolve();
		await Promise.resolve();
		expect(order).toEqual([]);
		second.resolve();
		await settling;
		expect(order).toEqual(["second", "settled"]);
	});

	it("retries transient writes and latches a bounded persistent failure", async () => {
		let now = 0;
		let attempts = 0;
		const barrier = new CodexTurnBarrier({
			retryWindowMs: 3,
			initialRetryMs: 1,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		barrier.enqueue(async () => {
			attempts += 1;
			throw new Error("commdb busy");
		});

		await expect(barrier.settled()).rejects.toMatchObject({
			name: "TurnBarrierError",
			cause: expect.objectContaining({ message: "commdb busy" }),
		});
		expect(attempts).toBeGreaterThan(1);
		await expect(barrier.settled()).rejects.toBeInstanceOf(TurnBarrierError);
	});
});
