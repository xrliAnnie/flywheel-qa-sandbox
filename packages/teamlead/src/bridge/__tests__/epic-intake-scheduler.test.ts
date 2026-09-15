import { describe, expect, it, vi } from "vitest";
import { createEpicIntakeScheduler } from "../epic-intake.js";

describe("intake scheduling on an existing tick", () => {
	it("uses 30s due checks without overlapping a project's active scan", async () => {
		let now = 0;
		let release!: () => void;
		const run = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const scheduler = createEpicIntakeScheduler({
			projects: () => ["a"],
			now: () => now,
			run,
			onError: vi.fn(),
		});
		scheduler.tick();
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1);
		now = 60000;
		scheduler.tick();
		expect(run).toHaveBeenCalledTimes(1);
		release();
		await new Promise((resolve) => setImmediate(resolve));
		scheduler.tick();
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(2);
		release();
		await new Promise((resolve) => setImmediate(resolve));
		now = 89999;
		scheduler.tick();
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("bounds concurrency and rotates queued projects after one fails", async () => {
		const releases: Array<() => void> = [];
		const errors = vi.fn();
		const run = vi.fn((project: string) =>
			project === "a"
				? Promise.reject(new Error("limited"))
				: new Promise<void>((resolve) => releases.push(resolve)),
		);
		const scheduler = createEpicIntakeScheduler({
			projects: () => ["a", "b", "c"],
			maxConcurrent: 2,
			now: () => 0,
			run,
			onError: errors,
		});
		scheduler.tick();
		await new Promise((resolve) => setImmediate(resolve));
		expect(run.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
		scheduler.tick();
		await Promise.resolve();
		expect(run.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
		expect(errors).toHaveBeenCalledTimes(1);
		releases.forEach((release) => release());
	});
});
