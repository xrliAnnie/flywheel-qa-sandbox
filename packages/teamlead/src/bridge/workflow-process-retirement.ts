export const DEFAULT_WORKFLOW_PROCESS_RETIREMENT_GRACE_MS = 60_000;

export interface WorkflowProcessRetirementCandidate {
	executionId: string;
	generation: number;
	issueId: string;
	projectName: string;
	vendor: "claude" | "codex";
	retirementRequestedAt: string;
}

export interface WorkflowProcessRetirementStore {
	listWorkflowExecutionRetirementWork(input: {
		dueBefore: string;
		limit: number;
	}): WorkflowProcessRetirementCandidate[];
	getWorkflowExecutionProcessBody(executionId: string):
		| {
				generation: number;
				state: string;
				retirement_requested_at: string | null;
		  }
		| undefined;
	confirmWorkflowExecutionStandby(input: {
		executionId: string;
		generation: number;
		reasonCode: string;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
	failWorkflowExecutionRetirement(input: {
		executionId: string;
		generation: number;
		reasonCode: "retirement_unconfirmed";
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
}

export interface WorkflowProcessRetirementResult {
	physicalGone: boolean;
	failureConfirmed?: boolean;
	error?: string;
}

export function isWorkflowProcessRetirementApproved(
	body:
		| {
				generation: number;
				state: string;
		  }
		| undefined,
	generation: number,
): boolean {
	return (
		body?.generation === generation &&
		(body.state === "retiring" || body.state === "standby")
	);
}

export async function runWorkflowProcessRetirementTick(input: {
	store: WorkflowProcessRetirementStore;
	retireProcess: (
		candidate: WorkflowProcessRetirementCandidate,
	) => Promise<WorkflowProcessRetirementResult>;
	now: string;
	graceMs?: number;
	limit?: number;
	log?: (message: string) => void;
}): Promise<{ processed: number; standby: number; failed: number }> {
	const graceMs = input.graceMs ?? DEFAULT_WORKFLOW_PROCESS_RETIREMENT_GRACE_MS;
	const dueBefore = new Date(Date.parse(input.now) - graceMs).toISOString();
	const candidates = input.store.listWorkflowExecutionRetirementWork({
		dueBefore,
		limit: input.limit ?? 3,
	});
	let standby = 0;
	let failed = 0;
	for (const candidate of candidates) {
		let result: WorkflowProcessRetirementResult;
		try {
			result = await input.retireProcess(candidate);
		} catch (error) {
			result = {
				physicalGone: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const current = input.store.getWorkflowExecutionProcessBody(
			candidate.executionId,
		);
		if (
			current?.generation !== candidate.generation ||
			current.state !== "retiring" ||
			current.retirement_requested_at !== candidate.retirementRequestedAt
		) {
			continue;
		}
		if (result.physicalGone) {
			const settled = input.store.confirmWorkflowExecutionStandby({
				executionId: candidate.executionId,
				generation: candidate.generation,
				reasonCode: "process_tree_gone",
				now: input.now,
			});
			if (settled.ok) standby += 1;
			else {
				input.log?.(
					`[workflow-process-retirement] standby confirmation refused for ${candidate.executionId}: ${settled.reason}`,
				);
			}
			continue;
		}
		if (result.failureConfirmed) {
			const latched = input.store.failWorkflowExecutionRetirement({
				executionId: candidate.executionId,
				generation: candidate.generation,
				reasonCode: "retirement_unconfirmed",
				now: input.now,
			});
			if (latched.ok) failed += 1;
			else {
				input.log?.(
					`[workflow-process-retirement] failure latch refused for ${candidate.executionId}: ${latched.reason}`,
				);
			}
		}
		if (result.error) {
			input.log?.(
				`[workflow-process-retirement] physical cleanup ${result.failureConfirmed ? "failed" : "unconfirmed"} for ${candidate.executionId}: ${result.error}`,
			);
		}
	}
	return { processed: candidates.length, standby, failed };
}
