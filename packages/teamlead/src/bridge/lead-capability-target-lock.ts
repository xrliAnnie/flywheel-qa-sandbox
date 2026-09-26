import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { forwardedLeadAuthorizationEnv } from "flywheel-comm/lead-lease";
import { z } from "zod";
import type { StateStore } from "../StateStore.js";
import {
	leadCapabilityAuthorityFields,
	leadCapabilityAuthorityFromEnvelope,
} from "../lead-capabilities/authority.js";
import { captureLeadCapabilityScope } from "./lead-capability-scope.js";

const coordinate = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const base = {
	projectName: coordinate,
	leadId: coordinate,
	identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
	...leadCapabilityAuthorityFields,
	activationId: coordinate,
	operationId: coordinate,
	requestId: z.string().uuid(),
	targetKey: z
		.string()
		.min(1)
		.max(512)
		.refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
};
const acquireSchema = z
	.object({ ...base, deadline: z.number().int().positive().safe() })
	.strict();
const fenceSchema = z
	.object({ ...base, fence: z.string().uuid() })
	.strict();
const releaseSchema = fenceSchema.extend({
	outcome: z.enum(["succeeded", "rejected", "not_dispatched", "unknown"]),
	reason: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/).optional(),
});
const cancelSchema = z.object(base).strict();
const denied = () => new Error("target_lock_scope_denied");

export function createLeadCapabilityTargetLockRouter(options: {
	store: StateStore;
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}): Router {
	const router = Router();
	const env = Object.freeze({ ...(options.env ?? process.env) });
	const home = options.homeDir ?? env.HOME ?? homedir();
	const projectsPath =
		options.projectsPath ??
		env.FLYWHEEL_PROJECTS_FILE ??
		join(home, ".flywheel/projects.json");
	const authorize = (body: z.infer<typeof cancelSchema>) => {
		const authority = leadCapabilityAuthorityFromEnvelope(body);
		const claimEnv =
			authority.kind === "carrier"
				? forwardedLeadAuthorizationEnv(
						{
							claimedLeadId: body.leadId,
							projectName: body.projectName,
							identityDigest: body.identityDigest,
							carrierClaim: authority.carrierClaim,
						},
						{ ...env, HOME: home, FLYWHEEL_PROJECTS_FILE: projectsPath },
					)
				: undefined;
		const scope = captureLeadCapabilityScope({
			projectsPath,
			homeDir: home,
			projectName: body.projectName,
			leadId: body.leadId,
			identityDigest: body.identityDigest,
			authority,
			claimEnv,
			stateStore: options.store,
			now: () => new Date(options.now?.() ?? Date.now()).toISOString(),
			denied,
		});
		scope.assertSourceCurrent();
		return { authority, scope };
	};
	router.post("/acquire", (req, res) => {
		try {
			const body = acquireSchema.parse(req.body);
			const { authority, scope } = authorize(body);
			const now = options.now?.() ?? Date.now();
			if (body.deadline <= now || body.deadline > now + 60_000) throw denied();
			scope.assertSourceCurrent();
			const result = options.store.acquireCapabilityTargetLock({
				targetKey: body.targetKey,
				projectName: body.projectName,
				leadId: body.leadId,
				actor: authority.kind === "voice_session" ? "voice" : "resident",
				activationId: body.activationId,
				requestId: body.requestId,
				now,
				deadline: body.deadline,
			});
			res.json({ requestId: body.requestId, ...result });
		} catch {
			res.status(403).json({ error: "target lock scope denied" });
		}
	});
	router.post("/mark-dispatched", (req, res) => {
		try {
			const body = fenceSchema.parse(req.body);
			const { scope } = authorize(body);
			scope.assertSourceCurrent();
			const marked = options.store.markCapabilityTargetLockDispatched({
				targetKey: body.targetKey,
				activationId: body.activationId,
				requestId: body.requestId,
				fence: body.fence,
				now: options.now?.() ?? Date.now(),
			});
			res.json({
				requestId: body.requestId,
				status: marked ? "marked" : "not_owner",
			});
		} catch {
			res.status(403).json({ error: "target lock scope denied" });
		}
	});
	router.post("/release", (req, res) => {
		try {
			const body = releaseSchema.parse(req.body);
			const { authority, scope } = authorize(body);
			scope.assertSourceCurrent();
			const status = options.store.releaseCapabilityTargetLock({
				targetKey: body.targetKey,
				activationId: body.activationId,
				requestId: body.requestId,
				fence: body.fence,
				outcome: body.outcome,
				reason: body.reason,
			});
			if (authority.kind === "voice_session" && body.outcome === "succeeded")
				options.store.tryClaimLeadEvent(
					body.leadId,
					`voice-background-action:${body.requestId}`,
					"voice_background_action",
					JSON.stringify({
						operationId: body.operationId,
						targetKey: body.targetKey,
						receiptId: body.requestId,
						sessionId: authority.sessionId,
					}),
				);
			res.json({ requestId: body.requestId, status });
		} catch {
			res.status(403).json({ error: "target lock scope denied" });
		}
	});
	router.post("/cancel", (req, res) => {
		try {
			const body = cancelSchema.parse(req.body);
			const { scope } = authorize(body);
			scope.assertSourceCurrent();
			options.store.cancelCapabilityTargetLockWaiter({
				targetKey: body.targetKey,
				activationId: body.activationId,
				requestId: body.requestId,
			});
			res.json({ requestId: body.requestId, status: "cancelled" });
		} catch {
			res.status(403).json({ error: "target lock scope denied" });
		}
	});
	return router;
}
