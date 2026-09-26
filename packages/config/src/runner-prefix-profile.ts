/** FLY-2913: selection only; no files, settings, permissions or launch side effects.
 * Callers must obtain workflow and phase from the server's pinned run snapshot,
 * and reviewType from the persisted review job. This is not an API input parser.
 * The mode comes only from the node declaration sealed into the run snapshot.
 * Global settings and the current template pointer never select an existing run.
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
	templateRevision: number;
}

/** Server-derived source identity; never accepted from an HTTP start payload. */
export interface RunnerPrefixContext {
	workflow: RunnerPrefixWorkflow;
	nodeId: string;
	phase: "design" | "implement" | "qa";
	prefixProfile?: RunnerPrefixMode;
	reviewPrefixProfile?: RunnerPrefixMode;
	agent: { content: string; digest: string } | null;
}
/** Secret-free selection metadata, forwarded separately from effective settings. */
export interface RunnerPrefixAudit {
	workflow: RunnerPrefixWorkflow | null;
	nodeId: string | null;
	selectionSource:
		| "prefix_profile"
		| "review_prefix_profile"
		| "historical-session";
	requestedProfile: RunnerPrefixMode;
	effectiveProfile: RunnerPrefixMode;
	fallbackReason: string | null;
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
	/** Independent runner/reviewer declaration from the pinned manifest node. */
	profile?: RunnerPrefixMode;
}

export type RunnerPrefixSelection =
	| {
			mode: "legacy";
			reason:
				| "not-applicable"
				| "node-legacy"
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

// Missing historical declarations retain the original settings.
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
	const mode = isRunnerPrefixProfile(args.profile)
		? args.profile
		: DEFAULT_MODE;
	if (mode === "legacy") return { mode, reason: "node-legacy" };
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
		!/^[a-f0-9]{64}$/.test(workflow.snapshotDigest) ||
		!Number.isSafeInteger(workflow.templateRevision) ||
		workflow.templateRevision < 1
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
			templateRevision: workflow.templateRevision,
		},
	};
}
