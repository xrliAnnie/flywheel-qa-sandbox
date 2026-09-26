import type { CompiledLeadIdentityRow } from "flywheel-comm/lead-identity";
import type { LeadCapabilityAuthority } from "./authority.js";
import { createLeadCapabilityContext } from "./runtime-context.js";

export interface LeadCapabilityRuntimeAuthorityOptions {
	env: NodeJS.ProcessEnv;
	authority?: LeadCapabilityAuthority;
	assertActivationCurrent?: () => CompiledLeadIdentityRow;
}

/**
 * The trusted registry context is built exactly as before the authority union;
 * the wire authority is resolved only when a consumer reads it, so handlers
 * that never send an authority keep the pre-union resident construction path.
 */
export function resolveLeadCapabilityRuntimeAuthority(
	options: LeadCapabilityRuntimeAuthorityOptions,
) {
	const carrierClaim = options.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	const authority: LeadCapabilityAuthority | undefined =
		options.authority ??
		(carrierClaim ? { kind: "carrier", carrierClaim } : undefined);
	const trusted = options.assertActivationCurrent
		? { assertActivationCurrent: options.assertActivationCurrent }
		: createLeadCapabilityContext(options.env);
	const required = (): LeadCapabilityAuthority => {
		if (!authority) throw new Error("capability_authority_missing");
		return authority;
	};
	return Object.freeze({
		get authority(): LeadCapabilityAuthority {
			return required();
		},
		get authoritySecret(): string {
			const value = required();
			return value.kind === "carrier" ? value.carrierClaim : value.leaseFence;
		},
		trusted,
	});
}
