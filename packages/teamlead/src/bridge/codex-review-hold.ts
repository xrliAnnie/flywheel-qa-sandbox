import type { Session, StateStore } from "../StateStore.js";
import { isCodexGateSatisfied } from "./codex-gate.js";

const FULL_SHA = /^[0-9a-f]{40}$/;

export type CodexReviewReadiness = "ready" | "held" | "ignored";

export interface CodexReviewHoldDeps {
	store: StateStore;
	queueCodexInstruction(args: { session: Session }): Promise<unknown> | unknown;
	alertMissingHead(args: { session: Session }): Promise<void> | void;
	logger?: { log(message: string): void; warn(message: string): void };
}

/**
 * Neutral exact-head Codex review hold. It owns no QA policy, record, or spawn
 * dependency: completion callers can invoke it before any downstream workflow.
 */
export class CodexReviewHoldCoordinator {
	constructor(private readonly deps: CodexReviewHoldDeps) {}

	private log(message: string): void {
		this.deps.logger?.log?.(`[codex-review-hold] ${message}`);
	}

	private warn(message: string): void {
		(this.deps.logger?.warn ?? this.deps.logger?.log)?.(
			`[codex-review-hold] ${message}`,
		);
	}

	async onSessionAwaitingReview(
		sessionInput: Session,
	): Promise<CodexReviewReadiness> {
		const session = this.deps.store.getSession(sessionInput.execution_id);
		if (!session || (session.session_role ?? "main") !== "main")
			return "ignored";
		if (session.status !== "awaiting_review" || session.merge_block_reason) {
			return "ignored";
		}
		if (session.codex_skip) return "ready";
		const sha = session.pr_head_sha?.toLowerCase();
		if (!sha || !FULL_SHA.test(sha)) {
			this.warn(
				`missing exact PR head for ${session.issue_id} (${session.execution_id})`,
			);
			await this.deps.alertMissingHead({ session });
			return "held";
		}
		if (isCodexGateSatisfied(this.deps.store, session, sha)) return "ready";
		await this.codexHold(session, sha);
		return "held";
	}

	private async codexHold(session: Session, sha: string): Promise<void> {
		const firstNotify = this.deps.store.claimCodexHoldNotify({
			executionId: session.execution_id,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
		});
		if (!firstNotify) {
			this.log(
				`${session.issue_id} @ ${sha.slice(0, 8)} already notified; duplicate suppressed`,
			);
			return;
		}
		try {
			await this.deps.queueCodexInstruction({ session });
		} catch (error) {
			this.warn(
				`instruction queue failed for ${session.issue_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async reconcileCodexHolds(): Promise<void> {
		for (const session of this.deps.store.getActiveSessions()) {
			if ((session.session_role ?? "main") !== "main") continue;
			if (session.status !== "awaiting_review") continue;
			if (session.codex_skip || session.merge_block_reason) continue;
			const sha = session.pr_head_sha?.toLowerCase();
			if (!sha || !FULL_SHA.test(sha)) {
				try {
					await this.deps.alertMissingHead({ session });
				} catch (error) {
					this.warn(
						`missing-head alert failed for ${session.issue_id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				continue;
			}
			if (isCodexGateSatisfied(this.deps.store, session, sha)) continue;
			await this.codexHold(session, sha);
		}
	}
}
