/** FLY-2913: selection only; no files, settings, permissions or launch side effects.
 * Callers must obtain workflow and phase from the server's pinned run snapshot,
 * and reviewType from the persisted review job. This is not an API input parser.
 */
export type RunnerPrefixRole =
	| "design"
	| "implement"
	| "qa"
	| "review-design"
	| "review-code";
export type RunnerPrefixMode = "legacy" | "role-v1";

export interface RunnerPrefixWorkflow {
	runId: string;
	snapshotDigest: string;
	templateId: string;
}

export interface ResolveRunnerPrefixSelectionArgs {
	actor: "runner" | "reviewer" | "lead";
	backend: string;
	phase?: string;
	reviewType?: string;
	workflow?: RunnerPrefixWorkflow;
	issueLabels?: readonly string[];
	env?: NodeJS.ProcessEnv;
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

// Development remains opt-in until the five real-role acceptance runs pass.
// The consumer integration/default-enable step is a later task in the plan.
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
		(args.env ?? process.env).FLYWHEEL_RUNNER_PREFIX_PROFILE ?? DEFAULT_MODE;
	if (mode !== "legacy" && mode !== "role-v1") {
		throw new Error("FLYWHEEL_RUNNER_PREFIX_PROFILE must be legacy or role-v1");
	}
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
