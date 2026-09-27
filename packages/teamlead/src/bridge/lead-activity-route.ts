/**
 * FLY-2882 — read-only "is this Lead busy" endpoints (master token only).
 *
 *   GET /api/lead-activity?projectName=<p>&leadId=<l>  → LeadActivityV1
 *   GET /api/lead-activity/fleet                       → LeadActivityFleetV1
 *
 * Read failures are 200 + `state: "unknown"` from the service; only bad
 * arguments (400), an unregistered Lead (404) and auth are refusals. Every DTO
 * passes the exact-key validator before it leaves; a violation is a 500 with
 * no body details.
 */

import express from "express";
import {
	isValidLeadActivity,
	isValidLeadActivityFleet,
	type LeadActivityFleetV1,
	type LeadActivityV1,
} from "./lead-activity/types.js";

export interface LeadActivityRouterDeps {
	read(
		projectName: string,
		leadId: string,
	): Promise<LeadActivityV1 | undefined>;
	readFleet(): Promise<LeadActivityFleetV1>;
}

const IDENTITY_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function createLeadActivityRouter(
	deps: LeadActivityRouterDeps,
): express.Router {
	const router = express.Router();
	const refuse = (
		res: express.Response,
		status: number,
		reason: "invalid_arguments" | "unknown_lead" | "lead_activity_failed",
	) => {
		res.status(status).json({ kind: "refused", reason });
	};

	router.get("/fleet", async (req, res) => {
		res.set("Cache-Control", "no-store");
		if (Object.keys(req.query).length !== 0) {
			refuse(res, 400, "invalid_arguments");
			return;
		}
		try {
			const fleet = await deps.readFleet();
			if (!isValidLeadActivityFleet(fleet)) {
				refuse(res, 500, "lead_activity_failed");
				return;
			}
			res.json(fleet);
		} catch {
			refuse(res, 500, "lead_activity_failed");
		}
	});

	router.get("/", async (req, res) => {
		res.set("Cache-Control", "no-store");
		const keys = Object.keys(req.query);
		const { projectName, leadId } = req.query;
		if (
			keys.length !== 2 ||
			typeof projectName !== "string" ||
			typeof leadId !== "string" ||
			!IDENTITY_RE.test(projectName) ||
			!IDENTITY_RE.test(leadId)
		) {
			refuse(res, 400, "invalid_arguments");
			return;
		}
		try {
			const activity = await deps.read(projectName, leadId);
			if (activity === undefined) {
				refuse(res, 404, "unknown_lead");
				return;
			}
			if (
				!isValidLeadActivity(activity) ||
				activity.projectName !== projectName ||
				activity.leadId !== leadId
			) {
				refuse(res, 500, "lead_activity_failed");
				return;
			}
			res.json(activity);
		} catch {
			refuse(res, 500, "lead_activity_failed");
		}
	});
	return router;
}
