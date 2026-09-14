import {
	authorizeLeadWrite,
	forwardedLeadAuthorizationEnv,
	type LeadWriteAuthorizationDeps,
} from "flywheel-comm/lead-lease";
import { z } from "zod";
import { discordId } from "../ship-judgment/discord-message.js";
import { createShipJudgmentReplyObserver } from "./ship-judgment-routes.js";

const leadSchema = z
	.object({
		leadId: z.string().min(1).max(200),
		projectName: z.literal("flywheel"),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		leaseClaim: z
			.object({
				leaseKey: z.string().min(1).max(500),
				generation: z.number().int().positive(),
			})
			.strict()
			.optional(),
		carrierClaim: z.string().min(1).max(16384).optional(),
	})
	.strict();
const referenceSchema = z
	.object({
		threadId: discordId,
		messageId: discordId,
		replyToMessageId: discordId,
		leadAuth: leadSchema,
	})
	.strict();
type LeadAuth = z.infer<typeof leadSchema>;
export type ShipJudgmentReferenceDeps = Parameters<
	typeof createShipJudgmentReplyObserver
>[0] & {
	leadLeaseEnv?: NodeJS.ProcessEnv;
	leadWriteAuthorizationDeps?: LeadWriteAuthorizationDeps;
	authorizeLeadRequest?: (auth: LeadAuth) => boolean;
};
/** Authenticated manual refetch for late or edited explanations; no supplied body or author is trusted. */
export async function handleShipJudgmentReference(
	deps: ShipJudgmentReferenceDeps,
	input: unknown,
): Promise<{ code: number; body: { status?: string; error?: string } }> {
	const parsed = referenceSchema.safeParse(input);
	if (!parsed.success)
		return { code: 400, body: { error: "invalid_learning_reference" } };
	const { leadAuth, ...reference } = parsed.data;
	const authorized = () => {
		try {
			if (deps.authorizeLeadRequest) return deps.authorizeLeadRequest(leadAuth);
			authorizeLeadWrite(
				{
					claimedLeadId: leadAuth.leadId,
					env: forwardedLeadAuthorizationEnv(
						{
							claimedLeadId: leadAuth.leadId,
							projectName: leadAuth.projectName,
							identityDigest: leadAuth.identityDigest,
							leaseClaim: leadAuth.leaseClaim,
							carrierClaim: leadAuth.carrierClaim,
						},
						deps.leadLeaseEnv ?? process.env,
					),
				},
				deps.leadWriteAuthorizationDeps,
			);
			return true;
		} catch {
			return false;
		}
	};
	if (!authorized())
		return { code: 403, body: { error: "lead_write_unauthorized" } };
	try {
		const observe = createShipJudgmentReplyObserver({
			...deps,
			canonicalFounderId: () =>
				authorized() ? deps.canonicalFounderId() : undefined,
		});
		const result = await observe({
			...reference,
			leadId: leadAuth.leadId,
			projectName: leadAuth.projectName,
		});
		if (!authorized())
			return { code: 403, body: { error: "lead_write_unauthorized" } };
		return result === "handled"
			? { code: 200, body: { status: "recorded_or_existing" } }
			: result === "retry"
				? { code: 503, body: { error: "learning_reference_unavailable" } }
				: { code: 422, body: { error: "reference_not_verified_explanation" } };
	} catch {
		return { code: 503, body: { error: "learning_reference_unavailable" } };
	}
}
