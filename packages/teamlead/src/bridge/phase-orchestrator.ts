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
import { REVIEW_BINDING_UNBOUND } from "../StateStore.js";

/** Minimal session shape this coordinator needs (subset of StateStore Session). */
export interface PhaseSession {
	execution_id: string;
	issue_id: string;
	project_name?: string;
	lead_id?: string;
	session_role?: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
	/** FLY-859: durable three-stage marker (Blueprint writes the phase role only
	 * for shareParentBranch phase sessions; auto-QA / single-session = 'main'). */
	chat_thread_role?: string;
	/** FLY-859: ship-gate binding — set by a needs_review completion. */
	review_question_id?: string;
}

/**
 * FLY-859: the qa_result verdict as routed from the event layer.
 * `eventId` is the stored event's id — the idempotency key the durable intent
 * is checked against (a replayed/duplicate verdict never re-runs side effects).
 */
export interface PhaseQaVerdict {
	eventId: string;
	status: string;
	summary?: string;
	prHeadSha?: string;
	/** Audit-only — three-stage verdicts are keyed to the REPORTING QA session. */
	targetExecutionId?: string;
}

/**
 * FLY-859: durable verdict intent, persisted in the QA session's
 * session_params (`three_stage_verdict`) BEFORE any side effect. The FAIL
 * fix-loop is a two-phase flow — every destructive/externally-visible step
 * records its progress here so a crash at any boundary is resumable by the
 * startup reconcile: headSha (before close — the worktree is gone after),
 * closed, fixExecId (= flow complete). `alertedAt` marks a terminal
 * fail-closed refusal or a delivered stranded-pass alert (alert-once dedup).
 */
export interface ThreeStageVerdictIntent {
	status: "pass" | "fail";
	event_id: string;
	summary?: string;
	at: string;
	headSha?: string;
	closed?: boolean;
	fixExecId?: string;
	alertedAt?: string;
}

const DEFAULT_MAX_FIX_ROUNDS = 3;

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
			phaseFixContext?: { round: number; qaSummary: string };
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
	 * FLY-793 (Codex full-PR R2 #1): Design phase-sessions stuck at design_done —
	 * candidates for the startup reconcile (a boot-drain replay landed them at
	 * design_done before this orchestrator was wired, so the handoff never fired).
	 */
	listStrandedDesignPhases(): PhaseSession[];
	/**
	 * FLY-859: the three-stage QA verdict machinery (Step 8's deferred
	 * ThreeStageQaCoordinator, folded into this orchestrator). All helpers are
	 * thin store closures wired in plugin.ts; intent read/patch operate on the
	 * `three_stage_verdict` session_params key via merge-style
	 * patchSessionParams (never overwrite — unrelated params must survive).
	 */
	qaVerdicts: {
		/** Fresh re-read of the session row — never trust a caller's snapshot. */
		getSession(executionId: string): PhaseSession | undefined;
		readIntent(executionId: string): ThreeStageVerdictIntent | undefined;
		patchIntent(
			executionId: string,
			patch: Partial<ThreeStageVerdictIntent>,
		): void;
		/** Implement-phase count for the issue (initial + fix rounds). */
		countImplementPhases(issueId: string): number;
		/**
		 * Live (non-terminal) implement phase-session for the issue, if any —
		 * closes the crash window between a successful fix dispatch and the
		 * fixExecId persist (the reconcile adopts it instead of double-spawning
		 * a second writer onto branch B).
		 */
		getActiveImplementSession(issueId: string): PhaseSession | undefined;
		/** Sweep (a) candidates: qa-phase sessions with a stored qa_result event. */
		listVerdictEventCandidates(): PhaseSession[];
		getLatestQaResultEvent(
			executionId: string,
		): { eventId: string; payload?: Record<string, unknown> } | undefined;
		/** Sweep (c) candidates: terminal qa-phase sessions carrying an intent. */
		listStrandedPassCandidates(): PhaseSession[];
		/** Best-effort issue-thread note; the orchestrator logs failures. */
		postIssueThread(session: PhaseSession, text: string): Promise<void>;
		/** Fix-round cap (default 3); maxImplementPhases = 1 + maxFixRounds. */
		maxFixRounds?: number;
	};
	logger?: { log?: (m: string) => void; warn?: (m: string) => void };
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeMaxFixRounds(value: number | undefined): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: DEFAULT_MAX_FIX_ROUNDS;
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
		await this.reconcileQaVerdicts();
	}

	/**
	 * FLY-859 startup sweeps (the boot complete-marker drain runs BEFORE this
	 * orchestrator is wired, so anything it landed is re-driven here):
	 *   (a)+(b) replay the latest stored qa_result event for every three-stage
	 *       QA session whose durable intent is missing or incomplete — covers
	 *       the /events inserted-but-unprocessed window AND resumes a FAIL
	 *       fix-loop from whichever boundary a crash left it at (onQaResult's
	 *       guard chain makes the replay idempotent);
	 *   (c) alert once on the stranded-pass shape (reported PASS, reached a
	 *       terminal status, never opened the ship gate — FLY-849 §3.8).
	 * Best-effort per session; one failure never blocks the others.
	 */
	private async reconcileQaVerdicts(): Promise<void> {
		let candidates: PhaseSession[] = [];
		try {
			candidates = this.deps.qaVerdicts.listVerdictEventCandidates();
		} catch (err) {
			this.warn(
				`reconcileQaVerdicts candidates query failed: ${(err as Error).message}`,
			);
			candidates = [];
		}
		for (const s of candidates) {
			try {
				const ev = this.deps.qaVerdicts.getLatestQaResultEvent(s.execution_id);
				if (!ev) continue;
				const p = ev.payload ?? {};
				await this.onQaResult(s, {
					eventId: ev.eventId,
					status: typeof p.status === "string" ? p.status : "",
					summary: typeof p.summary === "string" ? p.summary : undefined,
					prHeadSha: typeof p.prHeadSha === "string" ? p.prHeadSha : undefined,
					targetExecutionId:
						typeof p.targetExecutionId === "string"
							? p.targetExecutionId
							: undefined,
				});
			} catch (err) {
				this.warn(
					`reconcileQaVerdicts replay failed for ${s.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		let strandedPass: PhaseSession[] = [];
		try {
			strandedPass = this.deps.qaVerdicts.listStrandedPassCandidates();
		} catch (err) {
			this.warn(
				`reconcileQaVerdicts stranded query failed: ${(err as Error).message}`,
			);
			return;
		}
		for (const s of strandedPass) {
			try {
				await this.checkStrandedPass(s.execution_id);
			} catch (err) {
				this.warn(
					`reconcileQaVerdicts stranded check failed for ${s.execution_id}: ${(err as Error).message}`,
				);
			}
		}
	}

	async onPhaseComplete(session: PhaseSession): Promise<void> {
		const role = session.session_role;
		if (!isThreeStagePhaseRole(role)) return; // not a phase session

		// FLY-859 safety net: a three-stage QA session that reached a terminal
		// status while its verdict said PASS but no ship gate was ever opened is
		// the FLY-849 §3.8 silent break — alert the Lead. Checked BEFORE the
		// live-config gate (the alert dispatches nothing; a mid-flight config
		// flip must not mute it).
		if (
			role === "qa" &&
			(session.status === "completed" || session.status === "failed")
		) {
			await this.checkStrandedPass(session.execution_id);
			return; // qa is last — no status-driven handoff
		}

		if (!this.deps.resolveThreeStage(session).enabled) return; // per-project OFF

		const phase = role;
		const boundary = HANDOFF_STATUS[phase];
		if (!boundary || session.status !== boundary) return; // not at a handoff

		const next = nextPhase(phase);
		if (!next) return; // qa is last — its PASS/FAIL is the internal-QA path (Step 8)

		await this.handoff(session, next);
	}

	/**
	 * FLY-859 (Step 8's deferred ThreeStageQaCoordinator): a three-stage QA
	 * phase reported its verdict via `flywheel-comm qa-result`.
	 *
	 * PASS is light: persist the verdict intent and stop — the QA runner itself
	 * proceeds through the standard APPROVE GATE flow (it is the pipeline's
	 * ship-gate holder and ship executor; the founder gate opens only after
	 * PASS by construction).
	 *
	 * FAIL is the Model A fix-loop, run as a durable two-phase flow: capture
	 * head → persist → close QA (release branch B) → persist → dispatch a new
	 * Implement-fix phase pinned to that head → persist. Any fail-closed exit
	 * alerts the Lead once. The fix implement completing needs_review re-enters
	 * the existing Implement→QA handoff — the loop needs no new plumbing.
	 */
	async onQaResult(
		sessionInput: PhaseSession,
		verdict: PhaseQaVerdict,
	): Promise<void> {
		if ((sessionInput.session_role ?? "") !== "qa") return;
		// Fresh re-read — never trust the caller's snapshot (mirrors FLY-846 ⓪).
		const session =
			this.deps.qaVerdicts.getSession(sessionInput.execution_id) ??
			sessionInput;
		if ((session.chat_thread_role ?? "main") !== "qa") return; // not three-stage
		const execId = session.execution_id;

		// The recorded intent is the AUTHORITY for this QA session — one verdict
		// per lifecycle. Checked BEFORE validating the incoming verdict (Codex
		// code R1 HIGH-1): an incomplete FAIL flow must resume no matter what a
		// later/replayed qa_result carries (different event id, garbage status —
		// the sweep replays only the LATEST stored event, so gating resume on the
		// new event's identity/content would strand the recorded FAIL forever).
		const existing = this.deps.qaVerdicts.readIntent(execId);
		if (existing) {
			if (
				existing.status === "fail" &&
				!existing.fixExecId &&
				!existing.alertedAt
			) {
				await this.runFailFlow(session);
				return;
			}
			// Fully processed (pass recorded / fail complete / terminally refused).
			if (existing.event_id !== verdict.eventId) {
				this.log(
					`qa_result ${verdict.eventId} for ${execId} ignored — verdict ${existing.event_id} already recorded`,
				);
			}
			return;
		}

		const status = (verdict.status ?? "").trim().toLowerCase();
		if (status !== "pass" && status !== "fail") {
			this.warn(
				`qa_result with invalid status="${verdict.status}" for ${execId} — ignoring`,
			);
			return;
		}

		// Fresh verdict — persist the intent BEFORE any side effect.
		if (
			status === "fail" &&
			(session.status === "awaiting_review" ||
				session.status === "approved_to_ship")
		) {
			// A ship gate is already in flight for this QA session — a FAIL now
			// would yank the gate holder. Runner misbehavior; never auto-loop.
			this.warn(
				`qa_result FAIL for ${execId} ignored — session is ${session.status} (ship gate in flight)`,
			);
			return;
		}
		this.deps.qaVerdicts.patchIntent(execId, {
			status: status as "pass" | "fail",
			event_id: verdict.eventId,
			...(verdict.summary ? { summary: truncate(verdict.summary, 600) } : {}),
			at: new Date().toISOString(),
		});

		if (status === "pass") {
			this.log(
				`three-stage QA PASS for ${session.issue_id} (${execId}, target=${verdict.targetExecutionId ?? "n/a"}) — QA runner proceeds to the founder ship gate`,
			);
			return;
		}

		await this.runFailFlow(session);
	}

	private async runFailFlow(session: PhaseSession): Promise<void> {
		const execId = session.execution_id;
		const intent = () => this.deps.qaVerdicts.readIntent(execId);
		// Alert FIRST, then mark alertedAt (mirrors auto-QA's notify-then-mark: a
		// crash in between re-alerts on reconcile rather than silently stalling).
		const refuse = async (reason: string) => {
			await this.failClosed(session, reason);
			this.deps.qaVerdicts.patchIntent(execId, {
				alertedAt: new Date().toISOString(),
			});
		};

		// Never dispatch new phase-sessions for a project whose three-stage
		// config was flipped off mid-flight (matches the handoff gate) — but
		// never drop the verdict silently either.
		if (!this.deps.resolveThreeStage(session).enabled) {
			await refuse(
				`three-stage is disabled for ${session.project_name ?? "?"} — QA FAIL on ${session.issue_id} will NOT auto-loop`,
			);
			return;
		}
		if (!session.project_name) {
			await refuse("session missing project_name — cannot start Implement-fix");
			return;
		}

		// Crash window between a successful fix dispatch and the fixExecId
		// persist: a live implement phase for this issue IS that fix — adopt it
		// instead of double-spawning a second writer onto branch B.
		const active = this.deps.qaVerdicts.getActiveImplementSession(
			session.issue_id,
		);
		if (active) {
			this.deps.qaVerdicts.patchIntent(execId, {
				fixExecId: active.execution_id,
			});
			this.log(
				`QA FAIL on ${session.issue_id}: adopted already-live Implement-fix ${active.execution_id}`,
			);
			return;
		}

		const maxFixRounds = normalizeMaxFixRounds(
			this.deps.qaVerdicts.maxFixRounds,
		);
		const maxImplementPhases = 1 + maxFixRounds;
		const implementCount = this.deps.qaVerdicts.countImplementPhases(
			session.issue_id,
		);
		if (implementCount >= maxImplementPhases) {
			await refuse(
				`three-stage fix-loop cap reached on ${session.issue_id} (${implementCount} implement phases; max ${maxImplementPhases} = 1 initial + ${maxFixRounds} fix rounds) — Lead decides how to proceed`,
			);
			return;
		}

		// Capture + persist the head BEFORE closing — the worktree is gone after.
		let headSha = intent()?.headSha;
		if (!headSha) {
			headSha =
				(await this.deps.effects.capturePhaseHeadSha(session)) ?? undefined;
			if (!headSha) {
				await refuse(
					`could not capture QA phase head SHA on ${session.issue_id} — QA findings must be committed+pushed; fix-loop aborted`,
				);
				return;
			}
			this.deps.qaVerdicts.patchIntent(execId, { headSha });
		}

		if (!intent()?.closed) {
			// ALWAYS run the dirty-safe close — even for a session a restart finds
			// already terminal (Codex code R1 HIGH-2). A terminal session can still
			// hold the shared branch-B worktree; skipping the close would hand it
			// to the next dispatch's non-dirty-safe removeIfExists, which can
			// discard uncommitted QA findings. closePhaseRunner owns the dirty
			// check + proven removal (terminal statuses are close-eligible;
			// crash-preserved ones make it throw → fail-closed alert, never a
			// silent teardown).
			try {
				await this.deps.effects.closePhaseRunner(session);
			} catch (err) {
				await refuse(
					`closing QA phase runner failed: ${(err as Error).message}`,
				);
				return;
			}
			this.deps.qaVerdicts.patchIntent(execId, { closed: true });
		}

		const round = implementCount; // Nth fix round (1 initial + N-1 prior fixes)
		try {
			const res = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName: session.project_name,
				leadId: session.lead_id,
				sessionRole: "implement",
				dispatchModel: resolvePhaseModel("implement"),
				startPoint: headSha,
				shareParentBranch: true,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				phaseFixContext: {
					round,
					qaSummary: intent()?.summary ?? "(no QA summary provided)",
				},
			});
			this.deps.qaVerdicts.patchIntent(execId, { fixExecId: res.executionId });
			this.log(
				`QA FAIL → Implement-fix round ${round} on ${session.issue_id} @ ${headSha.slice(0, 8)} (exec ${res.executionId})`,
			);
		} catch (err) {
			await refuse(`starting Implement-fix failed: ${(err as Error).message}`);
			return;
		}

		try {
			await this.deps.qaVerdicts.postIssueThread(
				session,
				`🔴 三段 QA 未通过 → 已关闭 QA 段,起 Implement-fix(第 ${round} 轮修复;findings/failing tests 已在分支上)。founder 不打扰。`,
			);
		} catch (err) {
			this.warn(`postIssueThread failed: ${(err as Error).message}`);
		}
	}

	/**
	 * FLY-859 stranded-pass alert: verdict says PASS, session is terminal, and
	 * there is no REAL ship-gate binding (`review_question_id` missing or the
	 * 'unbound' sentinel, which verify-approval rejects). Alert once.
	 */
	private async checkStrandedPass(executionId: string): Promise<void> {
		const row = this.deps.qaVerdicts.getSession(executionId);
		if (!row) return;
		if (row.status !== "completed" && row.status !== "failed") return;
		const intent = this.deps.qaVerdicts.readIntent(executionId);
		if (!intent || intent.status !== "pass" || intent.alertedAt) return;
		const qid = row.review_question_id;
		if (qid && qid !== REVIEW_BINDING_UNBOUND) return; // real gate — normal ship path
		await this.failClosed(
			row,
			`three-stage QA reported PASS but reached terminal '${row.status}' WITHOUT opening the ship gate (no review binding) — the pipeline tail is stranded (FLY-849 §3.8 shape); Lead must re-drive the ship gate`,
		);
		this.deps.qaVerdicts.patchIntent(executionId, {
			alertedAt: new Date().toISOString(),
		});
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
		try {
			const res = await this.deps.startDispatcher.start({
				issueId: prev.issue_id,
				projectName: prev.project_name,
				leadId: prev.lead_id,
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
