import express from "express";
import {
	collectLeadLeaseDiagnostics,
	type LeadWriteAuthorizationDeps,
} from "flywheel-comm/lead-lease";

export function createLeadLeaseDiagnosticsRouter(
	deps: {
		env?: NodeJS.ProcessEnv;
		authorizationDeps?: LeadWriteAuthorizationDeps;
	} = {},
): express.Router {
	const router = express.Router();
	router.get("/", (_req, res) => {
		try {
			res
				.status(200)
				.json(
					collectLeadLeaseDiagnostics(
						deps.env ?? process.env,
						deps.authorizationDeps,
					),
				);
		} catch {
			res.status(500).json({
				schemaVersion: 1,
				healthy: false,
				reason: "diagnostics_failed",
			});
		}
	});
	return router;
}
