import { createHash } from "node:crypto";
import { z } from "zod";
import { getLeadCapability, type LeadCapabilityDefinition } from "./catalog.js";

const bounded = z.string().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ruleSource = z.object({ path: bounded, sha256: digest });
const skillSource = z.object({ name: bounded, path: bounded, sha256: digest });
const integration = z.object({
	id: bounded,
	version: bounded,
	toolSchemaDigest: digest,
});
export const personaSkillGapSchema = z
	.object({
		sourceId: z
			.string()
			.regex(/^skill\/[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/)
			.max(134),
		reason: z.enum([
			"missing_persona_skill_manual_fallback",
			"runner_workflow_not_lead_capability",
			"authenticated_research_not_available",
			"research_provider_not_admitted",
			"pinned_persona_skill_changed",
		]),
	})
	.strict();
export const skillInventorySchema = z
	.object({
		name: bounded,
		source: bounded,
		sha256: digest.nullable(),
		enabled: z.boolean().nullable(),
		reason: z.enum(["in_persona_map", "not_in_persona_map"]),
		gapReason: z
			.enum([
				"authenticated_research_not_available",
				"research_provider_not_admitted",
			])
			.optional(),
	})
	.strict();
export const nativeSkillBaselineSchema = z
	.object({
		codexVersion: bounded,
		origin: z
			.object({
				root: z
					.string()
					.min(1)
					.max(4096)
					.refine((path) => path.startsWith("/")),
				files: z
					.array(
						z
							.object({
								path: z
									.string()
									.min(1)
									.max(1024)
									.refine(
										(path) =>
											!path.startsWith("/") &&
											path
												.split("/")
												.every(
													(part) =>
														part !== ".." && part !== "." && part !== "",
												),
									),
								sha256: digest,
							})
							.strict(),
					)
					.min(6)
					.max(512),
			})
			.strict()
			.optional(),
		sources: z
			.array(z.object({ name: bounded, sha256: digest }).strict())
			.length(6),
	})
	.strict();
const projection = z.object({
	schemaVersion: z.literal(1),
	bundleVersion: z.literal(2),
	projectName: bounded,
	leadId: bounded,
	identityDigest: digest,
	backend: z.enum(["codex-app-server", "claude-code"]),
	profile: z.literal("full-access"),
	activationId: bounded,
	browserGeneration: z.string().uuid().optional(),
	sourceRevision: bounded,
	operationIds: z.array(bounded),
	deniedOperationIds: z.array(bounded),
	ruleSources: z.array(ruleSource),
	skillSources: z.array(skillSource),
	skillGaps: z.array(personaSkillGapSchema).max(128).optional(),
	skillInventory: z.array(skillInventorySchema).max(512).optional(),
	nativeSkillBaseline: nativeSkillBaselineSchema.optional(),
	integrations: z.array(integration),
});
export type LeadCapabilityManifest = z.infer<typeof projection> & {
	manifestDigest: string;
};
export interface LeadCapabilityManifestInput {
	skillInventory?: readonly z.infer<typeof skillInventorySchema>[];
	skillGaps?: readonly z.infer<typeof personaSkillGapSchema>[];
	nativeSkillBaseline?: z.infer<typeof nativeSkillBaselineSchema>;
	projectName: string;
	leadId: string;
	identityDigest: string;
	backend: "codex-app-server" | "claude-code";
	profile: "full-access";
	activationId: string;
	browserGeneration?: string;
	sourceRevision: string;
	operations: readonly LeadCapabilityDefinition[];
	ruleSources: readonly { path: string; sha256: string }[];
	skillSources: readonly { name: string; path: string; sha256: string }[];
	integrations: readonly {
		id: string;
		version: string;
		toolSchemaDigest: string;
	}[];
}
function uniqueSorted<T>(
	values: readonly T[],
	key: (value: T) => string,
	ordered = false,
): T[] {
	const seen = new Set<string>();
	for (const value of values) {
		const k = key(value);
		if (seen.has(k)) throw new Error(`Duplicate manifest entry: ${k}`);
		seen.add(k);
	}
	if (ordered) return [...values];
	return [...values].sort((a, b) =>
		key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
	);
}
/** Hashes a public configuration projection. This is not an authorization check. */
export function createLeadCapabilityManifest(
	input: LeadCapabilityManifestInput,
): LeadCapabilityManifest {
	for (const operation of input.operations) {
		if (getLeadCapability(operation.operationId) !== operation)
			throw new Error(
				`Unregistered capability definition: ${operation.operationId}`,
			);
	}
	const operations = uniqueSorted(input.operations, (op) => op.operationId);
	// Explicit construction and schema parsing discard unexpected properties at every level.
	const publicProjection = projection.parse({
		schemaVersion: 1,
		bundleVersion: 2,
		projectName: input.projectName,
		leadId: input.leadId,
		identityDigest: input.identityDigest,
		backend: input.backend,
		profile: input.profile,
		activationId: input.activationId,
		...(input.browserGeneration
			? { browserGeneration: input.browserGeneration }
			: {}),
		sourceRevision: input.sourceRevision,
		operationIds: operations
			.filter((op) => op.classification !== "reserved")
			.map((op) => op.operationId),
		deniedOperationIds: operations
			.filter((op) => op.classification === "reserved")
			.map((op) => op.operationId),
		ruleSources: uniqueSorted(input.ruleSources, (source) => source.path, true),
		skillSources: uniqueSorted(input.skillSources, (source) => source.name),
		...(input.skillInventory !== undefined
			? {
					skillInventory: uniqueSorted(input.skillInventory, (source) =>
						JSON.stringify([source.name, source.source]),
					),
				}
			: {}),
		...(input.skillGaps !== undefined
			? { skillGaps: uniqueSorted(input.skillGaps, (gap) => gap.sourceId) }
			: {}),
		...(input.nativeSkillBaseline
			? {
					nativeSkillBaseline: {
						codexVersion: input.nativeSkillBaseline.codexVersion,
						...(input.nativeSkillBaseline.origin
							? {
									origin: {
										root: input.nativeSkillBaseline.origin.root,
										files: uniqueSorted(
											input.nativeSkillBaseline.origin.files,
											(file) => file.path,
										),
									},
								}
							: {}),
						sources: uniqueSorted(
							input.nativeSkillBaseline.sources,
							(source) => source.name,
						),
					},
				}
			: {}),
		integrations: uniqueSorted(input.integrations, (source) => source.id),
	});
	return {
		...publicProjection,
		manifestDigest: createHash("sha256")
			.update(JSON.stringify(publicProjection))
			.digest("hex"),
	};
}
