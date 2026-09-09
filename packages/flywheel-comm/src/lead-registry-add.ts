import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compileLeadIdentityRows, type SummaryRole } from "./lead-identity.js";
import { compileSummaryAssignments } from "./summary-assignment.js";
import type { SummaryGranularitySelection } from "./summary-config.js";
import type { SummaryMigrationReceipt } from "./summary-registry-migration.js";

export type LeadRegistryAddErrorCode =
	| "lead_registry_granularity_unsupported"
	| "lead_registry_preimage_stale"
	| "lead_registry_lead_exists"
	| "lead_registry_project_root_conflict"
	| "lead_registry_project_options_conflict";

export class LeadRegistryAddError extends Error {
	constructor(
		readonly code: LeadRegistryAddErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadRegistryAddError";
	}
}

export interface LeadRegistryAddInput {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
	generalChannel?: string;
	memoryAllowedUsers?: string[];
	leadId: string;
	chatChannel: string;
	botTokenEnv: string;
	botUserId: string;
	harness: "claude" | "codex";
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	modelContextWindow?: number;
	summaryRole?: Exclude<SummaryRole, "aggregator">;
	labels?: string[];
	canSpawnRunners?: boolean;
}

export interface LeadRunManifest {
	leadId: string;
	projectDir: string;
	projectName: string;
	subdir: "";
	workspace: string;
	mcpExclude: "";
	model?: string;
	leadBackend: { backendId: "claude-code" | "codex-app-server" };
}

export interface LeadRegistryAddPlan {
	kind: "add" | "continuation";
	candidateRegistry: unknown;
	candidateText: string;
	manifest: LeadRunManifest;
	leadKey: string;
	planned: { projectsSha: string; receiptDigest: string };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function registryProjects(registry: unknown): Array<Record<string, unknown>> {
	const candidate =
		registry !== null &&
		typeof registry === "object" &&
		!Array.isArray(registry) &&
		"projects" in registry
			? (registry as { projects: unknown }).projects
			: registry;
	if (!Array.isArray(candidate)) {
		throw new LeadRegistryAddError(
			"lead_registry_preimage_stale",
			"projects registry must be an array or {projects: array}",
		);
	}
	return candidate as Array<Record<string, unknown>>;
}

function leadRow(input: LeadRegistryAddInput): Record<string, unknown> {
	const backend =
		input.harness === "codex" ? "codex-app-server" : "claude-code";
	return {
		agentId: input.leadId,
		summaryRole: input.summaryRole ?? "recipient",
		chatChannel: input.chatChannel,
		match: { labels: input.labels ?? [input.leadId] },
		botTokenEnv: input.botTokenEnv,
		botUserId: input.botUserId,
		canSpawnRunners: input.canSpawnRunners ?? false,
		backend,
		...(input.harness === "claude" ? { carrier: "v2" } : {}),
		...(input.harness === "codex" ? { codexProfile: "full-access" } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		...(input.effort !== undefined ? { effort: input.effort } : {}),
		...(input.modelContextWindow !== undefined
			? { modelContextWindow: input.modelContextWindow }
			: {}),
	};
}

function manifestFor(input: LeadRegistryAddInput): LeadRunManifest {
	return {
		leadId: input.leadId,
		projectDir: input.projectRoot,
		projectName: input.projectName,
		subdir: "",
		workspace: input.projectRoot,
		mcpExclude: "",
		...(input.model !== undefined ? { model: input.model } : {}),
		leadBackend: {
			backendId: input.harness === "codex" ? "codex-app-server" : "claude-code",
		},
	};
}

function differingFields(
	actual: Record<string, unknown>,
	expected: Record<string, unknown>,
): string[] {
	return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
		.filter((key) => !isDeepStrictEqual(actual[key], expected[key]))
		.sort();
}

function conflictingProvidedProjectOptions(
	project: Record<string, unknown>,
	input: LeadRegistryAddInput,
): string[] {
	const provided: Array<[string, unknown]> = [
		["projectRepo", input.projectRepo],
		["generalChannel", input.generalChannel],
		["memoryAllowedUsers", input.memoryAllowedUsers],
	];
	return provided
		.filter(
			([field, value]) =>
				value !== undefined && !isDeepStrictEqual(project[field], value),
		)
		.map(([field]) => field);
}

function verifyPreimage(
	registry: unknown,
	receipt: SummaryMigrationReceipt,
	selection: SummaryGranularitySelection,
): void {
	if (selection.state !== "selected" || selection.granularity !== "per-lead") {
		throw new LeadRegistryAddError(
			"lead_registry_granularity_unsupported",
			"lead registration requires summary granularity per-lead",
		);
	}
	const projection = compileSummaryAssignments(registry, selection);
	if (
		receipt.granularity !== "per-lead" ||
		receipt.summaryAssignmentDigest !== projection.digest
	) {
		throw new LeadRegistryAddError(
			"lead_registry_preimage_stale",
			"projects registry does not match the active summary migration receipt",
		);
	}
}

export function planLeadRegistryAdd(
	registry: unknown,
	receipt: SummaryMigrationReceipt,
	selection: SummaryGranularitySelection,
	input: LeadRegistryAddInput,
): LeadRegistryAddPlan {
	verifyPreimage(registry, receipt, selection);
	const candidateRegistry = structuredClone(registry);
	const projects = registryProjects(candidateRegistry);
	const desiredLead = leadRow(input);
	let kind: "add" | "continuation" = "add";
	let target = projects.find(
		(project) => project.projectName === input.projectName,
	);
	if (target !== undefined) {
		if (target.projectRoot !== input.projectRoot) {
			throw new LeadRegistryAddError(
				"lead_registry_project_root_conflict",
				`project ${input.projectName} already uses projectRoot ${String(target.projectRoot)}`,
			);
		}
		const conflictingOptions = conflictingProvidedProjectOptions(target, input);
		if (conflictingOptions.length > 0) {
			throw new LeadRegistryAddError(
				"lead_registry_project_options_conflict",
				`project ${input.projectName} already has different project-level fields: ${conflictingOptions.join(", ")}`,
			);
		}
	}

	for (const project of projects) {
		const leads = Array.isArray(project.leads) ? project.leads : [];
		const existing = leads.find(
			(lead) =>
				lead !== null &&
				typeof lead === "object" &&
				(lead as Record<string, unknown>).agentId === input.leadId,
		) as Record<string, unknown> | undefined;
		if (existing === undefined) continue;
		if (project === target && isDeepStrictEqual(existing, desiredLead)) {
			kind = "continuation";
			break;
		}
		throw new LeadRegistryAddError(
			"lead_registry_lead_exists",
			`Lead ${input.leadId} is already registered with different fields: ${differingFields(existing, desiredLead).join(", ") || "projectName"}`,
		);
	}

	if (kind === "add") {
		if (target !== undefined) {
			(target.leads as unknown[]).push(desiredLead);
		} else {
			target = {
				projectName: input.projectName,
				projectRoot: input.projectRoot,
				...(input.projectRepo !== undefined
					? { projectRepo: input.projectRepo }
					: {}),
				...(input.generalChannel !== undefined
					? { generalChannel: input.generalChannel }
					: {}),
				...(input.memoryAllowedUsers !== undefined
					? { memoryAllowedUsers: input.memoryAllowedUsers }
					: {}),
				leads: [desiredLead],
			};
			projects.push(target);
		}
	}

	compileLeadIdentityRows(candidateRegistry, { summarySelection: selection });
	const candidateText = `${JSON.stringify(candidateRegistry, null, 2)}\n`;
	const projection = compileSummaryAssignments(candidateRegistry, selection);
	return {
		kind,
		candidateRegistry,
		candidateText,
		manifest: manifestFor(input),
		leadKey: `${input.projectName}-${input.leadId}`,
		planned: {
			projectsSha: sha256(candidateText),
			receiptDigest: projection.digest,
		},
	};
}
