import {
	REPORT_BLOB_SWEEP_INTERVAL_MS,
	type ReportBlobStore,
} from "./report-blob-store.js";
import type { ReportCriticalSection } from "./report-critical-section.js";
import {
	assertReportHostingCredentialBinding,
	type ReportHostingCredentials,
} from "./report-hosting-credentials.js";
import type { ReportRegistry } from "./report-registry.js";
export function installReportBlobSweep(deps: {
	credentials: ReportHostingCredentials;
	blobStore: Pick<ReportBlobStore, "bind">;
	registry: Pick<ReportRegistry, "withLock" | "hostingBinding" | "list">;
	criticalSection: ReportCriticalSection;
	warn?: (message: string) => void;
}): ReturnType<typeof setInterval> {
	const warn = deps.warn ?? console.warn;
	let warnedMissing = false;
	const tick = async () => {
		const snapshot = deps.credentials.snapshot("BLOB_READ_WRITE_TOKEN");
		if (!snapshot.value) {
			if (!warnedMissing) {
				warn("[reports] Blob sweep skipped: credential missing");
				warnedMissing = true;
			}
			return;
		}
		warnedMissing = false;
		try {
			const removed = await deps.criticalSection.run(async () => {
				const state = await deps.registry.withLock(async () => ({
					binding: deps.registry.hostingBinding(),
					reports: deps.registry.list(),
				}));
				assertReportHostingCredentialBinding(state.binding.storeId, snapshot);
				return deps.blobStore
					.bind(snapshot)
					.sweepExpiredReports(
						Date.now(),
						Object.fromEntries(
							state.reports.map((entry) => [entry.token, entry.createdAt]),
						),
					);
			});
			if (removed > 0)
				console.info(`[reports] removed ${removed} expired Blob objects`);
		} catch {
			warn("[reports] Blob retention sweep failed");
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), REPORT_BLOB_SWEEP_INTERVAL_MS);
	timer.unref?.();
	return timer;
}
