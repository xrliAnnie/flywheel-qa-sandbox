type LeadReconcileStep = () => unknown | Promise<unknown>;

export interface LeadReconcilePassDeps {
	reconcileLeaseEpisodes: LeadReconcileStep;
	scanLeadIdentities: LeadReconcileStep;
	materializeLeaseAudit: LeadReconcileStep;
	tickFleetSensors: LeadReconcileStep;
	reconcileAlerts: LeadReconcileStep;
	logger?: (message: string) => void;
}

/** Run every retained Lead reconciliation rider in dependency order. */
export async function runLeadReconcilePass(
	deps: LeadReconcilePassDeps,
): Promise<void> {
	const run = async (name: string, step: LeadReconcileStep) => {
		try {
			await step();
		} catch (error) {
			(deps.logger ?? console.warn)(
				`[Bridge] ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	await run("lease episode reconcile", deps.reconcileLeaseEpisodes);
	await run("lead identity scan", deps.scanLeadIdentities);
	await run("lease audit outbox", deps.materializeLeaseAudit);
	await run("fleet-sensors tick", deps.tickFleetSensors);
	await run("alertHub.reconcile", deps.reconcileAlerts);
}
