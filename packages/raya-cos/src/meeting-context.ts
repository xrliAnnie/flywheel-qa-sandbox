import type { CoSLead, LeadRef } from "./ports.js";

export type LeadResolution =
	| { status: "found"; ref: LeadRef; lead: CoSLead }
	| { status: "not_found" }
	| { status: "ambiguous"; candidates: LeadRef[] };

export interface LeadDirectoryProjection {
	projectsDigest: string;
	leads: readonly CoSLead[];
	resolve(name: string): LeadResolution;
}

function normalizeName(value: string): string {
	return value
		.normalize("NFKC")
		.replaceAll(/\s/gu, "")
		.toLocaleLowerCase("en-US");
}

export function createLeadDirectory(
	projectsDigest: string,
	leads: readonly CoSLead[],
): LeadDirectoryProjection {
	if (!projectsDigest) throw new Error("projects digest is required");
	return {
		projectsDigest,
		leads,
		resolve(name: string): LeadResolution {
			const key = normalizeName(name);
			if (!key) return { status: "not_found" };
			const matches = leads.filter((lead) =>
				[lead.displayName, ...lead.aliases, lead.ref.leadId].some(
					(candidate) => normalizeName(candidate) === key,
				),
			);
			if (matches.length === 0) return { status: "not_found" };
			if (matches.length > 1) {
				return {
					status: "ambiguous",
					candidates: matches.map((lead) => lead.ref),
				};
			}
			const lead = matches[0];
			if (!lead) return { status: "not_found" };
			return { status: "found", ref: lead.ref, lead };
		},
	};
}
