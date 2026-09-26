import type { RoleEffort } from "flywheel-config";
import type {
	AdapterExecutionContext,
	LaunchPrecommitOutcome,
} from "flywheel-core";
import type { StartRequest } from "./retry-dispatcher.js";

type LaunchFailureOutcome = Extract<
	LaunchPrecommitOutcome,
	{ status: "precommit_failed" }
>;

/**
 * A committed launch is the prerequisite for Claude's observed SessionStart,
 * not a failed identity verdict. Only a proven pre-commit failure may win the
 * resume identity race.
 */
export function observeWorkflowResumeLaunchFailure(
	launchOutcome: Promise<LaunchPrecommitOutcome> | undefined,
): Promise<{ kind: "launch"; outcome: LaunchFailureOutcome }> | undefined {
	if (!launchOutcome) return undefined;
	return launchOutcome.then((outcome) =>
		outcome.status === "committed"
			? new Promise<never>(() => {})
			: { kind: "launch" as const, outcome },
	);
}

type ProcessLifecycle = NonNullable<
	AdapterExecutionContext["processLifecycle"]
>;

/**
 * FLY-2808: the Lead a body was registered with at its original launch. A
 * resume must reproduce it exactly — it drives the runner's CommDB root and
 * Lead mailbox identity, both frozen into the launch snapshot.
 */
export function frozenLaunchLeadId(
	db: {
		getSession(executionId: string): { lead_id: string | null } | undefined;
	},
	executionId: string,
): string | undefined {
	const leadId = db.getSession(executionId)?.lead_id?.trim();
	return leadId ? leadId : undefined;
}

/** FLY-2808: the exact-session relaunch of one standby workflow body. */
export function buildStandbyResumeStartRequest(input: {
	session: {
		execution_id: string;
		issue_id: string;
		project_name?: string | null;
		issue_identifier?: string | null;
		issue_title?: string | null;
		chat_thread_role?: string | null;
		session_role?: string | null;
	};
	runProjectName: string;
	runtime: {
		vendor: string;
		model: string;
		effort: string | null;
		node_id: string;
	};
	leadId: string | undefined;
	expectedSessionId: string;
	expectedCwd: string;
	currentHead: string;
	lifecycle: Omit<
		ProcessLifecycle,
		"mode" | "nodeId" | "expectedSessionId" | "expectedModel" | "expectedCwd"
	>;
}): StartRequest {
	const { session, runtime } = input;
	return {
		issueId: session.issue_id,
		projectName: session.project_name ?? input.runProjectName,
		successorExecutionId: session.execution_id,
		...(input.leadId ? { leadId: input.leadId } : {}),
		...(session.issue_identifier
			? { issueIdentifier: session.issue_identifier }
			: {}),
		...(session.issue_title ? { issueTitle: session.issue_title } : {}),
		sessionRole:
			session.chat_thread_role ?? session.session_role ?? runtime.node_id,
		shareParentBranch: true,
		startPoint: input.currentHead,
		ignoreRunnerLabelSelection: true,
		observeLaunchOutcome: true,
		dispatchVendor: runtime.vendor as "claude" | "codex",
		dispatchModel: runtime.model,
		...(runtime.effort ? { dispatchEffort: runtime.effort as RoleEffort } : {}),
		previousSession:
			runtime.vendor === "codex"
				? { threadId: input.expectedSessionId }
				: {
						sessionId: input.expectedSessionId,
						vendor: "claude",
						resolvedModel: runtime.model,
						cwd: input.expectedCwd,
					},
		processLifecycle: {
			...input.lifecycle,
			mode: "resume",
			nodeId: runtime.node_id,
			expectedSessionId: input.expectedSessionId,
			expectedModel: runtime.model,
			expectedCwd: input.expectedCwd,
		},
	};
}
