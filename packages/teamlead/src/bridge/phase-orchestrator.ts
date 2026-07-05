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

/**
 * FLY-887: 4-state process liveness of a phase runner (mirrors
 * `probeRunnerProcessLiveness`). `alive` → a live process to park; `dead_pin` /
 * `absent` → the process is gone, close-clean (legacy); `indeterminate` (tmux
 * timeout / EACCES) → FAIL-CLOSED: never treat a possibly-alive context holder as
 * dead — leave it for reconcile.
 */
export type PhaseLiveness = "alive" | "dead_pin" | "absent" | "indeterminate";

/** FLY-887: a keep-alive wake — a FAIL fix or a retest after a new head. */
export interface WakePhaseRunnerArgs {
	session: PhaseSession;
	kind: "fix" | "retest";
	/** The head the woken phase should be at (worktree already there). */
	headSha: string;
	/** FAIL fix round (kind === "fix"). */
	round?: number;
	/** Truncated QA findings summary (kind === "fix"). */
	qaSummary?: string;
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
		/**
		 * FLY-887: 4-state process liveness of a phase runner. `alive` → park it;
		 * `dead_pin`/`absent` → close-clean; `indeterminate` → fail-closed (leave
		 * for reconcile; never close a maybe-alive context holder).
		 */
		probePhaseAlive(session: PhaseSession): Promise<PhaseLiveness>;
		/**
		 * FLY-887: park a completed-but-alive phase (CommDB declared-state marker;
		 * NOT closeRunner, NOT worktree removal). The shared worktree stays;
		 * watchdog wakes are suppressed until re-engagement.
		 */
		parkPhaseRunner(session: PhaseSession): Promise<void>;
		/**
		 * FLY-887: wake a parked phase (clear its park marker first, then mailbox
		 * wake with the role-specific instruction + new head). `{ ok:false }` →
		 * nothing was delivered (no-transport / mailbox skip); the caller holds the
		 * TURN and leaves it for reconcile (mirrors FLY-752 fail-loud retest).
		 */
		wakePhaseRunner(
			args: WakePhaseRunnerArgs,
		): Promise<{ ok: boolean; error?: string }>;
		/**
		 * FLY-887: fail-closed pre-wake worktree check (mirrors the close path's
		 * dirty guard, on the wake path). `{ ok:false, reason }` → do NOT grant the
		 * TURN, do NOT wake — alert the Lead. Verifies persisted worktree_path
		 * exists + clean + `HEAD === expectedHeadSha`.
		 */
		assertPhaseWorktreeReady(
			session: PhaseSession,
			expectedHeadSha: string,
		): Promise<{ ok: boolean; reason?: string }>;
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
	/**
	 * FLY-887: the keep-alive kill-switch (FLYWHEEL_THREE_STAGE_KEEPALIVE). When
	 * false, handoff/fail revert to the legacy close-and-respawn path (byte-compat).
	 */
	keepAliveEnabled(): boolean;
	/**
	 * FLY-887: a live (parked, non-terminal) phase-session for the issue with the
	 * given phase role — the wake target. Undefined → spawn (dispatcher seam grants
	 * its TURN). Backed by `getPhaseSessionsForIssue` filtered to the role + a
	 * parked-eligible status.
	 */
	getAlivePhaseSession(
		issueId: string,
		phase: ThreeStagePhase,
	): PhaseSession | undefined;
	/**
	 * FLY-887: grant the shared-worktree TURN to a WAKE target before waking it
	 * (spawn paths get their TURN from the dispatcher pre-launch seam instead). The
	 * project's CommDB is the single writer; epoch auto-increments.
	 */
	grantTurn(args: {
		issueId: string;
		execId: string;
		phase: ThreeStagePhase;
		projectName: string;
	}): void;
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
		 * FLY-887: durable, crash-safe fix-round accounting (insert-or-read). Keyed
		 * to the QA verdict's event id: if a `three_stage_fix_round` event already
		 * exists for it → return its recorded round (a replay after a crash resumes
		 * round N, never miscounts N+1); else round = countFixRounds + 1, insert,
		 * return. Replaces the session-count model (a keep-alive fix WAKES the parked
		 * implement, so the session count no longer grows).
		 */
		recordFixRound(session: PhaseSession, verdictEventId: string): number;
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
			// Same verdict replayed → resume an incomplete FAIL, else no-op.
			if (existing.event_id === verdict.eventId) {
				if (
					existing.status === "fail" &&
					!existing.fixExecId &&
					!existing.alertedAt
				) {
					await this.runFailFlow(session);
				}
				return;
			}
			// A DIFFERENT verdict eventId. An incomplete prior FAIL must finish first.
			if (
				existing.status === "fail" &&
				!existing.fixExecId &&
				!existing.alertedAt
			) {
				await this.runFailFlow(session);
				return;
			}
			// FLY-887: keep-alive lets ONE QA session emit MULTIPLE verdicts (round 1
			// FAIL → implementer fixes → round 2 verdict on the SAME session…). A new
			// verdict eventId following a COMPLETED FAIL round (fixExecId set) is a
			// NEW ROUND — fall through to process it fresh (overwriting the intent).
			// A prior PASS / terminal refusal (alertedAt) / keep-alive OFF is never a
			// new round → ignore the new verdict (byte-compat: keep-alive OFF closes
			// the QA session after its single verdict, so this never fires there).
			if (
				!(
					existing.status === "fail" &&
					!!existing.fixExecId &&
					this.deps.keepAliveEnabled()
				)
			) {
				this.log(
					`qa_result ${verdict.eventId} for ${execId} ignored — verdict ${existing.event_id} already recorded`,
				);
				return;
			}
			// fall through → new round
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
			// FLY-887: reset per-round progress. For a truly fresh verdict these are
			// already absent (no-op); for a keep-alive NEW ROUND they clear the prior
			// round's fixExecId/headSha so a same-verdict replay of the new round
			// re-drives (not short-circuits on the old round's fixExecId) and the head
			// is re-captured at the new round's committed tip.
			headSha: undefined,
			closed: undefined,
			fixExecId: undefined,
			alertedAt: undefined,
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

		// FLY-887: keep-alive fix loop — WAKE the alive parked implement (no close,
		// no respawn; QA parks itself via its prompt). This branch is checked BEFORE
		// the legacy active-adopt below, which would merely adopt the parked
		// implement without waking it.
		if (this.deps.keepAliveEnabled()) {
			await this.runFailFlowKeepAlive(session, refuse);
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
		// FLY-856: sessions have NO lead_id column — resolve the real leadId live
		// (project config + issue labels), exactly like the phase handoff does.
		const fixLeadId = this.deps.resolveLeadId(session);
		if (fixLeadId === undefined) {
			this.warn(
				`resolveLeadId returned undefined for ${session.issue_id} — dispatching Implement-fix anyway, but its CommDB registration will be skipped (window will not auto-close)`,
			);
		}
		try {
			const res = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName: session.project_name,
				leadId: fixLeadId,
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
	 * FLY-887: the keep-alive QA-FAIL fix loop. WAKE the alive parked implement to
	 * fix on the same branch (full context, zero token re-onboard) — no session is
	 * closed, no context is lost. If the implement died, fall back to a spawn
	 * (dispatcher seam grants its TURN). The QA session is NOT closed here: it
	 * parks itself via its prompt and is re-woken to re-verify.
	 */
	private async runFailFlowKeepAlive(
		session: PhaseSession,
		refuse: (reason: string) => Promise<void>,
	): Promise<void> {
		const execId = session.execution_id;
		const intent = () => this.deps.qaVerdicts.readIntent(execId);
		const projectName = session.project_name as string;

		// Durable, crash-safe fix-round accounting (insert-or-read on the verdict's
		// event id): a replay after a crash resumes round N, never miscounts N+1.
		const verdictEventId = intent()?.event_id;
		if (!verdictEventId) {
			await refuse(
				`no QA verdict event_id recorded on ${session.issue_id} — cannot account the fix round`,
			);
			return;
		}
		const round = this.deps.qaVerdicts.recordFixRound(session, verdictEventId);
		const maxFixRounds = normalizeMaxFixRounds(
			this.deps.qaVerdicts.maxFixRounds,
		);
		if (round > maxFixRounds) {
			await refuse(
				`three-stage fix-loop cap reached on ${session.issue_id} (fix round ${round}; max ${maxFixRounds}) — Lead decides how to proceed`,
			);
			return;
		}

		// The QA phase is a WRITER — its findings/failing tests are already committed
		// on branch B, so the head is its own committed head. Re-capture per round
		// (the worktree stays under keep-alive, and each round's head differs); the
		// fresh-verdict persist cleared the prior round's headSha. Reuse only a
		// SAME-round persisted head (crash resume within a round).
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

		const qaSummary = intent()?.summary ?? "(no QA summary provided)";
		const impl = this.deps.getAlivePhaseSession(session.issue_id, "implement");
		if (impl) {
			// Alive parked implement → WAKE it (with full context). Fail-closed on a
			// dirty / drifted worktree BEFORE granting the TURN or waking.
			const ready = await this.deps.effects.assertPhaseWorktreeReady(
				impl,
				headSha,
			);
			if (!ready.ok) {
				await this.failClosed(
					impl,
					`implement worktree not ready for fix wake (${ready.reason ?? "?"}) — not granting TURN / not waking`,
				);
				return;
			}
			this.deps.grantTurn({
				issueId: session.issue_id,
				execId: impl.execution_id,
				phase: "implement",
				projectName,
			});
			const woke = await this.deps.effects.wakePhaseRunner({
				session: impl,
				kind: "fix",
				headSha,
				round,
				qaSummary,
			});
			// Persist the fix binding AFTER the TURN + wake attempt so a same-verdict
			// replay short-circuits in onQaResult (no double-wake).
			this.deps.qaVerdicts.patchIntent(execId, {
				fixExecId: impl.execution_id,
			});
			if (woke.ok) {
				this.log(
					`QA FAIL → WAKE implement fix round ${round} on ${session.issue_id} @ ${headSha.slice(0, 8)} (impl ${impl.execution_id})`,
				);
			} else {
				this.warn(
					`QA FAIL wake implement failed for ${impl.execution_id}: ${woke.error ?? "?"} — TURN set, held for reconcile`,
				);
			}
			await this.postFixThread(session, round, true);
			return;
		}

		// The implement phase died → spawn a fresh Implement-fix (dispatcher seam
		// grants its TURN pre-launch). The QA session still parks (not closed).
		const fixLeadId = this.deps.resolveLeadId(session);
		if (fixLeadId === undefined) {
			this.warn(
				`resolveLeadId returned undefined for ${session.issue_id} — dispatching Implement-fix anyway, but its CommDB registration will be skipped (window will not auto-close)`,
			);
		}
		try {
			const res = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName,
				leadId: fixLeadId,
				sessionRole: "implement",
				dispatchModel: resolvePhaseModel("implement"),
				startPoint: headSha,
				shareParentBranch: true,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				phaseFixContext: { round, qaSummary },
			});
			this.deps.qaVerdicts.patchIntent(execId, { fixExecId: res.executionId });
			this.log(
				`QA FAIL → spawn Implement-fix round ${round} (no live implement) on ${session.issue_id} @ ${headSha.slice(0, 8)} (exec ${res.executionId})`,
			);
		} catch (err) {
			await refuse(`starting Implement-fix failed: ${(err as Error).message}`);
			return;
		}
		await this.postFixThread(session, round, false);
	}

	private async postFixThread(
		session: PhaseSession,
		round: number,
		woken: boolean,
	): Promise<void> {
		const verb = woken
			? "唤醒 implement 段(活着,带全 context)"
			: "起 Implement-fix";
		try {
			await this.deps.qaVerdicts.postIssueThread(
				session,
				`🔴 三段 QA 未通过 → 已${verb}修复(第 ${round} 轮;findings/failing tests 已在分支上)。QA 段保活等复验。founder 不打扰。`,
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

		// FLY-887: keep-alive OFF → the legacy close-and-respawn path, byte-for-byte.
		if (!this.deps.keepAliveEnabled()) {
			try {
				await this.deps.effects.closePhaseRunner(prev);
			} catch (err) {
				await this.failClosed(
					prev,
					`closing ${prev.session_role} phase runner failed: ${(err as Error).message}`,
				);
				return;
			}
			if (!prev.project_name) {
				await this.failClosed(
					prev,
					"session missing project_name — cannot start next phase",
				);
				return;
			}
			await this.dispatchNextPhase(prev, next, headSha);
			return;
		}

		// FLY-887: keep-alive ON → PARK the completed phase (alive), or close a
		// dead one. Never close a live context holder.
		const liveness = await this.deps.effects.probePhaseAlive(prev);
		if (liveness === "indeterminate") {
			// FAIL-CLOSED: a tmux-probe timeout is NOT proof the phase is dead. Leave
			// it for reconcile rather than close a possibly-alive context holder.
			await this.failClosed(
				prev,
				`${prev.session_role} phase liveness indeterminate — not parking/closing; left for reconcile`,
			);
			return;
		}
		if (liveness === "alive") {
			await this.deps.effects.parkPhaseRunner(prev);
		} else {
			// dead_pin / absent → the process is gone: close-clean (legacy behavior).
			try {
				await this.deps.effects.closePhaseRunner(prev);
			} catch (err) {
				await this.failClosed(
					prev,
					`closing dead ${prev.session_role} phase runner failed: ${(err as Error).message}`,
				);
				return;
			}
		}

		if (!prev.project_name) {
			await this.failClosed(
				prev,
				"session missing project_name — cannot start next phase",
			);
			return;
		}

		// wake-or-spawn the next phase.
		const target = this.deps.getAlivePhaseSession(prev.issue_id, next);
		if (target) {
			// The parked next phase is alive → WAKE it in place (zero checkout).
			const ready = await this.deps.effects.assertPhaseWorktreeReady(
				target,
				headSha,
			);
			if (!ready.ok) {
				await this.failClosed(
					target,
					`${next} phase worktree not ready to wake (${ready.reason ?? "?"}) — not granting TURN / not waking`,
				);
				return;
			}
			// Record the TURN BEFORE waking (wake failure → held for reconcile; the
			// TURN already points at the target so the retry is idempotent).
			this.deps.grantTurn({
				issueId: prev.issue_id,
				execId: target.execution_id,
				phase: next,
				projectName: prev.project_name,
			});
			const woke = await this.deps.effects.wakePhaseRunner({
				session: target,
				kind: "retest",
				headSha,
			});
			if (woke.ok) {
				this.log(
					`${prev.session_role} → ${next} WAKE on ${prev.issue_id} @ ${headSha.slice(0, 8)} (target ${target.execution_id})`,
				);
			} else {
				this.warn(
					`${prev.session_role} → ${next} wake failed for ${target.execution_id}: ${woke.error ?? "?"} — TURN set, held for reconcile`,
				);
			}
			return;
		}

		// No live next phase → SPAWN it (dispatcher pre-launch seam grants its TURN).
		await this.dispatchNextPhase(prev, next, headSha);
	}

	/**
	 * FLY-887: dispatch the next phase on the SAME issue + SAME branch B at the
	 * captured head, with the next phase's model. Shared by the legacy handoff and
	 * the keep-alive spawn-fallback. The caller MUST have verified `project_name`.
	 * The TURN is granted by the RunDispatcher's pre-launch seam (never here — a
	 * caller-side grant would race the runner's first `turn` self-check).
	 */
	private async dispatchNextPhase(
		prev: PhaseSession,
		next: ThreeStagePhase,
		headSha: string,
	): Promise<void> {
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
				projectName: prev.project_name as string,
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
