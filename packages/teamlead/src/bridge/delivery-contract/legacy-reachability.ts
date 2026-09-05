import { isWakeTerminalStatus } from "../../operational-terminal-status.js";
import type { StateStore } from "../../StateStore.js";

// FLY-2324: unowned delivery sources become legacy-unreachable after seven days.
// This is a safety invariant, not an operator-tunable policy.
export const LEGACY_UNREACHABLE_AFTER_MS = 7 * 24 * 60 * 60_000;

interface LegacyDeliveryReachabilityInput {
	recipientExecutionId?: string | null;
	fallbackRecipientStatus?: string | null;
	projectName: string;
	issueId: string;
	mintedAt: string;
	now: string;
	attemptId?: string;
	runId?: string;
}

interface IssueReachabilityFacts {
	protectedByRun: boolean;
	terminalAuthorized: boolean;
}

export class LegacyDeliveryReachabilityGuard {
	private readonly recipientStatuses = new Map<string, string | undefined>();
	private readonly issueFacts = new Map<string, IssueReachabilityFacts>();

	constructor(private readonly store: StateStore) {}

	isLegacyUnreachable(input: LegacyDeliveryReachabilityInput): boolean {
		const boundRun = input.runId
			? this.store.getWorkflowRun(input.runId)
			: input.attemptId
				? this.store.getWorkflowDeliveryAttemptRun(input.attemptId)
				: undefined;
		if (
			boundRun?.project_name === input.projectName &&
			(boundRun.status === "active" || boundRun.status === "held")
		) {
			return false;
		}

		const issueFacts = this.getIssueFacts(input.projectName, input.issueId);
		if (issueFacts.protectedByRun) return false;
		if (boundRun?.project_name === input.projectName) return true;

		const recipientStatus = input.recipientExecutionId
			? (this.getRecipientStatus(input.recipientExecutionId) ??
				input.fallbackRecipientStatus)
			: input.fallbackRecipientStatus;
		if (recipientStatus && isWakeTerminalStatus(recipientStatus)) {
			return true;
		}
		const mintedAtMs = Date.parse(input.mintedAt);
		const nowMs = Date.parse(input.now);
		const reachedLegacyAge =
			Number.isFinite(mintedAtMs) &&
			Number.isFinite(nowMs) &&
			nowMs - mintedAtMs >= LEGACY_UNREACHABLE_AFTER_MS;
		if (issueFacts.terminalAuthorized && !reachedLegacyAge) return false;
		return reachedLegacyAge;
	}

	private getRecipientStatus(executionId: string): string | undefined {
		if (!this.recipientStatuses.has(executionId)) {
			this.recipientStatuses.set(
				executionId,
				this.store.getSession(executionId)?.status,
			);
		}
		return this.recipientStatuses.get(executionId);
	}

	private getIssueFacts(
		projectName: string,
		issueId: string,
	): IssueReachabilityFacts {
		const cacheKey = `${projectName}\u0000${issueId}`;
		const cached = this.issueFacts.get(cacheKey);
		if (cached) return cached;

		const aliases = new Set([issueId]);
		for (const issueSession of this.store.getSessionsForIssueAliases([
			issueId,
		])) {
			if (issueSession.project_name !== projectName) continue;
			aliases.add(issueSession.issue_id);
			if (issueSession.issue_identifier) {
				aliases.add(issueSession.issue_identifier);
			}
		}
		const aliasList = [...aliases];
		const facts = {
			protectedByRun:
				this.store.getWorkflowDeliveryReachabilityRuns(projectName, aliasList)
					.length > 0,
			terminalAuthorized: aliasList.some((alias) => {
				const observation = this.store.getLinearStateObservation(
					projectName,
					alias,
				);
				return (
					observation?.terminalAuthorized === true &&
					(observation.lastStateType === "completed" ||
						observation.lastStateType === "canceled")
				);
			}),
		};
		this.issueFacts.set(cacheKey, facts);
		return facts;
	}
}
