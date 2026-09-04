import express from "express";
import { withSyncOpMarker } from "flywheel-claude-runner";
import {
	collectLeadLeaseDiagnostics,
	type LeadWriteAuthorizationDeps,
	processAliveWithStart,
	processEnvHas,
} from "flywheel-comm/lead-lease";

const DIAGNOSTICS_PROBE_BUDGET_MS = 20_000;

export class LeadLeaseDiagnosticsBudgetError extends Error {
	constructor() {
		super("lead lease diagnostics process-probe budget exhausted");
		this.name = "LeadLeaseDiagnosticsBudgetError";
	}
}

export function createLeadLeaseDiagnosticsRouter(
	deps: {
		env?: NodeJS.ProcessEnv;
		authorizationDeps?: LeadWriteAuthorizationDeps;
		monotonicNow?: () => number;
	} = {},
): express.Router {
	const router = express.Router();
	router.get("/", (_req, res) => {
		const monotonicNow = deps.monotonicNow ?? (() => performance.now());
		const deadline = monotonicNow() + DIAGNOSTICS_PROBE_BUDGET_MS;
		const checkBudget = (): void => {
			if (monotonicNow() >= deadline) {
				throw new LeadLeaseDiagnosticsBudgetError();
			}
		};
		const supplied = deps.authorizationDeps;
		const authorizationDeps: LeadWriteAuthorizationDeps = {
			...supplied,
			processAliveWithStart: (pid, start) => {
				checkBudget();
				return withSyncOpMarker("lead-lease-diagnostics:process-alive", () =>
					(supplied?.processAliveWithStart ?? processAliveWithStart)(
						pid,
						start,
					),
				);
			},
			processEnvHas: (pid, name) => {
				checkBudget();
				return withSyncOpMarker("lead-lease-diagnostics:process-env", () =>
					(supplied?.processEnvHas ?? processEnvHas)(pid, name),
				);
			},
		};
		try {
			res
				.status(200)
				.json(
					collectLeadLeaseDiagnostics(
						deps.env ?? process.env,
						authorizationDeps,
					),
				);
		} catch (error) {
			const budgetExhausted = error instanceof LeadLeaseDiagnosticsBudgetError;
			res.status(budgetExhausted ? 503 : 500).json({
				schemaVersion: 1,
				healthy: false,
				reason: budgetExhausted ? "sensor_unavailable" : "diagnostics_failed",
			});
		}
	});
	return router;
}
