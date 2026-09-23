import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import {
	type CanonicalLeadIdentity,
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import {
	forwardedLeadAuthorizationEnv,
	validateClaudeLeadLeaseAuthorization,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { z } from "zod";
import { STANDING_AUTHORITY_ENTRY_IDS } from "../bin/standing-authority.js";

/**
 * FLY-2654 QA2 rework: the confirmer's carrier claim is backend-shaped. A
 * Codex Lead presents its raw carrier instance id (checked against the carrier
 * evidence file); a Claude Lead presents its bound lease generation, which is
 * checked against the live lead-lease store. The production flywheel-cos-lead
 * row is backend claude-code, so the Codex-only check made the shipped
 * ingress deny the only legal confirmer.
 */
export const CLAUDE_LEASE_CARRIER_CLAIM = /^claude-lease:g([1-9][0-9]{0,9})$/;

/** Validated per backend; never trusts caller-supplied identity fields. */
export function confirmerCarrierValid(input: {
	identity: CanonicalLeadIdentity;
	identityDigest: string;
	carrierClaim: string;
	env: NodeJS.ProcessEnv;
}): boolean {
	const { identity } = input;
	if (identity.backend === "claude-code") {
		const match = CLAUDE_LEASE_CARRIER_CLAIM.exec(input.carrierClaim);
		if (!match) return false;
		const env = forwardedLeadAuthorizationEnv(
			{
				claimedLeadId: identity.leadId,
				projectName: identity.projectName,
				identityDigest: input.identityDigest,
				leaseClaim: {
					leaseKey: identity.leadKey,
					generation: Number(match[1]),
				},
			},
			input.env,
		);
		return validateClaudeLeadLeaseAuthorization({
			claimedLeadId: identity.leadId,
			env,
		}).valid;
	}
	const env = forwardedLeadAuthorizationEnv(
		{
			claimedLeadId: identity.leadId,
			projectName: identity.projectName,
			identityDigest: input.identityDigest,
			carrierClaim: input.carrierClaim,
		},
		input.env,
	);
	const carrier = validateLeadCarrierAuthorization({
		claimedLeadId: identity.leadId,
		env,
	});
	return carrier.valid && !carrier.processIndeterminate;
}

const requestSchema = z
	.object({
		schemaVersion: z.literal(1),
		projectName: z.literal("flywheel"),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		entryId: z.enum(STANDING_AUTHORITY_ENTRY_IDS),
		revision: z.number().int().positive(),
		pendingManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export interface StandingAuthorityConfirmationRouteOptions {
	apiToken: string;
	confirm(input: {
		entryId: (typeof STANDING_AUTHORITY_ENTRY_IDS)[number];
		revision: number;
		pendingManifestDigest: string;
		authenticatedIdentity: CanonicalLeadIdentity;
		/** Validated identity digest and carrier claim, recorded in the ledger. */
		authenticatedIdentityDigest: string;
		carrierClaim: string;
	}): Promise<unknown> | unknown;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	projectsPath?: string;
}

/** Restricted Bridge ingress for the one independent confirmer. */
export function createStandingAuthorityConfirmationRouter(
	options: StandingAuthorityConfirmationRouteOptions,
): Router {
	const router = Router();
	router.post("/", async (req, res) => {
		const supplied = Buffer.from(req.headers.authorization ?? "");
		const expected = Buffer.from(`Bearer ${options.apiToken}`);
		if (
			!options.apiToken ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			res.status(401).json({ status: "rejected", errorCode: "unauthorized" });
			return;
		}
		const parsed = requestSchema.safeParse(req.body);
		if (
			!parsed.success ||
			Buffer.byteLength(JSON.stringify(req.body)) > 16_384
		) {
			res
				.status(400)
				.json({ status: "rejected", errorCode: "invalid_request" });
			return;
		}
		try {
			const body = parsed.data;
			const base = options.env ?? process.env;
			const home = options.homeDir ?? homedir();
			const projectsPath =
				options.projectsPath ??
				base.FLYWHEEL_PROJECTS_FILE ??
				join(home, ".flywheel/projects.json");
			const row = resolveLeadIdentityRow({
				projectsPath,
				homeDir: home,
				projectName: body.projectName,
				leadId: "flywheel-cos-lead",
			});
			const env: NodeJS.ProcessEnv = {
				...base,
				...Object.fromEntries(
					identityEnvProjection(row.identity).map((line) => {
						const at = line.indexOf("=");
						return [line.slice(0, at), line.slice(at + 1)];
					}),
				),
				HOME: home,
				FLYWHEEL_PROJECTS_FILE: projectsPath,
			};
			if (
				row.identity.identityDigest !== body.identityDigest ||
				row.identity.role !== "cos" ||
				!confirmerCarrierValid({
					identity: row.identity,
					identityDigest: body.identityDigest,
					carrierClaim: body.carrierClaim,
					env,
				})
			)
				throw new Error("standing_authority_confirmer_denied");
			res.json(
				await options.confirm({
					entryId: body.entryId,
					revision: body.revision,
					pendingManifestDigest: body.pendingManifestDigest,
					authenticatedIdentity: row.identity,
					authenticatedIdentityDigest: row.identity.identityDigest,
					carrierClaim: body.carrierClaim,
				}),
			);
		} catch {
			res.status(403).json({
				status: "rejected",
				errorCode: "standing_authority_confirmer_denied",
			});
		}
	});
	return router;
}
