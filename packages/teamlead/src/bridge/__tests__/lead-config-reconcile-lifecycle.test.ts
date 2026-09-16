import { afterEach, expect, it, vi } from "vitest";
import { startLeadConfigReconciler } from "../lead-config-production.js";

afterEach(() => vi.useRealTimers());
it("serializes retries and drains the live pass before shutdown", async () => {
	vi.useFakeTimers();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reconcile = vi.fn(() => pending);
	const stop = startLeadConfigReconciler({ reconcile }, vi.fn());
	await vi.advanceTimersByTimeAsync(15000);
	expect(reconcile).toHaveBeenCalledTimes(1);
	let stopped = false;
	const closing = stop().then(() => {
		stopped = true;
	});
	await Promise.resolve();
	expect(stopped).toBe(false);
	release();
	await closing;
	await vi.advanceTimersByTimeAsync(15000);
	expect(stopped).toBe(true);
	expect(reconcile).toHaveBeenCalledTimes(1);
});
it("reports a failed pass and retries on the next tick without overlapping", async () => {
	vi.useFakeTimers();
	const reconcile = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(undefined);
	const error = vi.fn();
	const stop = startLeadConfigReconciler({ reconcile }, error);
	await vi.advanceTimersByTimeAsync(5000);
	expect(error).toHaveBeenCalledTimes(1);
	expect(reconcile).toHaveBeenCalledTimes(2);
	await stop();
});
