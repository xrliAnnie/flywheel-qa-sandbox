/**
 * FLY-1456: the Bridge account-switch execution surface is permanently
 * retired. Authentication remains outside this router in plugin.ts, so a
 * tokenless deployment still returns 503 and an authenticated request gets
 * this stable 410 response.
 */
import { Router } from "express";

export function createAccountSwitchRouter(): Router {
	const router = Router();

	router.post("/", (_req, res) => {
		res.status(410).json({
			error: "retired",
			reason: "quota_daemon_cutover",
		});
	});

	return router;
}
