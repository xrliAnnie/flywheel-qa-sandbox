import type { StateStore } from "../StateStore.js";
import { HistoryReportPublisher } from "../ship-judgment/history-publisher.js";
import { ShipJudgmentHistoryRuntime } from "../ship-judgment/history-runtime.js";
import type { ReportBlobStore } from "./report-blob-store.js";
import type { ReportCriticalSection } from "./report-critical-section.js";
import type { ReportHostingCredentials } from "./report-hosting-credentials.js";
import type { ReportRegistry } from "./report-registry.js";
/** Independent of the opinion flag; history remains readable/publishable in off mode. */
export function createShipJudgmentHistoryRuntime(deps: {
	store: StateStore;
	projects: { projectName: string }[];
	registry: ReportRegistry;
	blob:
		| (Pick<ReportBlobStore, "resumeReport"> &
				Partial<Pick<ReportBlobStore, "bind">>)
		| undefined;
	credentials?: ReportHostingCredentials;
	critical: ReportCriticalSection;
	hostOverride?: boolean;
	onChanged?: () => void;
}): ShipJudgmentHistoryRuntime | undefined {
	if (
		!deps.projects.some((project) => project.projectName === "flywheel") ||
		!deps.blob?.resumeReport ||
		deps.hostOverride
	)
		return undefined;
	return new ShipJudgmentHistoryRuntime({
		state: deps.store.getShipJudgmentHistoryState(),
		reader: deps.store.getShipJudgmentHistory(),
		publisher: new HistoryReportPublisher({
			registry: deps.registry,
			blob: deps.blob,
			credentials: deps.credentials,
			critical: deps.critical,
		}),
		onChanged: deps.onChanged,
	});
}
