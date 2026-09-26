/** FLY-2913: selection only; no files, settings, permissions or launch side effects.
 * Callers must obtain workflow and phase from the server's pinned run snapshot,
 * and reviewType from the persisted review job. This is not an API input parser.
 * The mode comes only from the store-managed `runner_prefix_profile` row read at
 * each new launch; the registry env name is bootstrap metadata, never read here.
 */
export type RunnerPrefixRole =
	| "design"
	| "implement"
	| "qa"
	| "review-design"
	| "review-code";
export const RUNNER_PREFIX_PROFILES = ["legacy", "role-v1"] as const;
export type RunnerPrefixMode = (typeof RUNNER_PREFIX_PROFILES)[number];

export function isRunnerPrefixProfile(
	value: unknown,
): value is RunnerPrefixMode {
	return (
		typeof value === "string" &&
		(RUNNER_PREFIX_PROFILES as readonly string[]).includes(value)
	);
}

export interface RunnerPrefixWorkflow {
	runId: string;
	snapshotDigest: string;
	templateId: string;
}

/** Server-derived source identity; never accepted from an HTTP start payload. */
export interface RunnerPrefixContext {
	workflow: RunnerPrefixWorkflow;
	nodeId: string;
	phase: "design" | "implement" | "qa";
	agent: { content: string; digest: string } | null;
}
export interface RunnerPrefixRequest {
	selection: Extract<RunnerPrefixSelection, { mode: "role-v1" }>;
	context: RunnerPrefixContext;
}

export interface ResolveRunnerPrefixSelectionArgs {
	actor: "runner" | "reviewer" | "lead";
	backend: string;
	phase?: string;
	reviewType?: string;
	workflow?: RunnerPrefixWorkflow;
	issueLabels?: readonly string[];
	/** Raw `runner_prefix_profile` store row; absent/unset/unsupported ⇒ legacy. */
	profile?: { hasOverride: boolean; raw: string | null };
}

export type RunnerPrefixSelection =
	| {
			mode: "legacy";
			reason:
				| "not-applicable"
				| "operator-legacy"
				| "unmapped-trigger"
				| "unknown-role"
				| "full-mcp";
	  }
	| {
			mode: "role-v1";
			role: RunnerPrefixRole;
			taskSetId: "engineering";
			workflow: RunnerPrefixWorkflow;
	  };

// Legacy is both the default and the only fallback; role-v1 is enabled only by
// the managed feature-flags command (Lead ruling, 2026-09-26).
const DEFAULT_MODE: RunnerPrefixMode = "legacy";

export function resolveRunnerPrefixSelection(
	args: ResolveRunnerPrefixSelectionArgs,
): RunnerPrefixSelection {
	if (
		args.actor === "lead" ||
		(args.actor === "runner" && args.backend !== "claude-tmux") ||
		(args.actor === "reviewer" && args.backend !== "claude-print")
	) {
		return { mode: "legacy", reason: "not-applicable" };
	}
	const mode =
		args.profile?.hasOverride && isRunnerPrefixProfile(args.profile.raw)
			? args.profile.raw
			: DEFAULT_MODE;
	if (mode === "legacy") return { mode, reason: "operator-legacy" };
	if (args.issueLabels?.some((label) => label.toLowerCase() === "full-mcp")) {
		return { mode: "legacy", reason: "full-mcp" };
	}
	const workflow = args.workflow;
	if (
		!workflow ||
		!["tpl_code", "tpl_simple_code"].includes(workflow.templateId)
	) {
		return { mode: "legacy", reason: "unmapped-trigger" };
	}
	if (
		!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(workflow.runId) ||
		!/^[a-f0-9]{64}$/.test(workflow.snapshotDigest)
	) {
		throw new Error("runner prefix requires a valid pinned workflow identity");
	}
	let role: RunnerPrefixRole | undefined;
	if (args.actor === "reviewer") {
		if (args.reviewType === "design") role = "review-design";
		if (args.reviewType === "code") role = "review-code";
	} else if (
		args.phase === "design" ||
		args.phase === "implement" ||
		args.phase === "qa"
	) {
		role = args.phase;
	}
	if (!role) return { mode: "legacy", reason: "unknown-role" };
	return {
		mode,
		role,
		taskSetId: "engineering",
		workflow: {
			runId: workflow.runId,
			snapshotDigest: workflow.snapshotDigest,
			templateId: workflow.templateId,
		},
	};
}
