import { z } from "zod";

export const LeadCapabilityAuthoritySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("carrier"),
			carrierClaim: z.string().min(1).max(256),
		})
		.strict(),
	z
		.object({
			kind: z.literal("voice_session"),
			sessionId: z.string().uuid(),
			leaseFence: z.string().min(1).max(256),
		})
		.strict(),
]);

export type LeadCapabilityAuthority = z.infer<
	typeof LeadCapabilityAuthoritySchema
>;

export const leadCapabilityAuthorityFields = {
	authority: LeadCapabilityAuthoritySchema.optional(),
	/** Temporary wire compatibility for already-running resident parents. */
	carrierClaim: z.string().min(1).max(256).optional(),
};

export function leadCapabilityAuthorityFromEnvelope(input: {
	authority?: LeadCapabilityAuthority;
	carrierClaim?: string;
}): LeadCapabilityAuthority {
	if (input.authority && input.carrierClaim)
		throw new Error("capability_authority_ambiguous");
	if (input.authority) return input.authority;
	if (input.carrierClaim)
		return { kind: "carrier", carrierClaim: input.carrierClaim };
	throw new Error("capability_authority_missing");
}
