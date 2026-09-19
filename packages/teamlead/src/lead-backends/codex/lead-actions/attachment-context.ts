import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";

export interface LeadAttachmentContext {
	projectsPath: string;
	projectName: string;
	leadId: string;
	identityDigest: string;
}

/** Canonical v1-only context. Direct transport intentionally has no authority. */
export function resolveLeadAttachmentContext(options: {
	projectsPath: string;
	homeDir: string;
	projectName: string;
	leadId: string;
	identityDigest: string;
	outboundMode: "direct" | "bridge";
}): LeadAttachmentContext | undefined {
	if (options.outboundMode !== "bridge") return undefined;
	try {
		const row = resolveLeadIdentityRow({
			projectsPath: options.projectsPath,
			homeDir: options.homeDir,
			projectName: options.projectName,
			leadId: options.leadId,
		});
		if (
			row.identity.identityDigest !== options.identityDigest ||
			row.identity.backend !== "codex-app-server" ||
			row.lead.codexCapabilityBundleVersion !== undefined
		)
			throw new Error("attachment_context_denied");
		return {
			projectsPath: options.projectsPath,
			projectName: options.projectName,
			leadId: options.leadId,
			identityDigest: options.identityDigest,
		};
	} catch {
		throw new Error("attachment_context_denied");
	}
}

/** Fail-closed optional projection: denial means the tool stays unavailable. */
export function tryResolveLeadAttachmentContext(
	options: Parameters<typeof resolveLeadAttachmentContext>[0],
): LeadAttachmentContext | undefined {
	try {
		return resolveLeadAttachmentContext(options);
	} catch {
		return undefined;
	}
}
