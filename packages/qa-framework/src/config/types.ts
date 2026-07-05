import { z } from "zod";

/** Validates a path is repo-relative, non-empty, no absolute paths or traversal */
const repoRelativePath = z
	.string()
	.min(1)
	.refine(
		(p) =>
			!p.startsWith("/") &&
			!/^[a-zA-Z]:/.test(p) &&
			!p.split("/").includes(".."),
		{
			message:
				"Path must be repo-relative (no absolute paths, no '..' traversal)",
		},
	);

/** Step template — defines one step in an agent's execution flow */
export const StepTemplateSchema = z.object({
	key: z.string().min(1),
	name: z.string().min(1),
	order: z.number().int().positive(),
	prerequisite: z.string().nullable(),
});

/** Agent type — defines an agent and its step templates */
export const AgentTypeSchema = z.object({
	name: z
		.string()
		.min(1)
		.regex(
			/^[a-zA-Z][a-zA-Z0-9_-]*$/,
			"Agent type name must start with a letter and contain only alphanumeric, hyphens, or underscores",
		),
	step_templates: z.array(StepTemplateSchema).min(1),
});

/** Domain — a testable area of the project */
export const DomainSchema = z.object({
	name: z.string().min(1),
	dir: repoRelativePath,
	test_skill: z.string().min(1),
	config_file: repoRelativePath,
	cleanup_script: repoRelativePath.nullable().optional(),
});

/** Plan source configuration — how QA agent obtains plan files */
export const PlanSourceSchema = z.object({
	source: z.enum(["worktree", "branch_fetch"]).default("worktree"),
	fetch_strategy: z
		.enum(["checkout_file", "copy_from_root"])
		.default("checkout_file"),
});

/** API configuration */
export const ApiConfigSchema = z.object({
	openapi_spec: repoRelativePath.nullable().optional(),
	base_url: z.string().optional(),
});

/** Orchestrator configuration */
export const OrchestratorSchema = z
	.object({
		db_path: z.string(),
		max_concurrent_agents: z.number().int().positive().default(2),
		artifact_retention_days: z.number().int().positive().default(30),
		agent_types: z.array(AgentTypeSchema).min(1),
	})
	.refine(
		(o) => {
			// Ensure agent type names don't collide when normalized for env vars
			const normalized = o.agent_types.map((at) =>
				at.name.replace(/[^a-zA-Z0-9]/g, "_"),
			);
			return new Set(normalized).size === normalized.length;
		},
		{
			message:
				"Agent type names must be unique after normalization (e.g., 'qa-parallel' and 'qa_parallel' would collide)",
		},
	);

/** Version configuration */
export const VersionSchema = z.object({
	file: repoRelativePath,
});

/** Full QA config schema */
export const QaConfigSchema = z.object({
	project: z.object({
		name: z.string().min(1),
		description: z.string(),
	}),
	qa: z.object({
		doc_root: repoRelativePath,
		test_report_dir: repoRelativePath,
		context_file: repoRelativePath.optional(),
	}),
	plan: PlanSourceSchema.optional(),
	domains: z.array(DomainSchema).min(1),
	api: ApiConfigSchema.optional(),
	orchestrator: OrchestratorSchema,
	version: VersionSchema.optional(),
	env_refs: z.record(z.string(), z.string()).optional(),
});

export type StepTemplate = z.infer<typeof StepTemplateSchema>;
export type AgentType = z.infer<typeof AgentTypeSchema>;
export type Domain = z.infer<typeof DomainSchema>;
export type PlanSource = z.infer<typeof PlanSourceSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorSchema>;
export type QaConfig = z.infer<typeof QaConfigSchema>;
