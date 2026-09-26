/**
 * FLY-907 Step 1: unified issue-display derivation (pure functions, zero I/O).
 *
 * The three founder-facing display faces of a `[FLY-XX]` issue thread —
 *   A. the thread-title status badge,
 *   B. the pinned pipeline header (FLY-892),
 *   C. the three-stage status line (FLY-887)
 * — previously each derived their own notion of "phase state" (B had a 3-state
 * table keyed on HEADER_DONE_STATUSES; C had a 4-state table keyed on raw
 * status) and refreshed ONLY on `stage_changed`. FLY-907 replaces both with
 * THIS single state machine so the faces can never contradict each other, and
 * makes every lifecycle event (park/wake/kill/finalize/…) a mere TRIGGER for a
 * derive-from-真实状态 refresh (issue-display-refresher.ts owns the I/O).
 */

import {
	PHASE_THREAD_BADGE,
	THREE_STAGE_PHASE_SEQUENCE,
	type ThreeStagePhase,
} from "flywheel-config";

/** Unified per-phase founder display state (plan 1a). */
export type PhaseDisplayState = "pending" | "active" | "done" | "blocked";

/**
 * Tri-state CommDB park probe. "unknown" = CommDB missing / table missing /
 * read error / keep-alive OFF — the derivation must NEVER read "couldn't
 * probe" as "was explicitly woken" (Codex R1 #2): only an explicit
 * `not_parked` (a readable CommDB whose park marker is absent — i.e. cleared
 * by a wake, or never set under keep-alive ON) flips a handoff-boundary
 * status back to ▶ active.
 */
export type ParkProbe = "parked" | "not_parked" | "unknown";

export interface PhaseDisplayInput {
	role: ThreeStagePhase;
	/** The phase's latest session status; undefined = no session row yet. */
	status?: string;
	park: ParkProbe;
}

/**
 * Outcome contract of one display-face write (plan Step 2, Codex R2 #2).
 * The existing writers are best-effort/swallow-errors by design; the unified
 * refresher needs to know whether a face actually reached Discord before it
 * may persist the reconcile fingerprint:
 *   - "changed"  — a write landed;
 *   - "noop"     — already up to date (zero-churn skip);
 *   - "deferred" — could not attempt yet (429 retries exhausted, tmux target
 *                  unresolved, thread missing, reconnecting-guard) — retry via sweep;
 *   - "failed"   — an attempted write failed.
 * Only changed/noop across every enabled face lets the fingerprint persist.
 */
export type DisplayWriteResult = "changed" | "noop" | "deferred" | "failed";

/** True terminal-done statuses — NEVER park-sensitive (post-ship finalization
 * leaves completed phases with no park marker; they must not flip back). */
const PHASE_DONE_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"merged",
]);

/** Handoff-boundary statuses — the ONLY park/wake-sensitive states (FLY-543:
 * a woken rework session sits at one of these with its park marker cleared). */
const PHASE_BOUNDARY_STATUSES: ReadonlySet<string> = new Set([
	"design_done",
	"awaiting_review",
	"approved_to_ship",
]);

const PHASE_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
	"failed",
	"terminated",
	"blocked",
	"rejected",
]);

/**
 * Plan 1a mapping table (Codex R1 #2 corrected version) — every row is pinned
 * by issue-display.test.ts:
 *
 * | input                                                | state   |
 * |------------------------------------------------------|---------|
 * | no session                                           | pending |
 * | completed / merged (unconditionally)                 | done    |
 * | failed / terminated / blocked / rejected             | blocked |
 * | park === "parked" (explicit marker, any live status) | done    |
 * | boundary status + park === "unknown"                 | done    |
 * | boundary status + park === "not_parked" (FLY-543)    | active  |
 * | running / anything else with a session               | active  |
 *
 * The explicit-park row covers the QA phase's keep-alive shape: a QA runner
 * that emitted its verdict parks with status still `running` (only a ship-gate
 * `complete` moves it to awaiting_review) — its work for this round is at a
 * boundary, so it renders ✅, and the title correctly falls back to the woken
 * implement (plan Step 5: "qa FAIL → 标题回 🔨实现, QA 不抢 badge"). A wake
 * clears the marker → not_parked → back to ▶ (FLY-543).
 */
export function derivePhaseDisplayState(
	p: PhaseDisplayInput,
): PhaseDisplayState {
	if (!p.status) return "pending";
	if (PHASE_DONE_STATUSES.has(p.status)) return "done";
	if (PHASE_BLOCKED_STATUSES.has(p.status)) return "blocked";
	// An explicit park marker = the runner itself declared "this round's work
	// is handed off" — regardless of which live status it parks at.
	if (p.park === "parked") return "done";
	if (PHASE_BOUNDARY_STATUSES.has(p.status)) {
		return p.park === "not_parked" ? "active" : "done";
	}
	// Conservative: a session exists and is in no terminal/boundary state — it
	// is working (covers `running` and any future/unknown status).
	return "active";
}

/** Issue-level thread-title badge aggregate (plan 1b). */
export type IssueTitleBadge =
	| { kind: "stage"; stage?: string }
	| { kind: "phase"; phase: ThreeStagePhase }
	| { kind: "blocked" }
	| { kind: "completed" };

/** Main-session statuses that render the cross-cutting 🔴受阻 title badge. */
const MAIN_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
	"failed",
	"terminated",
	"blocked",
]);

/**
 * Plan 1b: aggregate the issue's title badge from real state.
 *
 * `phaseStates` holds ONLY phases that have a session row (存在的 phase);
 * an empty map = a non-three-stage issue → the existing single-session
 * formula (session_stage badge; terminal statuses map to blocked/completed).
 * The single-session `stage` output at a stage_changed moment is byte-identical
 * to the pre-FLY-907 behavior (sentinel-tested); kill/finalize moments are NEW
 * refreshes (the old code simply never refreshed there).
 */
export function deriveIssueTitleBadge(args: {
	phaseStates: ReadonlyMap<ThreeStagePhase, PhaseDisplayState>;
	/** Raw per-phase session status. Display-state `done` also means a phase
	 * handed off at the ship gate, so issue-level completion must inspect the
	 * recorded status before presenting ✅. */
	phaseStatuses: ReadonlyMap<ThreeStagePhase, string>;
	/** Durable evidence that a validated post-ship finalization flow claimed
	 * this issue. This covers the short window before stale phase rows are
	 * converted from awaiting_review to a terminal status. */
	shipFinalizationClaimed: boolean;
	mainSessionStage?: string;
	mainSessionStatus?: string;
}): IssueTitleBadge {
	const { phaseStates } = args;
	if (phaseStates.size === 0) {
		const status = args.mainSessionStatus;
		if (status && MAIN_BLOCKED_STATUSES.has(status)) return { kind: "blocked" };
		if (status === "completed") return { kind: "completed" };
		// A runner-reported stage is a label, while status is the durable fact.
		// Do not let a prematurely reported `completed` label impersonate ship.
		if (args.mainSessionStage === "completed") {
			if (status === "awaiting_review") {
				return { kind: "stage", stage: "approve" };
			}
			if (status === "approved_to_ship") {
				return { kind: "stage", stage: "ship" };
			}
		}
		return { kind: "stage", stage: args.mainSessionStage };
	}

	for (const phase of THREE_STAGE_PHASE_SEQUENCE) {
		if (phaseStates.get(phase) === "blocked") return { kind: "blocked" };
	}

	const allExistingDone = [...phaseStates.values()].every((s) => s === "done");
	const lastPhase =
		THREE_STAGE_PHASE_SEQUENCE[THREE_STAGE_PHASE_SEQUENCE.length - 1]!;
	if (allExistingDone && phaseStates.get(lastPhase) === "done") {
		// Per-phase display `done` means "this phase handed off" and therefore
		// includes parked ship-gate rows. Issue-level ✅ requires positive ship
		// evidence: a validated finalization claim or terminal rows throughout.
		if (args.shipFinalizationClaimed) return { kind: "completed" };
		const statuses = [...args.phaseStatuses.values()];
		if (statuses.includes("approved_to_ship")) {
			return { kind: "stage", stage: "ship" };
		}
		if (statuses.includes("awaiting_review")) {
			return { kind: "stage", stage: "approve" };
		}
		if (statuses.every((status) => PHASE_DONE_STATUSES.has(status))) {
			return { kind: "completed" };
		}
		// Otherwise fall through to the conservative phase badge below. Parked
		// running rows without a positive ship fact are not issue completion.
	}

	// The LAST active phase in the sequence wins (FLY-543: a woken rework
	// implement flips the title back to 🔨实现, never a premature ✅).
	for (let i = THREE_STAGE_PHASE_SEQUENCE.length - 1; i >= 0; i--) {
		const phase = THREE_STAGE_PHASE_SEQUENCE[i]!;
		if (phaseStates.get(phase) === "active") return { kind: "phase", phase };
	}

	// No active phase (handoff gap): the phase BEFORE the first pending one
	// (absent-from-map = pending); all-pending degenerates to the first phase.
	for (let i = 0; i < THREE_STAGE_PHASE_SEQUENCE.length; i++) {
		const phase = THREE_STAGE_PHASE_SEQUENCE[i]!;
		if ((phaseStates.get(phase) ?? "pending") === "pending") {
			return {
				kind: "phase",
				phase: THREE_STAGE_PHASE_SEQUENCE[Math.max(0, i - 1)]!,
			};
		}
	}
	return { kind: "phase", phase: lastPhase };
}

/**
 * Plan 1c: the SINGLE display vocabulary both face B (pipeline header) and
 * face C (status line) render from — Annie's locked glyphs (2026-07-06):
 * done = green ✅ (never white/pale ⬜🤍), active = ▶, pending = dark-grey ◾
 * (single-line constant — swap candidates 🩶/⚫ here), blocked = 🔴.
 */
export const PHASE_DISPLAY_GLYPH_PARTS: Readonly<
	Record<PhaseDisplayState, { symbol: string; label: string }>
> = {
	done: { symbol: "✅", label: "完成" },
	active: { symbol: "▶", label: "进行中" },
	pending: { symbol: "◾", label: "未开始" },
	blocked: { symbol: "🔴", label: "受阻" },
};

/** Composed `symbol + label` badge per state (face B row vocabulary). */
export const PHASE_DISPLAY_GLYPHS: Readonly<Record<PhaseDisplayState, string>> =
	{
		done: `${PHASE_DISPLAY_GLYPH_PARTS.done.symbol} ${PHASE_DISPLAY_GLYPH_PARTS.done.label}`,
		active: `${PHASE_DISPLAY_GLYPH_PARTS.active.symbol} ${PHASE_DISPLAY_GLYPH_PARTS.active.label}`,
		pending: `${PHASE_DISPLAY_GLYPH_PARTS.pending.symbol} ${PHASE_DISPLAY_GLYPH_PARTS.pending.label}`,
		blocked: `${PHASE_DISPLAY_GLYPH_PARTS.blocked.symbol} ${PHASE_DISPLAY_GLYPH_PARTS.blocked.label}`,
	};

/**
 * Face C render (replaces phase-orchestrator's `renderPhaseStatusLine` + its
 * local PHASE_LINE_ORDER copy): `🎨设计✅·🔨实现▶·🧪QA◾`. Order derives from
 * THREE_STAGE_PHASE_SEQUENCE so FLY-905's 3→2 re-sequencing follows for free.
 */
export function renderPhaseStatusLine(
	states: Readonly<Record<ThreeStagePhase, PhaseDisplayState>>,
): string {
	return THREE_STAGE_PHASE_SEQUENCE.map(
		(phase) =>
			`${PHASE_THREAD_BADGE[phase]}${PHASE_DISPLAY_GLYPH_PARTS[states[phase]].symbol}`,
	).join("·");
}
