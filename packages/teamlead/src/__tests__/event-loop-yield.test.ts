import { describe, expect, it } from "vitest";
import { runSequentialChunks } from "../bridge/event-loop-yield.js";

function busyFor(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// Intentional synchronous work: scaled stand-in for a DB materialization.
	}
}

describe("FLY-2331 sequential maintenance chunks", () => {
	it("lets timer heartbeats advance between bounded synchronous chunks", async () => {
		let heartbeats = 0;
		const timer = setInterval(() => {
			heartbeats += 1;
		}, 1);
		const order: number[] = [];

		await runSequentialChunks([1, 2, 3, 4], (chunk) => {
			order.push(chunk);
			busyFor(10);
		});
		clearInterval(timer);

		expect(order).toEqual([1, 2, 3, 4]);
		expect(heartbeats).toBeGreaterThanOrEqual(3);
	});

	it("negative control: the same unyielded chunks starve the timer", () => {
		let heartbeats = 0;
		const timer = setInterval(() => {
			heartbeats += 1;
		}, 1);
		for (const _chunk of [1, 2, 3, 4]) busyFor(10);
		clearInterval(timer);
		expect(heartbeats).toBe(0);
	});

	it("keeps injected scheduling and business order deterministic", async () => {
		const observed: string[] = [];
		await runSequentialChunks(
			["a", "b"],
			(chunk) => {
				observed.push(`run:${chunk}`);
			},
			(resume) => {
				observed.push("yield");
				resume();
			},
		);
		expect(observed).toEqual(["run:a", "yield", "run:b", "yield"]);
	});
});
