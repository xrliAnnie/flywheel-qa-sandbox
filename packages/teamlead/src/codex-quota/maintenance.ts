import type { StateStore } from "../StateStore.js";
import type { CodexQuotaAvailabilitySnapshot } from "./availability.js";

export interface CodexQuotaMaintenanceOptions {
	store: StateStore;
	refreshAvailability(): Promise<CodexQuotaAvailabilitySnapshot>;
	runtime(): { tick(): Promise<void> } | undefined;
	flushOutbox(): Promise<void>;
	projectAudit(): Promise<void>;
	/**
	 * FLY-2869: record manual canonical switches (and their N1) even when the
	 * auto-switch runtime is not constructed. Only called while it is absent:
	 * the runtime's own tick already reconciles the canonical credential.
	 */
	reconcileCanonical?(): Promise<void>;
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
				if (!options.runtime() && options.reconcileCanonical) {
					try {
						await options.reconcileCanonical();
					} catch (error) {
						// Its own boundary: a failed reconciliation never blocks the
						// outbox, the audit projection or the next tick's retry.
						console.warn(
							"[Bridge] Codex canonical reconciliation failed",
							error instanceof Error ? error.message : String(error),
						);
					}
				}
				await options.flushOutbox();
				await options.projectAudit();
			}
		},
	};
}
