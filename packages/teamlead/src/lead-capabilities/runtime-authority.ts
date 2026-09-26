import type { CompiledLeadIdentityRow } from "flywheel-comm/lead-identity";
import type { LeadCapabilityAuthority } from "./authority.js";
import { createLeadCapabilityContext } from "./runtime-context.js";

export interface LeadCapabilityRuntimeAuthorityOptions {
	env: NodeJS.ProcessEnv;
	authority?: LeadCapabilityAuthority;
	assertActivationCurrent?: () => CompiledLeadIdentityRow;
}

export function resolveLeadCapabilityRuntimeAuthority(
	options: LeadCapabilityRuntimeAuthorityOptions,
) {
	const carrierClaim = options.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	const authority: LeadCapabilityAuthority = options.authority ?? {
		kind: "carrier",
		carrierClaim: carrierClaim ?? "",
	};
	if (authority.kind === "carrier" && !authority.carrierClaim)
		throw new Error("capability_authority_missing");
	const trusted = options.assertActivationCurrent
		? { assertActivationCurrent: options.assertActivationCurrent }
		: createLeadCapabilityContext(options.env);
	return Object.freeze({
		authority,
		authoritySecret:
			authority.kind === "carrier"
				? authority.carrierClaim
				: authority.leaseFence,
		trusted,
	});
}
