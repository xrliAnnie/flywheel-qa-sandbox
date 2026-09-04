export interface LinearIssueStarterClient {
	issue(id: string): Promise<{
		startedAt?: Date | string | null;
		state?: Promise<
			| { id: string; name: string; type?: string; position?: number }
			| undefined
			| null
		>;
		team: Promise<
			| {
					states(): Promise<{
						nodes: Array<{
							id: string;
							name: string;
							type?: string;
							position?: number;
						}>;
					}>;
			  }
			| undefined
			| null
		>;
	}>;
	updateIssue(id: string, update: { stateId: string }): Promise<unknown>;
}

export interface MarkStartedResult {
	started: boolean;
	outcome: "started" | "skipped_terminal" | "skipped_triage" | "failed";
	reason?: string;
	errorClass?: string;
}

export type LinearIssueStarter = (
	issueId: string,
	issueIdentifier?: string,
	signal?: AbortSignal,
) => Promise<MarkStartedResult>;

function failed(errorClass: string, reason = errorClass): MarkStartedResult {
	return { started: false, outcome: "failed", reason, errorClass };
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("linear_start_aborted");
}

async function awaitUnlessAborted<T>(
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	assertNotAborted(signal);
	const result = await operation();
	assertNotAborted(signal);
	return result;
}

function settledStateResult(
	stateType: string | undefined,
	startedAt: Date | string | null | undefined,
): MarkStartedResult | undefined {
	if (stateType === "started") {
		return startedAt != null
			? { started: true, outcome: "started", reason: "already_started" }
			: {
					started: false,
					outcome: "failed",
					reason: "started_at_missing",
					errorClass: "started_at_missing",
				};
	}
	if (stateType === "triage") {
		return {
			started: false,
			outcome: "skipped_triage",
			reason: "issue_triage_never_overwritten",
		};
	}
	if (stateType === "canceled" || stateType === "completed") {
		return {
			started: false,
			outcome: "skipped_terminal",
			reason: `issue_${stateType}_never_overwritten`,
		};
	}
	return undefined;
}

async function attemptLinearIssueStarted(
	client: LinearIssueStarterClient,
	issueId: string,
	signal?: AbortSignal,
): Promise<MarkStartedResult> {
	const issue = await awaitUnlessAborted(() => client.issue(issueId), signal);
	const currentStatePromise = issue.state;
	const currentState = currentStatePromise
		? await awaitUnlessAborted(() => currentStatePromise, signal)
		: undefined;
	const currentResult = settledStateResult(currentState?.type, issue.startedAt);
	if (currentResult) return currentResult;
	if (!currentState?.id || !currentState.type)
		return failed("state_unreadable");
	if (!["backlog", "unstarted"].includes(currentState.type)) {
		return failed("state_not_startable");
	}
	const team = await awaitUnlessAborted(() => issue.team, signal);
	if (!team) return failed("no_team");
	const startedState = (
		await awaitUnlessAborted(() => team.states(), signal)
	).nodes
		.filter((state) => state.type === "started")
		.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))[0];
	if (!startedState) return failed("no_started_state");
	const freshIssue = await awaitUnlessAborted(
		() => client.issue(issueId),
		signal,
	);
	const freshStatePromise = freshIssue.state;
	const freshState = freshStatePromise
		? await awaitUnlessAborted(() => freshStatePromise, signal)
		: undefined;
	const freshResult = settledStateResult(
		freshState?.type,
		freshIssue.startedAt,
	);
	if (freshResult) return freshResult;
	if (!freshState?.id || !freshState.type) return failed("state_unreadable");
	if (
		freshState?.id !== currentState?.id ||
		freshState?.type !== currentState?.type
	) {
		return {
			started: false,
			outcome: "failed",
			reason: "state_changed_midflight",
			errorClass: "state_changed_midflight",
		};
	}
	await awaitUnlessAborted(
		() => client.updateIssue(issueId, { stateId: startedState.id }),
		signal,
	);
	const updated = await awaitUnlessAborted(() => client.issue(issueId), signal);
	const updatedStatePromise = updated.state;
	const updatedState = updatedStatePromise
		? await awaitUnlessAborted(() => updatedStatePromise, signal)
		: undefined;
	return updatedState?.type === "started" && updated.startedAt != null
		? { started: true, outcome: "started" }
		: failed("update_not_effective");
}

export async function markLinearIssueStarted(
	client: LinearIssueStarterClient,
	issueId: string,
	signal?: AbortSignal,
): Promise<MarkStartedResult> {
	try {
		return await attemptLinearIssueStarted(client, issueId, signal);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return failed(
			reason === "linear_start_aborted"
				? "linear_start_aborted"
				: error instanceof Error
					? error.constructor.name
					: "UnknownError",
			reason,
		);
	}
}

export function makeLinearIssueStarter(config: {
	linearApiKey?: string;
}): LinearIssueStarter | undefined {
	const apiKey = config.linearApiKey;
	if (!apiKey || process.env.FLYWHEEL_LINEAR_STARTED_SYNC === "0") {
		return undefined;
	}
	return async (issueId, issueIdentifier, signal) => {
		let result: MarkStartedResult;
		try {
			const { LinearClient } = await import("@linear/sdk");
			result = await markLinearIssueStarted(
				new LinearClient({ apiKey }) as unknown as LinearIssueStarterClient,
				issueId,
				signal,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result = failed(
				error instanceof Error ? error.constructor.name : "UnknownError",
				reason,
			);
		}
		const label = issueIdentifier ?? issueId;
		if (result.started) {
			console.log(`[linear-starter] ${label} → In Progress`);
		} else {
			console.warn(
				`[linear-starter] ${label} not moved to In Progress: ${result.reason ?? "unknown"}`,
			);
		}
		return result;
	};
}
