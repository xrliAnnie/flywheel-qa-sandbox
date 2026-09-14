import { afterEach, expect, it, vi } from "vitest";
import { REPORT_BLOB_SWEEP_INTERVAL_MS } from "../bridge/report-blob-store.js";
import { installReportBlobSweep } from "../bridge/report-hosting-maintenance.js";

afterEach(() => vi.useRealTimers());
it("installs without credentials and uses a newly added token on the next daily tick", async () => {
	vi.useFakeTimers();
	let value: string | undefined;
	const sweepExpiredReports = vi.fn().mockResolvedValue(0);
	const bind = vi.fn(() => ({ sweepExpiredReports }));
	const snapshot = vi.fn(() => ({
		key: "BLOB_READ_WRITE_TOKEN" as const,
		value,
		source: value ? ("file" as const) : ("absent" as const),
		generation: 1,
	}));
	const timer = installReportBlobSweep({
		credentials: { snapshot },
		blobStore: { bind },
		registry: {
			withLock: async (fn: () => Promise<unknown>) => fn(),
			hostingBinding: () => ({
				hostingKey: "project/storea",
				storeId: "storea",
			}),
			list: () => [],
		},
		criticalSection: { run: async (fn: () => Promise<unknown>) => fn() },
		warn: vi.fn(),
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(bind).not.toHaveBeenCalled();
	value = "vercel_blob_rw_storea_secret";
	await vi.advanceTimersByTimeAsync(REPORT_BLOB_SWEEP_INTERVAL_MS);
	expect(sweepExpiredReports).toHaveBeenCalledTimes(1);
	expect(bind.mock.calls[0]![0].value).toBe(value);
	clearInterval(timer);
});
