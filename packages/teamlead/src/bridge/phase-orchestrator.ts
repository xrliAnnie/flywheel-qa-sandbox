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
	type PhaseDispatchVendor,
	type RoleEffort,
	resolvePhaseDispatch,
	type ThreeStagePhase,
} from "flywheel-config";
import { REVIEW_BINDING_UNBOUND } from "../StateStore.js";
import { isMergeBlocked } from "./merge-ship-gate.js";
import type {
	WorkflowShadowContext,
	WorkflowShadowHooks,
} from "./workflow-shadow-writer.js";

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
	/**
	 * FLY-869: the durable merged-but-unapproved park marker (`merge_block`).
	 * FLY-1050 F9: an implement stuck at awaiting_review whose PR already
	 * MERGED carries this — it DELIVERED; the merge-block recovery flow owns
	 * it, and the QA-respawn re-drive must never spawn onto a merged branch.
	 */
	merge_block_reason?: string;
	/**
	 * FLY-939 (G-C): the persisted tmux session/window target. The ghost-probe
	 * reads this DIRECTLY (never via the CommDB registration, which is cleared for
	 * terminal sessions) to catch a terminal-status row whose tmux process is
	 * still alive — the "don't respawn onto a live ghost" signal.
	 */
	tmux_session?: string;
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
 * FLY-939 (G-C): how many of the most-recent phase rows the ghost guard probes
 * before a spawn fallback. Old rows' tmux windows were close-cleaned long ago
 * (their probe returns `absent` fast); bounding the scan keeps a stale-row pile
 * from slowing every spawn.
 */
// FLY-1204: exported so the HeartbeatService parked-phase reclaim patrol
// probes the SAME "latest N rows per role" width (no drift).
export const GHOST_PROBE_MAX_ROWS = 3;

// FLY-907: the FLY-887 face-C derivation that lived here (PhaseLineState /
// computePhaseLineStates / renderPhaseStatusLine + the local PHASE_LINE_ORDER
// copy) moved to the unified issue-display module: derivePhaseDisplayState +
// renderPhaseStatusLine in `issue-display.ts` (one state machine for faces
// B+C, park/wake-aware, order derived from THREE_STAGE_PHASE_SEQUENCE so
// FLY-905's re-sequencing follows automatically).

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

/**
 * FLY-921 Fix C: one `three_stage_turn` row (mirrors flywheel-comm's
 * ThreeStageTurn — re-declared here so teamlead does not import the CommDB
 * package types). Rows carry no project name; plugin.ts owns attribution.
 */
export interface TurnBeltRow {
	issue_id: string;
	holder_exec_id: string;
	phase: string;
	epoch: number;
	granted_at: number;
}

/**
 * FLY-921 Fix C: a fresh spawn's TURN is granted at the dispatcher pre-launch
 * seam BEFORE its `session_started` row lands (fire-and-forget) — a
 * missing-row holder younger than this window is an in-flight spawn, not a
 * remnant. Beyond it, dispatch and Bridge died together: genuine remnant.
 */
// FLY-1204: exported so the HeartbeatService parked-phase reclaim patrol shares
// the SAME in-flight-spawn grace window (a fresh TURN whose holder session row
// is not yet registered = a spawn in progress, must not be reclaimed).
export const TURN_GRANT_GRACE_MS = 5 * 60_000;

/** Recovery target priority: most-downstream parked-alive phase first. */
const TURN_RECOVERY_PRIORITY: readonly ThreeStagePhase[] = [
	"qa",
	"implement",
	"design",
];

// TERMINAL_SESSION_STATUS stays {completed, failed} — it is the turn-belt
// holder's "skip the liveness probe, judge stale directly" fast path.
// `terminated` must NEVER join this set (FLY-1050, Codex R1 #1): a terminate
// can return cleanupPending (FSM already terminal but the tmux still alive);
// a direct stale verdict would hand the TURN back to implement while the old
// QA process is still writing — the probe path (alive/indeterminate → no-op)
// must keep guarding it.
const TERMINAL_SESSION_STATUS = new Set(["completed", "failed"]);

/**
 * FLY-1050: the DEAD-QA domain for the respawn criteria and the stranded-pass
 * alert — deliberately SEPARATE from the belt's TERMINAL_SESSION_STATUS above.
 * A qa row in one of these statuses no longer runs; if it left the pipeline
 * without a ship claim, the implement→QA handoff may be re-driven.
 */
const DEAD_QA_STATUSES = new Set(["completed", "failed", "terminated"]);

/** FLY-1050: dead qa rows at/above this count refuse to respawn (fail-closed
 * alert instead) — the dead rows themselves are the durable ledger. */
const QA_RESPAWN_MAX = 3;

/**
 * FLY-1050 escape hatch: `FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` turns the QA
 * respawn OFF (the re-drive criteria reverts to row-exists; the scoped event
 * sites go inert). NOTE: the terminated stranded-pass alert hardening is NOT
 * gated by this switch (Codex R1 #4) — it fixes an independent silent-strand
 * bug, and rolling back the respawn must not re-introduce the silence.
 */
function qaRespawnEnabled(): boolean {
	return process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN !== "0";
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
			/**
			 * FLY-1224: the phase table's vendor — every phase spawn carries the
			 * full {model, vendor, effort} triple so the resolver's 1b layer picks
			 * the right executor backend (codex-tmux for the implement phase).
			 */
			dispatchVendor?: PhaseDispatchVendor;
			/** FLY-1224: the phase table's reasoning effort. */
			dispatchEffort?: RoleEffort;
			startPoint: string;
			shareParentBranch: true;
			/**
			 * FLY-887 R2: always `true` on a phase spawn — the Linear label layer
			 * outranks dispatchModel in resolveRoleAdapter, so without this a
			 * `sonnet` model label (or a no-transport vendor label, which could
			 * never receive park/wake mailboxes) would beat the phase table.
			 */
			ignoreRunnerLabelSelection: true;
			issueIdentifier?: string;
			issueTitle?: string;
			phaseFixContext?: { round: number; qaSummary: string };
			/** FLY-1232 module ②: semantic shadow context for the T2/T7 seam —
			 * set ONLY when the workflowShadow dep is wired (never an ordinal). */
			shadowContext?: WorkflowShadowContext;
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
		/**
		 * FLY-939 (G-C): probe process liveness of a phase row's PERSISTED tmux
		 * session directly (`row.tmux_session` → probeRunnerProcessLiveness), NOT
		 * via the CommDB registration lookup. `probePhaseAlive` above goes through
		 * the CommDB (`getTmuxTargetFromCommDb`), which returns `absent` when the
		 * registration was cleared for a terminal session — exactly masking the
		 * "terminal row, live tmux window" pollution the ghost guard must catch
		 * (Codex design R1 #2). A row with no `tmux_session` → `absent`.
		 */
		probeGhostTmux(row: PhaseSession): Promise<PhaseLiveness>;
	};
	/** Per-project three-stage enablement (Step 1 policy). `reason` (present
	 * when disabled) is logged at handoff boundaries — a disabled policy must
	 * never no-op silently there (FLY-902). */
	resolveThreeStage(session: PhaseSession): {
		enabled: boolean;
		reason?: string;
	};
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
	 * FLY-939 (G-A2): implement phase-sessions stranded at awaiting_review —
	 * candidates for the startup reconcile of a lost implement→QA handoff. A
	 * crash / wake-fail between the implement completing needs_review and the QA
	 * being spawned leaves the implement parked at awaiting_review with no QA. The
	 * reconcile re-drives `onPhaseComplete(implement)` ONLY when the issue has
	 * ZERO qa phase rows and no ship-finalization claim (see reconcileOnStartup).
	 * `role='implement' AND status='awaiting_review' AND chat_thread_role='implement'`.
	 */
	listStrandedImplementPhases(): PhaseSession[];
	/**
	 * FLY-939 (G-C): ALL phase-session rows for an issue + phase role (ANY status,
	 * newest first with a `rowid DESC` tiebreak for deterministic ordering — Codex
	 * design R1 #2). The ghost guard probes the most-recent few (with a
	 * tmux_session) to detect a terminal-status row whose tmux is still alive
	 * before a spawn fallback. plugin.ts:
	 * `getPhaseSessionsForIssue(issue).filter(chat_thread_role===phase)`.
	 */
	listPhaseSessionRows(issueId: string, phase: ThreeStagePhase): PhaseSession[];
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
	 * FLY-887 QA round 2: true when `runPostShipFinalization`'s atomic
	 * per-issue claim event (`post_ship_finalization_claim`) already exists for
	 * this issue — the issue has already shipped and entered (or completed)
	 * `finalizeThreeStagePhases`. `getAlivePhaseSession` alone cannot see this:
	 * a Bridge crash between closing Implement (→ `completed`, no longer ALIVE)
	 * and closing Design (still `design_done`) leaves a stranded design row
	 * whose downstream reads as "gone", indistinguishable from a genuine
	 * "Implement never started" remnant — without this check
	 * `hasProgressedPastDesign` would spawn a brand-new Implement onto an
	 * issue that is already merged. A dead/crashed (never-shipped) Implement
	 * has no such claim event, so the genuine-remnant re-drive is unaffected.
	 */
	hasShipFinalizationClaim(issueId: string): boolean;
	/**
	 * FLY-887 (Annie founder-visibility ask): refresh the single, in-place-
	 * edited 3-stage status line on the issue's main chat thread (e.g.
	 * "🎨design(parked)·🔨implement(active)·🧪qa(pending)"). No-op when the
	 * chat thread / issue has no phase sessions. Never throws (best-effort —
	 * a Discord hiccup here must never break a real handoff/verdict).
	 */
	refreshPhaseStatusLine(issueId: string): Promise<void>;
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
		sourceEventId: string;
	}): void;
	/**
	 * FLY-921 Fix C: turn-belt reconcile reads/writes. All rows are
	 * project-attributed by plugin.ts (per-project CommDBs); the orchestrator
	 * never touches an unattributed turn row. `getTurn` is the scoped
	 * event-position read (guard 1 must NOT run the full stale matrix after a
	 * successful handoff — Codex R3 non-blocking #2).
	 */
	turnBelt: {
		listTurns(): { projectName: string; turn: TurnBeltRow }[];
		getTurn(issueId: string, projectName: string): TurnBeltRow | null;
		deleteTurn(issueId: string, projectName: string): void;
		/** Fresh StateStore row for a TURN holder; undefined = no session row. */
		getSessionForTurnHolder(execId: string): PhaseSession | undefined;
		/** All phase sessions for the issue — the recovery candidate pool. */
		getPhaseSessionsForIssue(issueId: string): PhaseSession[];
	};
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
		/**
		 * FLY-939 (G-B): true when the session's bound review question
		 * (`review_question_id`) ALREADY has a response in the project CommDB — i.e.
		 * the founder/Lead answered the approve_to_ship gate. Used to distinguish a
		 * legitimate founder-feedback KICKBACK (gate answered "changes requested",
		 * QA re-emits qa-result FAIL) from a stray FAIL while a ship gate is
		 * genuinely pending. Fail-closed: any lookup error → false (refuse the
		 * kickback rather than yank a live gate). plugin.ts opens the project CommDB
		 * and calls `getResponse(review_question_id)`.
		 */
		hasGateResponse(session: PhaseSession): boolean;
		/** Fix-round cap (default 3); maxImplementPhases = 1 + maxFixRounds. */
		maxFixRounds?: number;
	};
	/**
	 * FLY-1232 module ②: optional lifecycle shadow hooks (T3/T3b/T4/T5/T6 —
	 * see the transition-table contract in workflow-shadow-writer.ts). Wired
	 * by plugin.ts ONLY when FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1; undefined ⇒
	 * zero shadow interaction (byte-compatible). Every hook is no-throw by
	 * contract (the writer warns loudly instead) — the production pipeline
	 * never depends on a shadow write succeeding.
	 */
	workflowShadow?: WorkflowShadowHooks;
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

/**
 * FLY-921 Fix B: runner-driven completion evidence for the implement→QA
 * handoff. A genuine `complete --route needs_review --question-id Q` binds
 * `review_question_id`; synthesized completions can't, and a forgotten
 * `--question-id` lands the 'unbound' sentinel (which verify-approval
 * rejects anyway). `pr_number` is deliberately NOT required — complete.ts
 * does not force `--pr` for needs_review (Codex design R1 #1).
 */
function hasRunnerDrivenReviewEvidence(session: PhaseSession): boolean {
	const qid = session.review_question_id;
	return !!qid && qid !== REVIEW_BINDING_UNBOUND;
}

export class PhaseOrchestrator {
	constructor(private readonly deps: PhaseOrchestratorDeps) {}

	private log(m: string): void {
		this.deps.logger?.log?.(`[phase-orch] ${m}`);
	}
	private warn(m: string): void {
		(this.deps.logger?.warn ?? this.deps.logger?.log)?.(`[phase-orch] ${m}`);
	}

	/**
	 * FLY-1244: founder-confirmed recovery for an in-flight, pre-enrollment QA.
	 * The old runner is closed through the normal dirty-safe phase teardown, then
	 * a NEW logical attempt is spawned. Admission happens inside RunDispatcher
	 * before Blueprint starts; the route verifies that binding before acknowledging.
	 */
	async respawnUnenrolledQa(
		session: PhaseSession,
		prHeadSha: string,
		targetAttempt: number,
	): Promise<{ executionId: string }> {
		if (
			(session.session_role ?? "main") !== "qa" ||
			(session.chat_thread_role ?? "main") !== "qa" ||
			!session.project_name ||
			!Number.isInteger(targetAttempt) ||
			targetAttempt <= 1 ||
			!/^[0-9a-f]{40}$/i.test(prHeadSha)
		) {
			throw new Error("invalid_re_qa_source");
		}
		try {
			await this.deps.effects.closePhaseRunner(session);
		} catch (error) {
			await this.failClosed(
				session,
				`re-QA could not safely close the unenrolled QA: ${(error as Error).message}`,
			);
			throw error;
		}
		try {
			const dispatch = resolvePhaseDispatch("qa");
			const result = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName: session.project_name,
				leadId: this.deps.resolveLeadId(session),
				sessionRole: "qa",
				dispatchModel: dispatch.model,
				dispatchVendor: dispatch.vendor,
				...(dispatch.effort && { dispatchEffort: dispatch.effort }),
				startPoint: prHeadSha.toLowerCase(),
				shareParentBranch: true,
				ignoreRunnerLabelSelection: true,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				...(this.deps.workflowShadow && {
					shadowContext: { node: "qa", attempt: targetAttempt },
				}),
			});
			this.log(
				`re-QA superseded ${session.execution_id} → ${result.executionId} attempt ${targetAttempt} @ ${prHeadSha.slice(0, 8)}`,
			);
			return result;
		} catch (error) {
			await this.failClosed(
				session,
				`re-QA replacement spawn failed after safe close: ${(error as Error).message}`,
			);
			throw error;
		}
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
			// FLY-887 QA finding: under keep-alive a Design phase parks FOREVER at
			// status='design_done' (that is the whole point of "park, don't exit"),
			// so `getStrandedDesignPhaseSessions` — a blind `role='design' AND
			// status='design_done'` query written pre-FLY-887, when design_done was
			// ALWAYS a genuine "implement never started" crash artifact — now ALSO
			// matches every currently-healthy parked design, on EVERY Bridge restart,
			// until the issue ships. Replaying those through the handoff re-derives
			// design→implement and re-runs the wake path even when the pipeline has
			// long moved past Implement into a live QA fix-loop: it tears the shared-
			// worktree TURN away from whoever legitimately holds it and sends a phase a
			// wake it was never taught to handle. reconcile's sole job is to COMPLETE a
			// handoff that never fired, so only re-drive a genuine remnant — one whose
			// downstream never came up. If any downstream phase (implement or qa) is
			// already alive, the handoff fired: the pipeline owns itself now — skip.
			if (this.hasProgressedPastDesign(s.issue_id)) {
				this.log(
					`reconcileOnStartup: ${s.execution_id} (${s.issue_id}) already progressed past design (live downstream phase) — skip stale handoff replay`,
				);
				continue;
			}
			try {
				await this.onPhaseComplete(s);
			} catch (err) {
				this.warn(
					`reconcileOnStartup onPhaseComplete failed for ${s.execution_id}: ${(err as Error).message}`,
				);
			}
		}
		await this.reconcileStrandedImplementHandoffs();
		await this.reconcileQaVerdicts();
	}

	/**
	 * FLY-939 (G-A2) + FLY-1050: re-drive an implement→QA handoff that a crash /
	 * wake-fail / dead QA lost. A stranded implement sits at awaiting_review with
	 * its review binding set, but no QA is running — re-fire
	 * `onPhaseComplete(implement)` (the existing handoff: spawns or wakes QA,
	 * passes through the G-C ghost guard). Skips when the pipeline still owns
	 * itself (`hasProgressedPastImplement`: alive QA / latest-FAIL fix-loop /
	 * ship claim); FLY-1050 made dead qa rows (terminated/failed/completed, no
	 * ship claim) STOP counting as ownership so the FLY-967 strand self-heals on
	 * boot — the re-drive goes through `tryRedriveImplementHandoff` (respawn cap
	 * + per-issue in-flight guard). Best-effort per session; one failure never
	 * blocks the rest.
	 */
	private async reconcileStrandedImplementHandoffs(): Promise<void> {
		let stranded: PhaseSession[];
		try {
			stranded = this.deps.listStrandedImplementPhases();
		} catch (err) {
			this.warn(
				`reconcileStrandedImplementHandoffs query failed: ${(err as Error).message}`,
			);
			return;
		}
		if (stranded.length > 0) {
			this.log(
				`reconcileStrandedImplementHandoffs: ${stranded.length} implement awaiting_review candidate(s)`,
			);
		}
		for (const s of stranded) {
			if (this.hasProgressedPastImplement(s.issue_id)) {
				this.log(
					`reconcileStrandedImplementHandoffs: ${s.execution_id} (${s.issue_id}) pipeline still owns itself (alive qa / latest-FAIL fix-loop / ship claim) — skip re-drive`,
				);
				continue;
			}
			try {
				await this.tryRedriveImplementHandoff(s);
			} catch (err) {
				this.warn(
					`reconcileStrandedImplementHandoffs re-drive failed for ${s.execution_id}: ${(err as Error).message}`,
				);
			}
		}
	}

	/** FLY-1050: per-issue in-flight guard — concurrent triggers (terminate
	 * action × session_failed × boot) must never double-spawn in the window
	 * before the fresh QA's session row lands. */
	private readonly redriveInFlight = new Set<string>();

	/**
	 * FLY-1050: the single re-drive entrance (boot loop + scoped event sites).
	 * Applies the respawn cap (dead qa rows are the durable ledger — every
	 * failed respawn necessarily adds one), then re-fires the EXISTING
	 * implement→QA handoff (`onPhaseComplete` re-runs all its gates: boundary,
	 * per-project policy, review evidence, ghost guard). Posts a best-effort
	 * issue-thread note only when this was a genuine RESPAWN (dead qa rows
	 * existed) and the spawn actually landed (an alive qa row now exists) — a
	 * plain G-A2 zero-row re-drive stays note-free, and a failed spawn already
	 * fail-closed-alerted inside the handoff.
	 */
	private async tryRedriveImplementHandoff(impl: PhaseSession): Promise<void> {
		// FLY-1050 F9 (merged-but-awaiting_review, e.g. FLY-1023): a merge_block
		// marker means this implement's PR already MERGED without ship approval —
		// it DELIVERED. The FLY-869 recovery flow owns it (and its doctrine says a
		// parked merge_block session must never leak into QA surfaces), so never
		// re-drive its handoff / respawn a QA onto a merged branch. No alert —
		// the once-per-head merge_without_approval alert already fired.
		if (isMergeBlocked(impl)) {
			this.log(
				`tryRedriveImplementHandoff: ${impl.execution_id} (${impl.issue_id}) is merge-blocked (PR merged without ship approval) — delivered; skip QA respawn`,
			);
			return;
		}
		if (this.redriveInFlight.has(impl.issue_id)) return;
		this.redriveInFlight.add(impl.issue_id);
		try {
			const deadQa = this.deps
				.listPhaseSessionRows(impl.issue_id, "qa")
				.filter((r) => DEAD_QA_STATUSES.has(r.status));
			if (deadQa.length >= QA_RESPAWN_MAX) {
				await this.failClosed(
					impl,
					`three-stage QA respawn cap reached on ${impl.issue_id} (${deadQa.length} dead qa sessions; max ${QA_RESPAWN_MAX}) — NOT respawning; Lead decides how to proceed`,
				);
				return;
			}
			const hadDeadQa = deadQa.length > 0;
			await this.onPhaseComplete(impl); // reuse every existing gate + handoff
			if (hadDeadQa && this.deps.getAlivePhaseSession(impl.issue_id, "qa")) {
				await this.postRespawnThreadNote(impl);
			}
		} finally {
			this.redriveInFlight.delete(impl.issue_id);
		}
	}

	/**
	 * FLY-1050: a three-stage QA row reached a dead terminal status — if the
	 * pipeline lost its ability to advance itself, re-drive the implement→QA
	 * handoff (respawn a fresh QA, epoch+1 via the dispatcher pre-launch seam).
	 * Idempotent / safe to call repeatedly: an alive QA (including the one just
	 * respawned), a latest-FAIL fix-loop, a ship claim, a non-qa or non-terminal
	 * row, or a missing stranded implement all no-op. Callers should fire this
	 * BEFORE any scoped turn-belt reconcile — a successful respawn's pre-launch
	 * grant overwrites the TURN, so guard 1 then no-ops (no stale-holder alert
	 * noise); a refused respawn leaves the belt reconcile to recover the TURN.
	 */
	async reconcileQaLoss(scope: {
		issueId: string;
		terminalExecId: string;
	}): Promise<void> {
		if (!qaRespawnEnabled()) return;
		const dead = this.deps.qaVerdicts.getSession(scope.terminalExecId); // fresh re-read
		if ((dead?.chat_thread_role ?? "main") !== "qa") return; // three-stage qa rows only
		if (!DEAD_QA_STATUSES.has(dead?.status ?? "")) return; // FSM-rejected zombies never enter
		if (this.hasProgressedPastImplement(scope.issueId)) return; // same criteria as boot
		const impl = this.deps
			.listPhaseSessionRows(scope.issueId, "implement")
			.find((s) => s.status === "awaiting_review");
		if (!impl) return; // no stranded implement → nothing to re-drive
		await this.tryRedriveImplementHandoff(impl);
	}

	/** FLY-1050: best-effort respawn visibility on the issue thread. */
	private async postRespawnThreadNote(impl: PhaseSession): Promise<void> {
		try {
			await this.deps.qaVerdicts.postIssueThread(
				impl,
				"🧪 三段 QA 段已死(terminated/failed),已自动重生新 QA session 重验(同分支最新 head)。founder 不打扰。",
			);
		} catch (err) {
			this.warn(`postIssueThread failed: ${(err as Error).message}`);
		}
	}

	/**
	 * FLY-1050: does this issue's pipeline still OWN ITSELF past the implement
	 * handoff — i.e. is a re-drive unnecessary/unsafe? The pre-FLY-1050 criteria
	 * ("ANY qa row exists = the handoff fired once = skip") wrongly counted DEAD
	 * qa rows (terminated/failed/completed with no ship claim) as ownership —
	 * the FLY-967 strand: a terminated QA left the implement parked at
	 * awaiting_review with no clean path to respawn its QA. True when:
	 *   - the issue already shipped (ship-finalization claim), or
	 *   - an ALIVE qa phase-session is on duty (wake target exists), or
	 *   - the LATEST qa row's verdict intent is FAIL — the fix-loop owns the
	 *     pipeline (shapes 2/3): the implement may be mid-fix, and the FAIL flow
	 *     has its own resume machinery (reconcileQaVerdicts). Only qaRows[0] may
	 *     be consulted — an OLD round's legitimate FAIL (with fixExecId) must
	 *     never permanently block a NEW dead QA's respawn (Codex R1 #3).
	 * Everything else (dead qa rows only, or zero qa rows) → false: the
	 * stranded implement's handoff is re-driven (respawning a fresh QA).
	 * Escape hatch: respawn OFF reverts to the row-exists criteria.
	 */
	private hasProgressedPastImplement(issueId: string): boolean {
		if (this.deps.hasShipFinalizationClaim(issueId)) return true;
		try {
			const qaRows = this.deps.listPhaseSessionRows(issueId, "qa"); // newest first
			if (!qaRespawnEnabled()) return qaRows.length > 0; // pre-FLY-1050 criteria
			if (this.deps.getAlivePhaseSession(issueId, "qa")) return true;
			const latest = qaRows[0];
			if (!latest) return false; // zero qa rows — the G-A2 original scenario
			const intent = this.deps.qaVerdicts.readIntent(latest.execution_id);
			return intent?.status === "fail"; // fix-loop owns the pipeline
		} catch (err) {
			// Fail-closed: if we cannot prove the pipeline lost itself, do not
			// re-drive (a duplicate QA spawn is worse than a missed re-drive, which
			// the next boot/trigger retries once the query recovers).
			this.warn(
				`hasProgressedPastImplement query failed for ${issueId}: ${(err as Error).message} — treating as progressed (no re-drive)`,
			);
			return true;
		}
	}

	/**
	 * FLY-939 (G-C): the "never respawn onto a live ghost" structural guard.
	 * Returns true when a spawn fallback may proceed; false (and alerts the Lead)
	 * when a terminal-status phase row still has a live — or indeterminate — tmux
	 * process, which spawning would duplicate (two writers on shared branch B).
	 * Only reached from the keep-alive spawn fallbacks: `getAlivePhaseSession`
	 * already returned undefined, so any probe-ALIVE row here is DB/tmux state
	 * pollution (a bypass flipped the row terminal while its window lived on), not
	 * a healthy parked phase. Fail-closed on `alive` AND `indeterminate` — an
	 * unknown probe never licenses a duplicate; operator reconcile (FLY-934) or the
	 * next trigger's re-probe clears it. Probes only the most-recent
	 * GHOST_PROBE_MAX_ROWS rows carrying a tmux_session (newest first, deterministic
	 * via the dep's rowid tiebreak).
	 */
	private async ghostGuard(
		issueId: string,
		phase: ThreeStagePhase,
	): Promise<boolean> {
		if (!this.deps.keepAliveEnabled()) return true; // never probe on the legacy path
		let rows: PhaseSession[];
		try {
			rows = this.deps.listPhaseSessionRows(issueId, phase);
		} catch (err) {
			// A row query failure is not evidence of a ghost — warn + proceed rather
			// than brick every handoff on a transient DB read error.
			this.warn(
				`ghostGuard row query failed for ${issueId}/${phase}: ${(err as Error).message} — proceeding with spawn`,
			);
			return true;
		}
		const probeRows = rows
			.filter((r) => !!r.tmux_session)
			.slice(0, GHOST_PROBE_MAX_ROWS);
		for (const row of probeRows) {
			const liveness = await this.deps.effects.probeGhostTmux(row);
			if (liveness === "alive" || liveness === "indeterminate") {
				await this.failClosed(
					row,
					`terminal-status ${phase} session ${row.execution_id} still has a ${
						liveness === "alive"
							? "LIVE"
							: "possibly-live (indeterminate probe)"
					} tmux process (${row.tmux_session}) — refusing to spawn a duplicate ${phase} (would double-write shared branch B). Operator must reconcile the stale row/window (FLY-934); the parked runner is not lost.`,
				);
				return false;
			}
		}
		return true;
	}

	/**
	 * FLY-887 QA finding: has this issue's pipeline advanced past Design? True when
	 * a live (parked, non-terminal) implement OR qa phase-session already exists —
	 * i.e. the design→implement handoff already fired and the pipeline is running
	 * itself. Both phases must be checked: a dead implement (whose row is gone /
	 * terminal) with a live QA fix-loop must still read as "progressed" so reconcile
	 * does not resurrect a stale design→implement handoff underneath the QA that
	 * legitimately holds the TURN. Only when NEITHER is alive is a `design_done`
	 * session the genuine "implement never started" crash remnant reconcile exists
	 * for. The TURN table is a strict subset of this signal (a TURN only ever points
	 * at a live phase), so this alive-phase check subsumes it.
	 *
	 * FLY-887 QA round 2: the alive-phase check alone cannot see a downstream
	 * that already finished via SHIPPING (closed to `completed`, so no longer
	 * ALIVE) rather than crashing — so it is OR'd with
	 * `hasShipFinalizationClaim`, the durable per-issue signal that
	 * `runPostShipFinalization` already ran for this issue.
	 */
	private hasProgressedPastDesign(issueId: string): boolean {
		return (
			this.deps.getAlivePhaseSession(issueId, "implement") !== undefined ||
			this.deps.getAlivePhaseSession(issueId, "qa") !== undefined ||
			this.deps.hasShipFinalizationClaim(issueId)
		);
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
		// flip must not mute it). FLY-1050: `terminated` joins the domain (root
		// cause ③ — a terminate replayed through the event flow / crash-reaper
		// was silently invisible here).
		if (role === "qa" && DEAD_QA_STATUSES.has(session.status)) {
			await this.checkStrandedPass(session.execution_id);
			return; // qa is last — no status-driven handoff
		}

		const phase = role;
		const boundary = HANDOFF_STATUS[phase];
		if (!boundary || session.status !== boundary) return; // not at a handoff

		// Policy checked AFTER the boundary check (both are pure reads, so the
		// swap is behavior-identical) so the disabled-warn fires exactly at real
		// handoff boundaries — and never for auto-QA `qa`-role sessions, which
		// share the phase-role guard above but have no handoff boundary.
		const policy = this.deps.resolveThreeStage(session); // per-project OFF
		if (!policy.enabled) {
			// FLY-902: never no-op silently at a handoff boundary. This exact
			// silence hid the missing-dispatchChannelId wiring bug — design sat at
			// design_done forever with zero logs.
			this.warn(
				`three-stage disabled at ${phase} handoff for ${session.issue_id} (${session.execution_id}): ${policy.reason ?? "no reason given"} — handoff NOT dispatched`,
			);
			return;
		}

		// FLY-921 Fix B: implement→QA needs runner-driven completion EVIDENCE.
		// A genuine `complete --route needs_review --question-id Q` binds
		// review_question_id; a synthesized completion (nested-session callback,
		// kill, early death — routed via DecisionLayer/fallback) never can, and
		// a runner that forgot --question-id lands the 'unbound' sentinel which
		// verify-approval already rejects. Order: boundary → policy (FLY-902
		// disabled-warn keeps its semantics) → evidence → handoff.
		if (phase === "implement" && !hasRunnerDrivenReviewEvidence(session)) {
			await this.failClosed(
				session,
				`implement reached awaiting_review WITHOUT runner-driven review evidence (review_question_id=${session.review_question_id ?? "absent"}) — synthesized completion suspected (nested-session callback / early process death / kill); QA NOT started. Lead can re-drive after verifying the implement session.`,
			);
			await this.deps.refreshPhaseStatusLine(session.issue_id);
			return;
		}

		// FLY-1232 T4: shadow the node completion at its genuine handoff boundary
		// (all gates above passed). uid is keyed by execution id, so reconcile
		// re-drives of this same handoff dedupe instead of duplicating.
		this.deps.workflowShadow?.onNodeComplete({
			projectName: session.project_name ?? "",
			issueId: session.issue_id,
			executionId: session.execution_id,
			node: phase,
			attempt: this.deps.workflowShadow.currentAttempt(session.issue_id),
		});

		const next = nextPhase(phase);
		if (!next) return; // qa is last — its PASS/FAIL is the internal-QA path (Step 8)

		await this.handoff(session, next);
		await this.deps.refreshPhaseStatusLine(session.issue_id);
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

		// FLY-939 (G-B): a founder/Lead "changes requested" reply lands on the QA
		// session's OWN approve_to_ship gate as a feedback wake. The QA prompt's
		// kickback contract forbids QA from editing code (role separation) and has
		// it re-emit `qa-result --status fail` instead. Recognize that legitimate
		// kickback so the two guards below let it into the fix-loop (which WAKES the
		// parked implement) rather than dropping it:
		//   - keep-alive ON only (OFF closes QA after its single verdict → byte-compat);
		//   - the incoming verdict is FAIL;
		//   - the QA session sits at awaiting_review (its own ship gate is open);
		//   - the gate's bound review question ALREADY has a response (the feedback).
		// approved_to_ship is deliberately EXCLUDED (a verified approval was already
		// consumed — a FAIL then must never un-ship; verify-approval's pr_head_sha
		// binding would reject the old head anyway, but we refuse structurally too).
		const incomingStatus = (verdict.status ?? "").trim().toLowerCase();
		const isFeedbackKickback =
			this.deps.keepAliveEnabled() &&
			incomingStatus === "fail" &&
			session.status === "awaiting_review" &&
			hasRunnerDrivenReviewEvidence(session) &&
			this.deps.qaVerdicts.hasGateResponse(session);

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
			// FLY-939 (G-B): EXCEPT a founder-feedback kickback — the QA session's
			// prior intent is a PASS (it passed, opened the ship gate, then the
			// founder asked for changes), so this must fall through over the recorded
			// PASS to re-drive the fix-loop. Kept narrow via isFeedbackKickback
			// (awaiting_review + answered gate) so an ordinary post-PASS stray FAIL
			// is still ignored.
			if (
				!(
					existing.status === "fail" &&
					!!existing.fixExecId &&
					this.deps.keepAliveEnabled()
				) &&
				!isFeedbackKickback
			) {
				this.log(
					`qa_result ${verdict.eventId} for ${execId} ignored — verdict ${existing.event_id} already recorded`,
				);
				return;
			}
			// fall through → new round (or a founder-feedback kickback over a PASS)
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
				session.status === "approved_to_ship") &&
			!isFeedbackKickback
		) {
			// A ship gate is already in flight for this QA session — a FAIL now
			// would yank the gate holder. Runner misbehavior; never auto-loop.
			// FLY-939 (G-B): the ONE exception is a founder-feedback kickback
			// (isFeedbackKickback: awaiting_review + the bound gate already
			// answered) — that FAIL IS the pipeline routing the founder's requested
			// changes to the parked implement, so it falls through to the fix-loop.
			this.warn(
				`qa_result FAIL for ${execId} ignored — session is ${session.status} (ship gate in flight; not a founder-feedback kickback)`,
			);
			return;
		}
		if (isFeedbackKickback) {
			this.log(
				`qa_result FAIL for ${execId} accepted as a founder-feedback KICKBACK (awaiting_review gate already answered) — routing to the fix-loop: WAKE the parked implement, never edit code in QA`,
			);
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
			// FLY-1232 T5: qa completes AND traverses the qa→end edge.
			this.deps.workflowShadow?.onQaPass({
				projectName: session.project_name ?? "",
				issueId: session.issue_id,
				executionId: execId,
				attempt: this.deps.workflowShadow.currentAttempt(session.issue_id),
			});
			await this.deps.refreshPhaseStatusLine(session.issue_id);
			return;
		}

		await this.runFailFlow(session);
		await this.deps.refreshPhaseStatusLine(session.issue_id);
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
		const failFlowPolicy = this.deps.resolveThreeStage(session);
		if (!failFlowPolicy.enabled) {
			await refuse(
				`three-stage is disabled for ${session.project_name ?? "?"} (${failFlowPolicy.reason ?? "no reason given"}) — QA FAIL on ${session.issue_id} will NOT auto-loop`,
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
		// FLY-1232 T6 (legacy path): the round determination point mirrors the
		// keep-alive path's recordFixRound site — same sole-owner discipline.
		this.deps.workflowShadow?.onKickback({
			projectName: session.project_name,
			issueId: session.issue_id,
			round,
		});
		// FLY-856: sessions have NO lead_id column — resolve the real leadId live
		// (project config + issue labels), exactly like the phase handoff does.
		const fixLeadId = this.deps.resolveLeadId(session);
		if (fixLeadId === undefined) {
			this.warn(
				`resolveLeadId returned undefined for ${session.issue_id} — dispatching Implement-fix anyway, but its CommDB registration will be skipped (window will not auto-close)`,
			);
		}
		try {
			// FLY-1224: the phase table carries {model, vendor, effort} — pass the
			// full triple so the resolver picks the phase's executor backend.
			const dispatch = resolvePhaseDispatch("implement");
			const res = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName: session.project_name,
				leadId: fixLeadId,
				sessionRole: "implement",
				dispatchModel: dispatch.model,
				dispatchVendor: dispatch.vendor,
				...(dispatch.effort && { dispatchEffort: dispatch.effort }),
				startPoint: headSha,
				shareParentBranch: true,
				// FLY-887 R2: labels never outrank the phase table (see deps JSDoc).
				ignoreRunnerLabelSelection: true,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				phaseFixContext: {
					round,
					qaSummary: intent()?.summary ?? "(no QA summary provided)",
				},
				...(this.deps.workflowShadow && {
					shadowContext: { node: "implement", attempt: round + 1 },
				}),
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
		// FLY-1232 T6: the belt round-increment point is loop_iteration's SOLE
		// owner — the durable fix-round record just landed, mirror it (idempotent
		// by round, so a same-verdict replay after a crash never duplicates).
		this.deps.workflowShadow?.onKickback({
			projectName,
			issueId: session.issue_id,
			round,
		});
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
		// FLY-1224 (C8, probe-before-wake): a status-ALIVE row is not a
		// process-alive runner. A codex implement completes needs_review and its
		// process EXITS (transitional contract: no park loop) while the row stays
		// awaiting_review — the wake below is a mailbox JSON write that always
		// "succeeds", so waking the corpse patches fixExecId and permanently
		// short-circuits onQaResult's resume condition (the unreplayable stall).
		// Probe the real tmux process first; only a PROVEN-dead target falls
		// through to the spawn fallback (which dispatches this ticket's codex
		// backend). alive/indeterminate → the existing wake path, byte-unchanged.
		const implDead = impl ? await this.isWakeTargetProvenDead(impl) : false;
		if (impl && !implDead) {
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
				sourceEventId: `turn:qa-fail:${verdictEventId}:${impl.execution_id}`,
			});
			const woke = await this.deps.effects.wakePhaseRunner({
				session: impl,
				kind: "fix",
				headSha,
				round,
				qaSummary,
			});
			// FLY-939 (G-A): fail-loud on a failed wake, and keep the verdict intent
			// REPLAYABLE. Only persist the fix binding on a SUCCESSFUL wake — a
			// premature `fixExecId` (the pre-FLY-939 behavior) permanently short-
			// circuits onQaResult's resume condition (`!existing.fixExecId`), so the
			// boot `reconcileQaVerdicts` replay could never retry the missed wake and
			// the pipeline stalled silently (543's respawn / today's dup runners were
			// the visible symptom of this class of silent stall). Do NOT patch
			// `fixExecId` and do NOT patch `alertedAt` on failure: the intent stays
			// `{fail, no fixExecId, no alertedAt}` so the reconcile sweep re-drives
			// this exact fix round (recordFixRound's insert-or-read returns the SAME
			// round, the head is re-read from the SAME committed tip) and re-wakes.
			if (woke.ok) {
				this.deps.qaVerdicts.patchIntent(execId, {
					fixExecId: impl.execution_id,
				});
				// FLY-1232 T3: fix wake = a new logical round on the SAME execution.
				// No edge event (the loop-back is loop_iteration's job) and no
				// ledger row (a wake is not a spawn side effect).
				this.deps.workflowShadow?.onWake({
					projectName,
					issueId: session.issue_id,
					executionId: impl.execution_id,
					node: "implement",
					attempt: round + 1,
				});
				this.log(
					`QA FAIL → WAKE implement fix round ${round} on ${session.issue_id} @ ${headSha.slice(0, 8)} (impl ${impl.execution_id})`,
				);
				await this.postFixThread(session, round, true);
			} else {
				await this.failClosed(
					impl,
					`QA FAIL fix wake failed for ${impl.execution_id}: ${woke.error ?? "?"} — TURN set; the fix round is held REPLAYABLE and the boot reconcile sweep will re-drive it (Lead may nudge the implement runner via tmux to unblock sooner). NOT spawning a duplicate implement.`,
				);
			}
			return;
		}

		// The implement phase died (no row, or FLY-1224: a proven-dead process
		// behind an alive-status row) → spawn a fresh Implement-fix (dispatcher
		// seam grants its TURN pre-launch). The QA session still parks (not
		// closed).
		// FLY-939 (G-C): but first ghost-probe — if a terminal-status implement row
		// still has a live tmux window, that IS the implement (a bypass flipped its
		// row to terminal); spawning would duplicate it + double-write branch B.
		// ghostGuard alerts + returns false; the intent stays REPLAYABLE (fixExecId
		// not patched) so a later reconcile retries once the pollution is cleared.
		if (!(await this.ghostGuard(session.issue_id, "implement"))) return;
		const fixLeadId = this.deps.resolveLeadId(session);
		if (fixLeadId === undefined) {
			this.warn(
				`resolveLeadId returned undefined for ${session.issue_id} — dispatching Implement-fix anyway, but its CommDB registration will be skipped (window will not auto-close)`,
			);
		}
		try {
			// FLY-1224: full {model, vendor, effort} triple from the phase table.
			const dispatch = resolvePhaseDispatch("implement");
			const res = await this.deps.startDispatcher.start({
				issueId: session.issue_id,
				projectName,
				leadId: fixLeadId,
				sessionRole: "implement",
				dispatchModel: dispatch.model,
				dispatchVendor: dispatch.vendor,
				...(dispatch.effort && { dispatchEffort: dispatch.effort }),
				startPoint: headSha,
				shareParentBranch: true,
				// FLY-887 R2: labels never outrank the phase table (see deps JSDoc).
				ignoreRunnerLabelSelection: true,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				phaseFixContext: { round, qaSummary },
				// FLY-1232 T2-shaped fix spawn: new logical round, NO edge — the
				// loop-back is loop_iteration's job (T3 symmetry).
				...(this.deps.workflowShadow && {
					shadowContext: { node: "implement", attempt: round + 1 },
				}),
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
	 * FLY-1050: `terminated` joins the terminal domain (967's silent strand),
	 * and a LIVE successor QA suppresses the alert — it owns the re-verify, so
	 * the pipeline tail is not stranded (no silent window: if the successor
	 * dies too, its own death re-enters the respawn/alert machinery).
	 */
	private async checkStrandedPass(executionId: string): Promise<void> {
		const row = this.deps.qaVerdicts.getSession(executionId);
		if (!row) return;
		if (!DEAD_QA_STATUSES.has(row.status)) return;
		const intent = this.deps.qaVerdicts.readIntent(executionId);
		if (!intent || intent.status !== "pass" || intent.alertedAt) return;
		const qid = row.review_question_id;
		if (qid && qid !== REVIEW_BINDING_UNBOUND) return; // real gate — normal ship path
		if (this.deps.getAlivePhaseSession(row.issue_id, "qa")) return; // live successor owns the re-verify
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
		// FLY-1224 (C8, probe-before-wake — second site): same decision as the
		// fix-wake site. A proven-dead target falls to the existing spawn path
		// below (ghostGuard still runs there); alive/indeterminate → the wake
		// path, byte-unchanged.
		const targetDead = target
			? await this.isWakeTargetProvenDead(target)
			: false;
		if (target && !targetDead) {
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
				sourceEventId: `turn:handoff:${prev.execution_id}:${next}:${target.execution_id}:${headSha}`,
			});
			const woke = await this.deps.effects.wakePhaseRunner({
				session: target,
				kind: "retest",
				headSha,
			});
			if (woke.ok) {
				// FLY-1232 T3b: a wake handoff traverses the SAME DAG edge a spawn
				// handoff would (R3#3) — edge + wake in one composite transaction;
				// no ledger row (a wake is not a spawn side effect).
				this.deps.workflowShadow?.onWake({
					projectName: prev.project_name as string,
					issueId: prev.issue_id,
					executionId: target.execution_id,
					node: next,
					attempt: this.deps.workflowShadow.currentAttempt(prev.issue_id),
					edge: { from: prev.session_role ?? "main", to: next },
				});
				this.log(
					`${prev.session_role} → ${next} WAKE on ${prev.issue_id} @ ${headSha.slice(0, 8)} (target ${target.execution_id})`,
				);
			} else {
				// FLY-939 (G-A): fail-loud, don't silently strand. The TURN already
				// points at the parked target, so the reconcile re-drive (re-firing
				// this same handoff) idempotently re-wakes it — but a silent warn hid
				// the stall until a human noticed a dead pipeline, so alert the Lead.
				await this.failClosed(
					target,
					`${prev.session_role} → ${next} wake failed for ${target.execution_id}: ${woke.error ?? "?"} — TURN set (points at the parked ${next}); the handoff is held for reconcile re-drive (Lead may nudge the ${next} runner via tmux). NOT spawning a duplicate ${next}.`,
				);
			}
			return;
		}

		// No live next phase (or FLY-1224: a proven-dead process behind an
		// alive-status row) → SPAWN it (dispatcher pre-launch seam grants its TURN).
		// FLY-939 (G-C): before spawning, ghost-probe — a terminal-status row with a
		// live tmux window means a bypass polluted the state; spawning would create a
		// duplicate + second writer. Fail-closed: ghostGuard alerts + returns false.
		if (!(await this.ghostGuard(prev.issue_id, next))) return;
		await this.dispatchNextPhase(prev, next, headSha);
	}

	/**
	 * FLY-1224 (C8): is this wake target's PROCESS provably dead? Graded dead
	 * verdict (R1 #2 + R2 #1):
	 *   - `alive` / `indeterminate` → NOT dead (indeterminate is fail-closed:
	 *     never treat a maybe-alive context holder as dead — existing stance);
	 *   - `dead_pin` → dead unconditionally (a confirmed remain-on-exit corpse);
	 *   - `absent` → `probePhaseAlive` goes through the CommDB registration
	 *     lookup, which FOLDS "registration gone" AND "CommDB read error" into
	 *     absent — unfalsifiable on its own (authorizing a spawn inside a CommDB
	 *     lock/corruption window could double-write branch B). Only a DIRECT
	 *     probe of the row's PERSISTED tmux target (`probeGhostTmux`, which
	 *     bypasses the CommDB lookup) may confirm death; a row with no persisted
	 *     target keeps the existing wake path (fail-closed).
	 * NOTE: the ghostGuard inside the spawn fallback is NOT a substitute for
	 * this in-place direct probe — it re-queries listPhaseSessionRows (a throw
	 * there ALLOWS the spawn) and only probes the newest few rows, so it does
	 * not guarantee THIS row was probed (R2 #1).
	 * The dead path executes NO assertPhaseWorktreeReady, NO grantTurn, NO wake
	 * — the spawn fallback's TURN comes from the dispatcher pre-launch seam.
	 */
	private async isWakeTargetProvenDead(row: PhaseSession): Promise<boolean> {
		const liveness = await this.deps.effects.probePhaseAlive(row);
		if (liveness === "dead_pin") return true;
		if (liveness !== "absent") return false; // alive / indeterminate → wake path
		if (!row.tmux_session) return false; // no persisted target → unfalsifiable
		const direct = await this.deps.effects.probeGhostTmux(row);
		return direct === "dead_pin" || direct === "absent";
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
			// FLY-1224: full {model, vendor, effort} triple from the phase table.
			const dispatch = resolvePhaseDispatch(next);
			const res = await this.deps.startDispatcher.start({
				issueId: prev.issue_id,
				projectName: prev.project_name as string,
				leadId,
				sessionRole: next,
				dispatchModel: dispatch.model,
				dispatchVendor: dispatch.vendor,
				...(dispatch.effort && { dispatchEffort: dispatch.effort }),
				startPoint: headSha,
				shareParentBranch: true,
				// FLY-887 R2: labels never outrank the phase table (see deps JSDoc).
				ignoreRunnerLabelSelection: true,
				issueIdentifier: prev.issue_identifier,
				issueTitle: prev.issue_title,
				// FLY-1232 T2/T7: SEMANTIC shadow context only (node/attempt/edge —
				// never an ordinal). A first start and a same-attempt replacement
				// (T7, reconcileQaLoss re-drive) carry the SAME attempt; the writer
				// separates physical launches by allocating the ordinal itself.
				...(this.deps.workflowShadow && {
					shadowContext: {
						node: next,
						attempt: this.deps.workflowShadow.currentAttempt(prev.issue_id),
						edge: { from: prev.session_role ?? "main", to: next },
					},
				}),
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

	/**
	 * FLY-921 Fix C: turn-belt stale-holder reconcile. FLY-543 shape: the TURN
	 * holder's process is dead (killed / crashed) but the epoch lock never
	 * releases, so the surviving parked phase polls `turn` forever getting
	 * `not-yours`. Detect a stale holder and re-grant the TURN to the most
	 * downstream probed-ALIVE phase (qa → implement → design), or release it.
	 *
	 * Scoped (event-driven) form: guard 1 — only act when the just-terminal
	 * exec IS the holder ("the dead one is the holder himself"). A handoff that
	 * already moved the TURN to a freshly-spawned next phase (whose session row
	 * is still in flight — Blueprint's emitStarted is fire-and-forget) must
	 * never have its grant stolen back (Codex R2 #1).
	 *
	 * Unscoped (startup) form: full table scan across projects; guard 2 — a
	 * missing-row holder inside TURN_GRANT_GRACE_MS reads as indeterminate.
	 *
	 * Fail-closed everywhere: indeterminate liveness (holder OR candidate)
	 * never moves the TURN and never alerts (next round re-checks).
	 */
	async reconcileTurnBelt(scope?: {
		issueId: string;
		projectName: string;
		terminalExecId?: string;
	}): Promise<void> {
		if (scope) {
			let turn: TurnBeltRow | null;
			try {
				turn = this.deps.turnBelt.getTurn(scope.issueId, scope.projectName);
			} catch (err) {
				this.warn(
					`reconcileTurnBelt getTurn failed for ${scope.issueId}: ${(err as Error).message}`,
				);
				return;
			}
			if (!turn) return;
			// Guard 1: event position only handles "the dead one IS the holder".
			if (
				scope.terminalExecId &&
				turn.holder_exec_id !== scope.terminalExecId
			) {
				return;
			}
			await this.reconcileOneTurn(scope.projectName, turn);
			return;
		}

		let rows: { projectName: string; turn: TurnBeltRow }[];
		try {
			rows = this.deps.turnBelt.listTurns();
		} catch (err) {
			this.warn(
				`reconcileTurnBelt listTurns failed: ${(err as Error).message}`,
			);
			return;
		}
		for (const { projectName, turn } of rows) {
			try {
				await this.reconcileOneTurn(projectName, turn);
			} catch (err) {
				this.warn(
					`reconcileTurnBelt failed for ${turn.issue_id}: ${(err as Error).message}`,
				);
			}
		}
	}

	/** Stale determination + recovery for one project-attributed TURN row. */
	private async reconcileOneTurn(
		projectName: string,
		turn: TurnBeltRow,
	): Promise<void> {
		const holder = this.deps.turnBelt.getSessionForTurnHolder(
			turn.holder_exec_id,
		);
		let staleReason: string;
		if (!holder) {
			// Guard 2: pre-launch grant precedes the fire-and-forget session row —
			// inside the grace window this is an in-flight spawn, not a remnant.
			const ageMs = Date.now() - turn.granted_at;
			if (ageMs < TURN_GRANT_GRACE_MS) return;
			staleReason = `holder session row missing (granted ${Math.round(ageMs / 1000)}s ago — dispatch remnant)`;
		} else if (TERMINAL_SESSION_STATUS.has(holder.status)) {
			// FLY-921 (Codex code review R1 HIGH): a QA holder that reached a
			// GRACEFUL `completed` is the pipeline legitimately finishing — an
			// approved ship (post-ship finalization deletes the TURN moments
			// later, from the event sink's `pending` queue) or a FLY-859
			// stranded-pass (which raises its own alert). It is NOT the FLY-543
			// killed shape (`failed`). Reconciling it would re-grant the TURN to
			// a still-parked upstream phase + fire a false STALE-TURN Lead alert
			// on EVERY successful three-stage ship — and there is no useful phase
			// to recover to. Leave it to the finalization/handoff lifecycle. Only
			// `failed` holders (killed / crashed — the actual FLY-543 shape) and
			// completed NON-qa holders (a phase that finished while still holding
			// the TURN because its handoff never ran — a genuine stuck state)
			// stay stale-eligible.
			const holderRole = holder.chat_thread_role ?? holder.session_role;
			if (holder.status === "completed" && holderRole === "qa") {
				return;
			}
			staleReason = `holder session is terminal (${holder.status})`;
		} else {
			const liveness = await this.deps.effects.probePhaseAlive(holder);
			if (liveness === "alive") return; // healthy
			if (liveness === "indeterminate") return; // fail-closed, no alert
			staleReason = `holder process ${liveness}`;
		}

		// Recovery: most-downstream probed-ALIVE phase, EXCLUDING the stale
		// holder itself (a status-only selector would re-pick a non-terminal dead
		// holder and strand the TURN on it forever — Codex R1 #2).
		const candidates = this.deps.turnBelt
			.getPhaseSessionsForIssue(turn.issue_id)
			.filter(
				(s) =>
					s.execution_id !== turn.holder_exec_id &&
					!TERMINAL_SESSION_STATUS.has(s.status),
			);
		for (const phase of TURN_RECOVERY_PRIORITY) {
			for (const cand of candidates.filter(
				(c) => (c.chat_thread_role ?? c.session_role) === phase,
			)) {
				const liveness = await this.deps.effects.probePhaseAlive(cand);
				if (liveness === "indeterminate") {
					// Never change ownership while a candidate's liveness is unknown.
					this.warn(
						`reconcileTurnBelt: candidate ${cand.execution_id} liveness indeterminate on ${turn.issue_id} — leaving TURN untouched this round`,
					);
					return;
				}
				if (liveness !== "alive") continue; // dead_pin / absent → next candidate
				this.deps.grantTurn({
					issueId: turn.issue_id,
					execId: cand.execution_id,
					phase,
					projectName,
					sourceEventId: `turn:recovery:${turn.issue_id}:${turn.holder_exec_id}:${turn.epoch}:${cand.execution_id}`,
				});
				await this.failClosed(
					cand,
					`turn-belt recovered a STALE TURN on ${turn.issue_id}: ${staleReason}; holder ${turn.holder_exec_id} (epoch ${turn.epoch}) → ${cand.execution_id} (${phase}, epoch ${turn.epoch + 1}). The parked ${phase} phase can now re-acquire the worktree turn.`,
				);
				return;
			}
		}

		// No live phase to hand the TURN to — release it; a future spawn's
		// pre-launch seam (or post-ship cleanup) rebuilds it.
		this.deps.turnBelt.deleteTurn(turn.issue_id, projectName);
		await this.failClosed(
			holder ?? {
				execution_id: turn.holder_exec_id,
				issue_id: turn.issue_id,
				project_name: projectName,
				status: "unknown",
			},
			`turn-belt: STALE TURN on ${turn.issue_id} (${staleReason}; holder ${turn.holder_exec_id}, epoch ${turn.epoch}) had NO live phase to recover to — TURN released; the next spawn's pre-launch seam re-creates it.`,
		);
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
