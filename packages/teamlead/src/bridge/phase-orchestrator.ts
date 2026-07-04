/**
 * FLY-793 Steps 4+7: the three-stage PhaseOrchestrator.
 *
 * A three-stage run is ONE Linear issue with internal Design → Implement → QA
 * phase-sessions sharing ONE git branch B. When a phase-session completes at a
 * handoff boundary, this coordinator runs the file-based, restart-safe handoff:
 *
 *   1. capture the previous phase's exact head SHA (git rev-parse in its
 *      worktree) BEFORE any cleanup — the durable handoff point;
 *   2. close the previous phase runner / worktree (dirty-safe);
 *   3. start the NEXT phase-session on the SAME issue + SAME branch B
 *      (`shareParentBranch: true`, `startPoint` = the captured SHA), with the
 *      next phase's model.
 *
 * Any failure is FAIL-CLOSED: the next phase is NOT started and the Lead is
 * alerted (never silently strand a completed phase). Mirrors AutoQaCoordinator's
 * deps-injected, `{ current }`-boxed shape so both event sinks can drive it.
 *
 * Boundaries handled here:
 *   - Design done  (status `design_done`, role `design`)      → start Implement.
 *   - Implement PR (status `awaiting_review`, role `implement`) → start QA.
 * The QA phase's PASS/FAIL fix-loop is the internal-QA path (Step 8).
 *
 * Byte-compat: only fires when the session is a three-stage phase
 * (`resolveThreeStage(session).enabled` AND a phase role). Non-three-stage
 * sessions are ignored entirely — the single-session pipeline is unchanged.
 */

import {
	isThreeStagePhaseRole,
	nextPhase,
	resolvePhaseModel,
	type ThreeStagePhase,
} from "flywheel-config";

/**
 * Minimal session shape this coordinator needs (subset of StateStore Session).
 *
 * NOTE (FLY-793 combined-QA finding, FLY-855): there is deliberately NO
 * `lead_id` field here — the sessions table has no such column, so a
 * `prev.lead_id` read is always `undefined`. The handoff must resolve the real
 * leadId via the `resolveLeadId` dep (project config + issue labels) instead;
 * an undefined leadId silently skips the TmuxAdapter CommDB registration and
 * the phase windows then never auto-close after ship.
 */
export interface PhaseSession {
	execution_id: string;
	issue_id: string;
	project_name?: string;
	session_role?: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
}

export interface PhaseOrchestratorDeps {
	/** Dispatch a new phase-session (mirrors StartRequest subset). */
	startDispatcher: {
		start(req: {
			issueId: string;
			projectName: string;
			leadId?: string;
			sessionRole: string;
			dispatchModel: string;
			startPoint: string;
			shareParentBranch: true;
			issueIdentifier?: string;
			issueTitle?: string;
		}): Promise<{ executionId: string }>;
	};
	effects: {
		/** git rev-parse HEAD in the phase's worktree; null if unavailable. */
		capturePhaseHeadSha(session: PhaseSession): Promise<string | null>;
		/** Dirty-safe close of the phase runner/tmux/worktree. */
		closePhaseRunner(session: PhaseSession): Promise<void>;
		/** Surface a fail-closed handoff error to the Lead (never silent). */
		alertLeadPipelineError(args: {
			session: PhaseSession;
			reason: string;
		}): Promise<void>;
	};
	/** Per-project three-stage enablement (Step 1 policy). */
	resolveThreeStage(session: PhaseSession): { enabled: boolean };
	/**
	 * FLY-793 (combined-QA FLY-855): resolve the REAL leadId for the next
	 * phase's dispatch — project config + the issue's labels
	 * (`resolveLeadForIssue`), exactly like post-ship finalization does. The
	 * sessions table has NO lead_id column, so this must be resolved live at
	 * handoff time. `undefined` (resolution failed) still dispatches — but the
	 * TmuxAdapter CommDB registration is then skipped and the phase window will
	 * not auto-close after ship, so the wiring should warn loudly when it
	 * returns undefined.
	 */
	resolveLeadId(session: PhaseSession): string | undefined;
	/**
	 * FLY-793 (Codex full-PR R2 #1): Design phase-sessions stuck at design_done —
	 * candidates for the startup reconcile (a boot-drain replay landed them at
	 * design_done before this orchestrator was wired, so the handoff never fired).
	 */
	listStrandedDesignPhases(): PhaseSession[];
	logger?: { log?: (m: string) => void; warn?: (m: string) => void };
}

/** The completion status that marks each phase's handoff boundary. */
const HANDOFF_STATUS: Partial<Record<ThreeStagePhase, string>> = {
	design: "design_done",
	implement: "awaiting_review",
};

export class PhaseOrchestrator {
	constructor(private readonly deps: PhaseOrchestratorDeps) {}

	private log(m: string): void {
		this.deps.logger?.log?.(`[phase-orch] ${m}`);
	}
	private warn(m: string): void {
		(this.deps.logger?.warn ?? this.deps.logger?.log)?.(`[phase-orch] ${m}`);
	}

	/**
	 * Called when a session reaches a terminal/handoff status. Idempotent-safe:
	 * only three-stage phase sessions at their exact handoff status trigger a
	 * handoff; everything else is a no-op.
	 */
	/**
	 * FLY-793 (Codex full-PR R2 #1): drive any Design phase stranded at design_done
	 * by a restart. The boot complete-marker drain runs BEFORE this orchestrator is
	 * wired, so a replayed `phase_design_complete` marker lands the session at
	 * design_done (and unlinks the marker) WITHOUT starting Implement. This runs
	 * once, post-construction, to re-drive those handoffs. Idempotent: onPhaseComplete
	 * re-gates on three-stage + role + status===design_done, so an already-advanced
	 * session no-ops. Best-effort per session — one failure never blocks the others.
	 */
	async reconcileOnStartup(): Promise<void> {
		let stranded: PhaseSession[];
		try {
			stranded = this.deps.listStrandedDesignPhases();
		} catch (err) {
			this.warn(`reconcileOnStartup query failed: ${(err as Error).message}`);
			return;
		}
		if (stranded.length > 0) {
			this.log(`reconcileOnStartup: ${stranded.length} stranded design_done`);
		}
		for (const s of stranded) {
			try {
				await this.onPhaseComplete(s);
			} catch (err) {
				this.warn(
					`reconcileOnStartup onPhaseComplete failed for ${s.execution_id}: ${(err as Error).message}`,
				);
			}
		}
	}

	async onPhaseComplete(session: PhaseSession): Promise<void> {
		const role = session.session_role;
		if (!isThreeStagePhaseRole(role)) return; // not a phase session
		if (!this.deps.resolveThreeStage(session).enabled) return; // per-project OFF

		const phase = role;
		const boundary = HANDOFF_STATUS[phase];
		if (!boundary || session.status !== boundary) return; // not at a handoff

		const next = nextPhase(phase);
		if (!next) return; // qa is last — its PASS/FAIL is the internal-QA path (Step 8)

		await this.handoff(session, next);
	}

	private async handoff(
		prev: PhaseSession,
		next: ThreeStagePhase,
	): Promise<void> {
		// 1. Capture the previous phase's exact head SHA BEFORE any cleanup — this
		//    is the durable handoff point (files on branch B). Fail-closed if
		//    unavailable (never start the next phase on an unknown head).
		const headSha = await this.deps.effects.capturePhaseHeadSha(prev);
		if (!headSha) {
			await this.failClosed(
				prev,
				`could not capture ${prev.session_role} phase head SHA — handoff aborted`,
			);
			return;
		}

		// 2. Close the previous phase runner/worktree (dirty-safe) so branch B is
		//    free for the next phase to check out (single-writer invariant).
		try {
			await this.deps.effects.closePhaseRunner(prev);
		} catch (err) {
			await this.failClosed(
				prev,
				`closing ${prev.session_role} phase runner failed: ${(err as Error).message}`,
			);
			return;
		}

		// 3. Start the next phase on the SAME issue + SAME branch B at the captured
		//    head, with the next phase's model.
		if (!prev.project_name) {
			await this.failClosed(
				prev,
				"session missing project_name — cannot start next phase",
			);
			return;
		}
		// FLY-793 (combined-QA FLY-855): resolve the real leadId LIVE — the old
		// `prev.lead_id` read was a phantom (no such sessions column → always
		// undefined → CommDB registration silently skipped → phase windows never
		// auto-closed after ship, and the leaked QA runner un-archived threads).
		const leadId = this.deps.resolveLeadId(prev);
		if (!leadId) {
			this.warn(
				`resolveLeadId returned undefined for ${prev.issue_id} — dispatching ${next} anyway, but its CommDB registration will be skipped (window will not auto-close)`,
			);
		}
		try {
			const res = await this.deps.startDispatcher.start({
				issueId: prev.issue_id,
				projectName: prev.project_name,
				leadId,
				sessionRole: next,
				dispatchModel: resolvePhaseModel(next),
				startPoint: headSha,
				shareParentBranch: true,
				issueIdentifier: prev.issue_identifier,
				issueTitle: prev.issue_title,
			});
			this.log(
				`${prev.session_role} → ${next} handoff on ${prev.issue_id} @ ${headSha.slice(0, 8)} (exec ${res.executionId})`,
			);
		} catch (err) {
			await this.failClosed(
				prev,
				`starting ${next} phase failed: ${(err as Error).message}`,
			);
		}
	}

	private async failClosed(
		session: PhaseSession,
		reason: string,
	): Promise<void> {
		this.warn(`FAIL-CLOSED ${session.issue_id}: ${reason}`);
		try {
			await this.deps.effects.alertLeadPipelineError({ session, reason });
		} catch (err) {
			this.warn(
				`alertLeadPipelineError also failed: ${(err as Error).message}`,
			);
		}
	}
}
