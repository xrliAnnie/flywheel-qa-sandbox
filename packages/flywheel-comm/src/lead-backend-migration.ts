import { createHash } from "node:crypto";
import {
	resolveCodexLeadCapabilities,
	resolveGenericCodexProfile,
} from "flywheel-config";

const FIELDS = [
	"backend",
	"codexProfile",
	"model",
	"effort",
	"canSpawnRunners",
	"codexRunnerActions",
] as const;
type MigrationFields = {
	backend?: string;
	codexProfile?: string;
	model?: string;
	effort?: string;
	canSpawnRunners?: boolean;
	codexRunnerActions?: boolean;
};
export interface BackendMigrationPlan {
	version: 1;
	migrationId: "FLY-2459-honey-lemon";
	issue: "FLY-2459";
	projectName: "flywheel";
	leadId: "flywheel-product-lead";
	deploymentSha: string;
	createdAt: string;
	phase: "prepared";
	expected: {
		rowSha: string;
		projectSha: string;
		manifestSha: string;
		plistSha: string;
	};
	previous: MigrationFields;
	target: MigrationFields;
}
export interface BackendMigrationPlanInput {
	registry: unknown;
	projectName: string;
	leadId: string;
	toBackend: string;
	model: string;
	effort: string;
	runnerActions: boolean;
	codexProfile?: string;
	deploymentSha: string;
	manifestSha: string;
	plistSha: string;
	createdAt: string;
}
function fail(reason: string): never {
	throw new Error(`lead_backend_migration: ${reason}`);
}
function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return fail("invalid registry object");
	return value as Record<string, unknown>;
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
function selected(registry: unknown): {
	project: Record<string, unknown>;
	lead: Record<string, unknown>;
} {
	const rows = Array.isArray(registry) ? registry : object(registry).projects;
	if (!Array.isArray(rows)) return fail("invalid projects");
	const projects = rows.map(object).filter((p) => p.projectName === "flywheel");
	if (projects.length !== 1) return fail("expected exactly one project");
	const project = projects[0]!;
	if (!Array.isArray(project.leads)) return fail("invalid leads");
	const leads = project.leads
		.map(object)
		.filter((l) => l.agentId === "flywheel-product-lead");
	if (leads.length !== 1) return fail("expected exactly one Lead");
	return { project, lead: leads[0]! };
}
function projectDigest(project: Record<string, unknown>): string {
	const { leads: _, ...context } = project;
	return digest(context);
}
function previousFields(lead: Record<string, unknown>): MigrationFields {
	const result: MigrationFields = {};
	for (const field of FIELDS) {
		const value = lead[field];
		if (value === undefined) continue;
		if (field === "canSpawnRunners" || field === "codexRunnerActions") {
			if (typeof value !== "boolean") return fail("invalid boolean preimage");
		} else if (
			typeof value !== "string" ||
			!/^[a-zA-Z0-9_.[\]-]{1,128}$/.test(value)
		)
			return fail("invalid field preimage");
		(result as Record<string, string | boolean>)[field] = value as
			| string
			| boolean;
	}
	return result;
}
/** Pure planning: no registry write, credential read, service call or restart authorization. */
export function planBackendMigration(
	input: BackendMigrationPlanInput,
): BackendMigrationPlan {
	if (
		input.projectName !== "flywheel" ||
		input.leadId !== "flywheel-product-lead" ||
		input.toBackend !== "codex-app-server" ||
		input.model !== "gpt-6-astra" ||
		input.effort !== "high" ||
		input.runnerActions !== true
	)
		return fail("unsupported migration target");
	const codexProfile = resolveGenericCodexProfile(input.codexProfile);
	if (
		!/^[a-f0-9]{40}$/.test(input.deploymentSha) ||
		!(
			/^[a-f0-9]{64}$/.test(input.manifestSha) &&
			/^[a-f0-9]{64}$/.test(input.plistSha)
		)
	)
		return fail("invalid expected artifact hash");
	if (
		!/^\d{4}-\d{2}-\d{2}T/.test(input.createdAt) ||
		!Number.isFinite(Date.parse(input.createdAt))
	)
		return fail("invalid creation time");
	const { project, lead } = selected(input.registry);
	if (lead.backend !== undefined && lead.backend !== "claude-code")
		return fail("source must be Claude");
	if (lead.canSpawnRunners !== true)
		return fail("explicit source runner permission required");
	const target: MigrationFields = {
		backend: "codex-app-server",
		codexProfile,
		model: input.model,
		effort: input.effort,
		canSpawnRunners: true,
		codexRunnerActions: true,
	};
	const capability = resolveCodexLeadCapabilities({ ...lead, ...target });
	if (!capability.runnerActionsEnabled) return fail("source is not eligible");
	return {
		version: 1,
		migrationId: "FLY-2459-honey-lemon",
		issue: "FLY-2459",
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		deploymentSha: input.deploymentSha,
		createdAt: input.createdAt,
		phase: "prepared",
		expected: {
			rowSha: digest(lead),
			projectSha: projectDigest(project),
			manifestSha: input.manifestSha,
			plistSha: input.plistSha,
		},
		previous: previousFields(lead),
		target,
	};
}
/** Pure target-row CAS; the authorized writer must supply a fresh registry under cfglock. */
export function applyMigrationFields<T>(
	registry: T,
	plan: BackendMigrationPlan,
): T {
	const candidate = structuredClone(registry);
	const { project, lead } = selected(candidate);
	if (projectDigest(project) !== plan.expected.projectSha)
		return fail("stale project context");
	if (digest(lead) !== plan.expected.rowSha) {
		const original = { ...lead };
		for (const field of FIELDS) delete original[field];
		Object.assign(original, plan.previous);
		if (
			digest(original) !== plan.expected.rowSha ||
			digest(previousFields(lead)) !== digest(plan.target)
		)
			return fail("stale target row");
		return candidate;
	}
	for (const field of FIELDS) delete lead[field];
	Object.assign(lead, plan.target);
	return candidate;
}

/** Field-only rollback. Service/cursor reconciliation remains the authorized executor's prerequisite. */
export function rollbackMigrationFields<T>(
	registry: T,
	plan: BackendMigrationPlan,
): T {
	const candidate = structuredClone(registry);
	const { project, lead } = selected(candidate);
	if (projectDigest(project) !== plan.expected.projectSha)
		return fail("stale project context");
	if (digest(lead) === plan.expected.rowSha) return candidate;
	// This checks both the complete original row and the exact current postimage.
	applyMigrationFields(candidate, plan);
	for (const field of FIELDS) delete lead[field];
	Object.assign(lead, plan.previous);
	return candidate;
}
