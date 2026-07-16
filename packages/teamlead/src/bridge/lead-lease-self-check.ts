import express from "express";
import {
	type LeadWriteAuthorizationDeps,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { loopbackSelfOrigin } from "./loopback-origin.js";

export interface LeadLeaseSelfCheckRouterDeps {
	env?: NodeJS.ProcessEnv;
	authorizationDeps?: LeadWriteAuthorizationDeps;
}

/**
 * Authenticate a carrier claim using the same side-effect-free predicate as
 * runtime Lead writes. Bearer authentication is deliberately mounted outside
 * this router so the endpoint shares Bridge's master-token policy.
 */
export function createLeadLeaseSelfCheckRouter(
	deps: LeadLeaseSelfCheckRouterDeps = {},
): express.Router {
	const router = express.Router();
	router.post("/", (req, res) => {
		if (!loopbackSelfOrigin(req.headers.host)) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}

		const body = req.body as Record<string, unknown> | undefined;
		const leadId = body?.leadId;
		if (typeof leadId !== "string" || leadId.length === 0) {
			res.status(400).json({ ok: false, reason: "lead_id_required" });
			return;
		}

		const env = { ...(deps.env ?? process.env) };
		delete env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
		if (
			typeof body?.carrierClaim === "string" &&
			body.carrierClaim.length > 0
		) {
			env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = body.carrierClaim;
		}
		if (typeof body?.projectName === "string" && body.projectName.length > 0) {
			env.FLYWHEEL_PROJECT_NAME = body.projectName;
		}

		try {
			const validation = validateLeadCarrierAuthorization(
				{ claimedLeadId: leadId, env },
				deps.authorizationDeps,
			);
			if (!validation.valid) {
				res.status(409).json({ ok: false, reason: validation.reason });
				return;
			}
			res.status(200).json({
				ok: true,
				disposition: validation.disposition,
				leadKey: validation.leadKey,
				carrier: validation.carrier,
			});
		} catch {
			res.status(500).json({ ok: false, reason: "self_check_failed" });
		}
	});
	return router;
}
