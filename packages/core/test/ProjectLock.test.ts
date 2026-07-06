import { describe, expect, it } from "vitest";
import { ProjectLock } from "../src/ProjectLock.js";

describe("ProjectLock", () => {
	it("acquire resolves immediately for new key", async () => {
		const lock = new ProjectLock();
		// Should not block
		await lock.acquire("proj-a");
		lock.release("proj-a");
	});

	it("acquire blocks same key until release", async () => {
		const lock = new ProjectLock();
		await lock.acquire("proj-a");

		let blocked = true;
		const pending = lock.acquire("proj-a").then(() => {
			blocked = false;
		});

		await Promise.resolve();
		expect(blocked).toBe(true);

		lock.release("proj-a");
		await pending;
		expect(blocked).toBe(false);
	});

	it("different keys don't block each other", async () => {
		const lock = new ProjectLock();
		await lock.acquire("proj-a");

		// proj-b should resolve immediately despite proj-a being held
		let resolved = false;
		await lock.acquire("proj-b").then(() => {
			resolved = true;
		});
		expect(resolved).toBe(true);

		lock.release("proj-a");
		lock.release("proj-b");
	});

	it("release on unheld key is no-op", () => {
		const lock = new ProjectLock();
		// Should not throw
		lock.release("nonexistent");
	});

	it("sequential acquire/release on same key — no deadlock", async () => {
		const lock = new ProjectLock();
		for (let i = 0; i < 5; i++) {
			await lock.acquire("proj-a");
			lock.release("proj-a");
		}
	});

	it("release does not allow new caller to jump the queue", async () => {
		const lock = new ProjectLock();
		await lock.acquire("proj-a");

		const order: number[] = [];

		// Queued waiter
		const p1 = lock.acquire("proj-a").then(() => order.push(1));

		// Release — p1 should get the lock, not a new caller
		lock.release("proj-a");

		// New caller tries to acquire synchronously after release
		const p2 = lock.acquire("proj-a").then(() => order.push(2));

		await p1;
		lock.release("proj-a");
		await p2;
		lock.release("proj-a");

		// Queued waiter (1) must resolve before the new caller (2)
		expect(order).toEqual([1, 2]);
	});

	it("FIFO ordering for same key — three acquires released in order", async () => {
		const lock = new ProjectLock();
		await lock.acquire("proj-a");

		const order: number[] = [];
		const p1 = lock.acquire("proj-a").then(() => order.push(1));
		const p2 = lock.acquire("proj-a").then(() => order.push(2));
		const p3 = lock.acquire("proj-a").then(() => order.push(3));

		lock.release("proj-a"); // wakes p1
		await p1;
		lock.release("proj-a"); // wakes p2
		await p2;
		lock.release("proj-a"); // wakes p3
		await p3;

		expect(order).toEqual([1, 2, 3]);
	});
});
