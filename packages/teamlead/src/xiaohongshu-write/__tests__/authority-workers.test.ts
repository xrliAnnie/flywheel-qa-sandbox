import { afterEach, expect, it, vi } from "vitest";
import { startAuthorityWorkers } from "../authority-workers.js";
import { XhsNotificationWorker } from "../notification-worker.js";
import { fixture, NOW } from "./store-fixture.js";

afterEach(() => vi.useRealTimers());
it("isolates slow channels, does not overlap polls, and drains before closing", async () => {
	vi.useFakeTimers();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls = [0, 0];
	let notices = 0;
	let stopped: AbortSignal | undefined;
	const workers = startAuthorityWorkers({
		observers: (signal) => {
			stopped = signal;
			return [
				{
					async poll() {
						calls[0]++;
						await held;
					},
				},
				{
					async poll() {
						calls[1]++;
					},
				},
			];
		},
		notifications: {
			async poll() {
				notices++;
			},
		},
	});
	await vi.advanceTimersByTimeAsync(30000);
	expect(calls).toEqual([1, 3]);
	expect(notices).toBe(7);
	let closed = false;
	const closing = workers.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(stopped?.aborted).toBe(true);
	expect(closed).toBe(false);
	release();
	await closing;
	await workers.close();
	await vi.advanceTimersByTimeAsync(60000);
	expect(calls).toEqual([1, 3]);
	expect(notices).toBe(7);
});
it("continues expiry and founder notices while a channel fails without resending a write", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW + 3000);
	const f = fixture();
	f.approve();
	const messages: string[] = [];
	const notices = new XhsNotificationWorker(f.store, {
		async notify(_id, text) {
			messages.push(text);
		},
	});
	let polls = 0;
	const workers = startAuthorityWorkers({
		observers: () => [
			{
				async poll() {
					polls++;
					throw Error("source unavailable");
				},
			},
		],
		notifications: notices,
	});
	try {
		await vi.advanceTimersByTimeAsync(300000);
		expect(polls).toBe(21);
		expect(messages.some((message) => message.includes("已过期"))).toBe(true);
		expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
			"expired",
		);
		expect(f.store.claim(f.request, Date.now()).kind).toBe("denied");
	} finally {
		await workers.close();
		f.close();
	}
});
