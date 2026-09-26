import { expect, it } from "vitest";
import { BoundedStdioTransport } from "../bounded-stdio-transport.js";
import {
	observeChildSpawns,
	reportChildSpawned,
} from "../child-spawn-observer.js";

/** FLY-2886 §14.2: admissions learn exact child identities to reap later. */
it("reports parent-owned stdio children spawned inside the observed context only", async () => {
	const seen: number[] = [];
	const launch = {
		command: process.execPath,
		args: ["-e", "setTimeout(() => {}, 5000)"],
		env: {},
		cwd: process.cwd(),
	};
	const inside = new BoundedStdioTransport(launch, { errorCode: "test_lost" });
	const outside = new BoundedStdioTransport(launch, { errorCode: "test_lost" });
	try {
		await observeChildSpawns(
			(pid) => seen.push(pid),
			async () => {
				await Promise.resolve();
				await inside.start();
			},
		);
		await outside.start();
		expect(seen).toEqual([inside.pid]);
		expect(inside.pid).not.toBe(outside.pid);
	} finally {
		await inside.close();
		await outside.close();
	}
});

it("never lets a failing observer break the spawn", () => {
	expect(() =>
		observeChildSpawns(
			() => {
				throw new Error("observer_failed");
			},
			() => reportChildSpawned(1234),
		),
	).not.toThrow();
	expect(() => reportChildSpawned(undefined)).not.toThrow();
});
