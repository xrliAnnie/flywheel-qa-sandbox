/**
 * GEO-288: /api/standup routes — daily standup trigger.
 *
 * POST /api/standup/trigger — trigger standup report generation + delivery.
 * Project name is pre-configured via STANDUP_PROJECT_NAME (resolved at startup).
 */

import { Router } from "express";
import type { StandupService } from "./standup-service.js";

export function createStandupRouter(
	service: StandupService,
	standupProjectName: string,
): Router {
	const router = Router();

	router.post("/trigger", async (req, res) => {
		const { dryRun } = (req.body ?? {}) as {
			dryRun?: boolean;
		};

		// Dry run — return report only, no delivery
		if (dryRun) {
			try {
				const report = await service.runDryRun(standupProjectName);
				res.json({
					triggered: true,
					report,
					delivered: false,
					dryRun: true,
				});
			} catch (err) {
				console.error(
					"[standup/trigger] dry run failed:",
					(err as Error).message,
				);
				res.status(500).json({
					error: `Standup aggregation failed: ${(err as Error).message}`,
				});
			}
			return;
		}

		// Delivery requires STANDUP_CHANNEL
		if (!service.getStandupChannel()) {
			res.status(400).json({
				error:
					"STANDUP_CHANNEL not configured — cannot deliver. Use dryRun=true to preview report.",
			});
			return;
		}

		try {
			const result = await service.run(standupProjectName);

			res.json({
				triggered: true,
				report: result.report,
				delivered: true,
				channelId: result.channelId,
				messageCount: result.messageCount,
			});
		} catch (err) {
			console.error(
				"[standup/trigger] delivery failed:",
				(err as Error).message,
			);
			res.status(500).json({
				error: `Standup delivery failed: ${(err as Error).message}`,
			});
		}
	});

	return router;
}
