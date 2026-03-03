import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/Semaphore.js";

describe("Semaphore", () => {
	it("constructor rejects maxConcurrent < 1", () => {
		expect(() => new Semaphore(0)).toThrow();
		expect(() => new Semaphore(-1)).toThrow();
		expect(() => new Semaphore(0.5)).toThrow();
	});

	it("acquire resolves immediately when under limit", async () => {
		const sem = new Semaphore(2);
		// Both should resolve without blocking
		await sem.acquire();
		await sem.acquire();
		expect(sem.used).toBe(2);
	});

	it("acquire blocks at limit, release unblocks", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();

		let blocked = true;
		const pending = sem.acquire().then(() => {
			blocked = false;
		});

		// Still blocked — microtask hasn't run
		await Promise.resolve();
		expect(blocked).toBe(true);

		sem.release();
		await pending;
		expect(blocked).toBe(false);
	});

	it("release wakes waiters in FIFO order", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();

		const order: number[] = [];
		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquire().then(() => order.push(2));
		const p3 = sem.acquire().then(() => order.push(3));

		sem.release(); // wakes p1
		sem.release(); // wakes p2
		sem.release(); // wakes p3

		await Promise.all([p1, p2, p3]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("used returns current count", async () => {
		const sem = new Semaphore(3);
		expect(sem.used).toBe(0);

		await sem.acquire();
		expect(sem.used).toBe(1);

		await sem.acquire();
		expect(sem.used).toBe(2);

		sem.release();
		expect(sem.used).toBe(1);
	});

	it("queueLength returns waiter count", async () => {
		const sem = new Semaphore(1);
		expect(sem.queueLength).toBe(0);

		await sem.acquire();
		expect(sem.queueLength).toBe(0);

		const p1 = sem.acquire();
		const p2 = sem.acquire();
		expect(sem.queueLength).toBe(2);

		sem.release();
		await p1;
		expect(sem.queueLength).toBe(1);

		sem.release();
		await p2;
		expect(sem.queueLength).toBe(0);
	});

	it("release on empty is no-op", () => {
		const sem = new Semaphore(2);
		// No acquire — release should not throw or go negative
		sem.release();
		sem.release();
		expect(sem.used).toBe(0);
	});

	it("concurrent cycle — 5 tasks, limit=2, max parallel never exceeds 2", async () => {
		const sem = new Semaphore(2);
		let running = 0;
		let maxRunning = 0;

		const task = async () => {
			await sem.acquire();
			running++;
			maxRunning = Math.max(maxRunning, running);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 10));
			running--;
			sem.release();
		};

		await Promise.all(Array.from({ length: 5 }, () => task()));
		expect(maxRunning).toBe(2);
		expect(running).toBe(0);
		expect(sem.used).toBe(0);
	});
});
