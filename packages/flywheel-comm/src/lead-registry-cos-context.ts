import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compileLeadIdentityRows } from "./lead-identity.js";
import { compileSummaryAssignments } from "./summary-assignment.js";
import type { SummaryGranularitySelection } from "./summary-config.js";
import type { SummaryMigrationReceipt } from "./summary-registry-migration.js";

export type LeadRegistryCoSContextErrorCode =
	| "lead_registry_cos_context_manifest_invalid"
	| "lead_registry_cos_context_preimage_stale"
	| "lead_registry_cos_context_lead_missing"
	| "lead_registry_cos_context_identity_conflict"
	| "lead_registry_cos_context_path_invalid"
	| "lead_registry_cos_context_alias_ambiguous";

export class LeadRegistryCoSContextError extends Error {
	constructor(
		readonly code: LeadRegistryCoSContextErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadRegistryCoSContextError";
	}
}

export interface LeadCoSContext {
	displayName: string;
	aliases: string[];
	workingSubdirectory: string;
	identityPath: string;
	memoryPaths: string[];
	writableRoots: string[];
}

export interface LeadRegistryCoSContextImportRow {
	projectName: string;
	leadId: string;
	botUserId: string;
	expectedLeadSha256: string;
	cosContext: LeadCoSContext;
}

export interface LeadRegistryCoSContextImport {
	schemaVersion: 1;
	rows: LeadRegistryCoSContextImportRow[];
}

export interface LeadRegistryCoSContextPlan {
	kind: "update" | "continuation";
	candidateRegistry: unknown;
	candidateText: string;
	updatedLeadKeys: string[];
	planned: { projectsSha: string; receiptDigest: string };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function digestLeadRegistryRow(value: unknown): string {
	return sha256(JSON.stringify(value));
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
): void {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
	if (unknown.length > 0) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where} has unknown fields: ${unknown.sort().join(", ")}`,
		);
	}
}

function registryProjects(registry: unknown): Array<Record<string, unknown>> {
	const value =
		registry !== null &&
		typeof registry === "object" &&
		!Array.isArray(registry) &&
		"projects" in registry
			? (registry as { projects: unknown }).projects
			: registry;
	if (!Array.isArray(value)) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			"projects registry must be an array or {projects: array}",
		);
	}
	return value as Array<Record<string, unknown>>;
}

function normalizedName(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\s+/gu, "")
		.toLocaleLowerCase("en-US");
}

function requireRealFile(path: string, where: string): string {
	if (!isAbsolute(path)) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where} must be absolute`,
		);
	}
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where} must be a regular non-symlink file`,
		);
	}
	return realpathSync.native(path);
}

function requireRealDirectory(path: string, where: string): string {
	if (!isAbsolute(path)) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where} must be absolute`,
		);
	}
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where} must be a real non-symlink directory`,
		);
	}
	return realpathSync.native(path);
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
	);
}

function validateContext(
	contextValue: unknown,
	projectRoot: string,
	where: string,
): LeadCoSContext {
	if (
		contextValue === null ||
		typeof contextValue !== "object" ||
		Array.isArray(contextValue)
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where} must be an object`,
		);
	}
	const context = contextValue as Record<string, unknown>;
	exactKeys(
		context,
		[
			"displayName",
			"aliases",
			"workingSubdirectory",
			"identityPath",
			"memoryPaths",
			"writableRoots",
		],
		where,
	);
	if (
		typeof context.displayName !== "string" ||
		context.displayName.trim().length === 0
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where}.displayName must be non-empty`,
		);
	}
	if (
		!Array.isArray(context.aliases) ||
		context.aliases.some(
			(value) => typeof value !== "string" || value.trim().length === 0,
		)
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where}.aliases must contain non-empty strings`,
		);
	}
	if (
		typeof context.workingSubdirectory !== "string" ||
		context.workingSubdirectory.length === 0 ||
		isAbsolute(context.workingSubdirectory)
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where}.workingSubdirectory must be relative`,
		);
	}
	const realProjectRoot = requireRealDirectory(
		projectRoot,
		`${where}.projectRoot`,
	);
	const realWorkingRoot = requireRealDirectory(
		resolve(realProjectRoot, context.workingSubdirectory),
		`${where}.workingSubdirectory`,
	);
	if (!isInside(realProjectRoot, realWorkingRoot)) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where}.workingSubdirectory escapes projectRoot`,
		);
	}
	const identityPath = requireRealFile(
		String(context.identityPath),
		`${where}.identityPath`,
	);
	if (!Array.isArray(context.memoryPaths) || context.memoryPaths.length === 0) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where}.memoryPaths must be non-empty`,
		);
	}
	const memoryPaths = context.memoryPaths.map((value, index) =>
		requireRealFile(String(value), `${where}.memoryPaths[${index}]`),
	);
	if (
		!Array.isArray(context.writableRoots) ||
		context.writableRoots.length === 0
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			`${where}.writableRoots must be non-empty`,
		);
	}
	const writableRoots = context.writableRoots.map((value, index) =>
		requireRealDirectory(String(value), `${where}.writableRoots[${index}]`),
	);
	if (!writableRoots.some((root) => isInside(root, realWorkingRoot))) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_path_invalid",
			`${where}.workingSubdirectory is outside writableRoots`,
		);
	}
	for (const protectedPath of [identityPath, ...memoryPaths]) {
		if (writableRoots.some((root) => isInside(root, protectedPath))) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_path_invalid",
				`${where} read-only identity or memory overlaps writableRoots`,
			);
		}
	}
	return {
		displayName: context.displayName,
		aliases: [...context.aliases] as string[],
		workingSubdirectory: relative(realProjectRoot, realWorkingRoot) || ".",
		identityPath,
		memoryPaths,
		writableRoots,
	};
}

export function planLeadRegistryCoSContextImport(
	registry: unknown,
	receipt: SummaryMigrationReceipt,
	selection: SummaryGranularitySelection,
	manifestValue: unknown,
): LeadRegistryCoSContextPlan {
	if (selection.state !== "selected" || selection.granularity !== "per-lead") {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_preimage_stale",
			"CoS context import requires per-lead summary granularity",
		);
	}
	const currentProjection = compileSummaryAssignments(registry, selection);
	if (
		receipt.granularity !== "per-lead" ||
		receipt.summaryAssignmentDigest !== currentProjection.digest
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_preimage_stale",
			"projects registry does not match the active summary migration receipt",
		);
	}
	if (
		manifestValue === null ||
		typeof manifestValue !== "object" ||
		Array.isArray(manifestValue)
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			"import manifest must be an object",
		);
	}
	const manifest = manifestValue as Record<string, unknown>;
	exactKeys(manifest, ["schemaVersion", "rows"], "manifest");
	if (
		manifest.schemaVersion !== 1 ||
		!Array.isArray(manifest.rows) ||
		manifest.rows.length !== 14
	) {
		throw new LeadRegistryCoSContextError(
			"lead_registry_cos_context_manifest_invalid",
			"manifest must contain exactly 14 schemaVersion 1 rows",
		);
	}
	const candidate = structuredClone(registry);
	const projects = registryProjects(candidate);
	const targets = new Set<string>();
	const aliases = new Map<string, string>();
	let changed = false;
	for (const [index, rowValue] of manifest.rows.entries()) {
		if (
			rowValue === null ||
			typeof rowValue !== "object" ||
			Array.isArray(rowValue)
		) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_manifest_invalid",
				`rows[${index}] must be an object`,
			);
		}
		const row = rowValue as Record<string, unknown>;
		exactKeys(
			row,
			[
				"projectName",
				"leadId",
				"botUserId",
				"expectedLeadSha256",
				"cosContext",
			],
			`rows[${index}]`,
		);
		if (
			typeof row.projectName !== "string" ||
			typeof row.leadId !== "string" ||
			typeof row.botUserId !== "string" ||
			!/^\d{17,20}$/u.test(row.botUserId) ||
			typeof row.expectedLeadSha256 !== "string"
		) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_manifest_invalid",
				`rows[${index}] identity or digest is invalid`,
			);
		}
		if (!/^[a-f0-9]{64}$/u.test(row.expectedLeadSha256)) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_manifest_invalid",
				`rows[${index}].expectedLeadSha256 is invalid`,
			);
		}
		const key = `${row.projectName}/${row.leadId}`;
		if (targets.has(key)) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_manifest_invalid",
				`duplicate target ${key}`,
			);
		}
		targets.add(key);
		const project = projects.find(
			(candidateProject) => candidateProject.projectName === row.projectName,
		);
		const leads = project && Array.isArray(project.leads) ? project.leads : [];
		const lead = leads.find(
			(candidateLead) =>
				candidateLead !== null &&
				typeof candidateLead === "object" &&
				(candidateLead as Record<string, unknown>).agentId === row.leadId,
		) as Record<string, unknown> | undefined;
		if (!project || !lead) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_lead_missing",
				`central Lead ${key} does not exist`,
			);
		}
		if (lead.botUserId !== row.botUserId) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_identity_conflict",
				`${key} botUserId does not match central registry`,
			);
		}
		if (digestLeadRegistryRow(lead) !== row.expectedLeadSha256) {
			throw new LeadRegistryCoSContextError(
				"lead_registry_cos_context_preimage_stale",
				`${key} Lead row changed after import planning`,
			);
		}
		const context = validateContext(
			row.cosContext,
			String(project.projectRoot),
			`rows[${index}].cosContext`,
		);
		for (const name of [row.leadId, context.displayName, ...context.aliases]) {
			const alias = normalizedName(String(name));
			if (!alias)
				throw new LeadRegistryCoSContextError(
					"lead_registry_cos_context_manifest_invalid",
					`${key} contains an empty normalized alias`,
				);
			const owner = aliases.get(alias);
			if (owner && owner !== key) {
				throw new LeadRegistryCoSContextError(
					"lead_registry_cos_context_alias_ambiguous",
					`alias ${alias} is ambiguous between ${owner} and ${key}`,
				);
			}
			aliases.set(alias, key);
		}
		if (!isDeepStrictEqual(lead.cosContext, context)) {
			lead.cosContext = context;
			changed = true;
		}
	}
	compileLeadIdentityRows(candidate, { summarySelection: selection });
	const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
	const projection = compileSummaryAssignments(candidate, selection);
	return {
		kind: changed ? "update" : "continuation",
		candidateRegistry: candidate,
		candidateText,
		updatedLeadKeys: [...targets].sort(),
		planned: {
			projectsSha: sha256(candidateText),
			receiptDigest: projection.digest,
		},
	};
}
