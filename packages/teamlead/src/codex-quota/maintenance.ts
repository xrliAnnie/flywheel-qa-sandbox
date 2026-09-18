import type { StateStore } from "../StateStore.js";
import type { CodexQuotaAvailabilitySnapshot } from "./availability.js";

export interface CodexQuotaMaintenanceOptions {
	store: StateStore;
	refreshAvailability(): Promise<CodexQuotaAvailabilitySnapshot>;
	runtime(): { tick(): Promise<void> } | undefined;
	flushOutbox(): Promise<void>;
	projectAudit(): Promise<void>;
}

/**
 * Production Bridge wiring and replay tests use this same factory. The legacy
 * pass is always-on: it cannot disappear merely because auto-switch runtime is
 * disabled or readiness is unavailable.
 */
export function createCodexQuotaMaintenance(
	options: CodexQuotaMaintenanceOptions,
): { bootstrap(): Promise<void>; tick(): Promise<void> } {
	const observeAndMigrate = async () => {
		const availability = await options.refreshAvailability();
		options.store.codexQuota.backfillHistoricalQuotaFailures();
		if (availability.mode === "manual")
			for (const incident of options.store.codexQuota.listIncidents())
				options.store.codexQuota.handoffIncidentManual(
					String(incident.incident_id),
					availability.reasons,
					availability.checkedAt ?? new Date().toISOString(),
				);
	};
	return {
		bootstrap: observeAndMigrate,
		async tick() {
			try {
				await observeAndMigrate();
				await options.runtime()?.tick();
			} finally {
				await options.flushOutbox();
				await options.projectAudit();
			}
		},
	};
}
