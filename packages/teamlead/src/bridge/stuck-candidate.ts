/**
 * FLY-195: Stuck-runner candidate detection (Bridge-side, pure logic).
 *
 * Design (set by Annie's brainstorm): the Bridge does NOT act on a stuck Runner.
 * It only DETECTS a *candidate* stuck Runner — patiently, by time + status — and
 * hands it (with evidence) to the owning Lead, which (being an LLM with terminal
 * tools) judges and re-manages. See
 * doc/engineer/plan/new/v1.31.0-FLY-195-stuck-runner-lead-remanage.md.
 *
 * This module is intentionally PURE (no I/O): the caller injects the status,
 * captured terminal output, and the two "legitimately parked" predicates
 * (pending gate / pending review signal). That keeps it decoupled from the
 * pending shared disposition API (FLY-191) and from LeadAlertNotifier (FLY-193),
 * and makes the safety boundary fully unit-testable.
 *
 * Scope (Codex R1 LOW-6): this is a STAGNANT-OUTPUT candidate detector. It
 * reliably catches the GEO-397 class (loop stopped at the input box) and most
 * prompt stalls. It will MISS stuck causes whose terminal output keeps changing
 * (e.g. a retry loop spewing logs, an animated spinner) — those are out of scope
 * for this pass. The Lead is the precision filter on top.
 */

import { createHash } from "node:crypto";
import {
	type ErrorSignatureHit,
	scanErrorSignatures,
} from "./error-signatures.js";

/** Patient threshold: output unchanged this long ⇒ candidate. Default 10 min. */
export const STUCK_THRESHOLD_MS = 600_000;

/** Default number of trailing non-empty lines to keep as evidence. */
const DEFAULT_TAIL_LINES = 15;

/**
 * Session statuses that are NEVER stuck candidates.
 *
 * `awaiting_review` / `approved_to_ship` are the FLY-191 "idle-but-reachable"
 * states: a Runner parked there is legitimately waiting for a human, NOT stuck.
 * Only `running` is eligible. Anything else (pending/completed/failed/…) is also
 * excluded — a stuck Runner is by definition mid-work.
 */
export function isStuckEligibleStatus(status: string): boolean {
	return status === "running";
}

/** Reason a session was NOT flagged as a stuck candidate (for logging/audit). */
export type StuckExclusionReason =
	| "not_running"
	| "parked_review_status" // awaiting_review / approved_to_ship (FLY-191)
	| "pending_gate" // unanswered gate question in CommDB
	| "recent_comm_activity" // FLY-253 L1: runner messaged its Lead recently (alive)
	| "pending_review_signal" // gray zone: needs_review emitted, status not yet flipped
	| "output_changing" // output changed since last poll (no stagnation yet)
	| "below_threshold" // stagnant but < threshold
	| "already_escalated"; // this episode was already escalated (dedup)

/** Evidence attached to a stuck escalation to help the Lead judge fast. */
export interface StuckEvidence {
	/** Whole minutes the output has been unchanged. */
	stuck_minutes: number;
	/** Trailing non-empty lines of the captured terminal. */
	tail: string;
	/**
	 * Strict canonical stream-idle-timeout signature present in the tail.
	 * EVIDENCE ONLY — never a hard trigger (a stale error can linger; the hard
	 * gates are status + pending-gate exclusion). Codex R1 HIGH-2/MEDIUM-3.
	 */
	stream_error_signature: boolean;
	/**
	 * Claude interactive input box appears at the bottom (idle-at-prompt).
	 * EVIDENCE ONLY. Regex is a best-effort placeholder; the real-tmux spike
	 * (plan §5) pins it for the installed Claude Code version (FLY-169 lesson).
	 */
	input_box_present: boolean;
	/**
	 * FLY-1048 (A3): the error-signature KIND (error-signatures.ts) that drove
	 * or accompanied this candidate — lets the escalation wording tell the
	 * truth ("Not logged in" vs a generic freeze). Additive; absent on
	 * candidates with no known error string. NEVER the raw matched line
	 * (echo immunity, FLY-220).
	 */
	errorSignature?: string;
}

/**
 * Per-(execution) stuck episode. An "episode" is one continuous stagnation of
 * the same terminal output. It ends when output changes (progress) or the
 * session leaves `running`.
 */
export interface StuckEpisodeState {
	/** Fingerprint of the stagnant output that defines this episode. */
	fingerprint: string;
	/** Wall-clock (ms) when this output first appeared / last changed. */
	firstStagnantAt: number;
	/** Whether a stuck escalation has already been emitted for this episode. */
	escalated: boolean;
	/**
	 * Wall-clock (ms) when the escalation was emitted (or suppressed because a
	 * persisted disposition already judged this episode). Anchors the Q7
	 * fallback grace window (plan §3.6). Set by the detector layer, preserved
	 * here while the episode continues.
	 */
	escalatedAt?: number;
	/**
	 * FLY-927 (W-B): the stagnant pane carries 529/overloaded throttle residue
	 * with NO live line-level retry — a runner genuinely STALLED after a
	 * throttle. Refines the Q7 alert kind to `runner_throttle_stalled` (the
	 * ticket owner bot can ARC it); a healthy 529 (still retrying) never sets
	 * this. Computed at candidate time from the same capture.
	 */
	throttleStalled?: boolean;
	/**
	 * True once the Q7 fallback has resolved for this episode — either Annie
	 * was alerted (runner_stuck_unhandled) or a Lead disposition terminally
	 * suppressed the alert. One Annie alert per episode (Codex R1 MEDIUM-5).
	 */
	annieAlerted?: boolean;
	/**
	 * FLY-1048 (A3, env-gated): the normalized error signature currently being
	 * tracked in the evidence tail. While set, the episode `fingerprint` is
	 * PINNED to `sig:<hash(errorSig)>` — stable across churning full-text
	 * fingerprints — so Lead dispositions and the Q7 grace window key
	 * consistently on a rolling-error episode.
	 */
	errorSig?: string;
	/** Wall-clock (ms) when the tracked signature was first seen in the tail. */
	firstErrorSigAt?: number;
}

export interface StuckCandidateInput {
	status: string;
	/** Raw captured terminal output (e.g. tmux capture-pane -p). */
	output: string;
	/** Injectable clock for tests. */
	now: number;
	/** Prior episode state for this execution (undefined on first sighting). */
	prior?: StuckEpisodeState;
	/** True if CommDB has an unanswered gate question from this execution. */
	hasPendingGate: boolean;
	/**
	 * FLY-253 L1: true if this execution sent ANY CommDB message within the
	 * activity window (default 30 min). A runner that recently messaged its
	 * Lead (DONE report / instruction receipt / question) is mechanically
	 * alive, however static its pane looks — the pane is a rendering, CommDB
	 * is behavior (LEARN-57: a parked interactive runner's real liveness
	 * channel was CommDB; the detector only watched the pane). Optional for
	 * byte-compat: absent ⇒ false ⇒ pre-FLY-253 behavior.
	 */
	hasRecentCommActivity?: boolean;
	/**
	 * True if there is durable evidence the Runner just finished and is awaiting
	 * review even though the status row hasn't flipped yet (gray zone). Caller
	 * derives from decision_route / recent session_completed(route=needs_review).
	 * Codex R1 MEDIUM-3.
	 */
	hasPendingReviewSignal: boolean;
	/** Override the stagnation threshold (default STUCK_THRESHOLD_MS). */
	thresholdMs?: number;
	/** Override trailing line count for evidence. */
	tailLines?: number;
}

export interface StuckCandidateResult {
	/** True ⇒ emit a runner_stuck_escalation for this execution now. */
	candidate: boolean;
	/** Populated when candidate is false. */
	exclusion?: StuckExclusionReason;
	/**
	 * Updated episode state to persist for the next poll. `null` means "clear any
	 * stored episode for this execution" (session no longer a candidate context).
	 */
	episode: StuckEpisodeState | null;
	/** Populated only when candidate is true. */
	evidence?: StuckEvidence;
}

/** SHA-256 (first 16 hex) of the captured output — the episode key. */
export function fingerprintOutput(output: string): string {
	return createHash("sha256").update(output).digest("hex").slice(0, 16);
}

/**
 * Strict canonical stream-idle-timeout signature (Codex R1 HIGH-2).
 *
 * Requires `API Error:` AND `Stream idle timeout` on the SAME line, matching the
 * real Claude error `API Error: Stream idle timeout - partial response received`.
 * Deliberately does NOT match a bare `partial response received` (appears in
 * prose/logs) nor a bare `API Error:`.
 */
export function detectStreamErrorSignature(output: string): boolean {
	const line = /API Error:.*Stream idle timeout/i;
	for (const raw of output.split("\n")) {
		if (line.test(raw)) return true;
	}
	return false;
}

/**
 * Detection of Claude Code's interactive input box at the bottom of a pane.
 *
 * Pinned against the REAL committed pane fixtures from FLY-193
 * (`packages/teamlead/src/__tests__/fixtures/lead-panes/`) — actual production
 * captures of the Claude Code TUI (FLY-169 lesson: never trust an assumed
 * rendering). The current TUI renders:
 *
 *     ───────────────...──────── @agent ──     ← box-top rule
 *     ❯                                         ← prompt (U+276F)
 *     ──────────────────...──────────────       ← box-bottom rule
 *     Opus 4.8/xhigh | ⚡agent | ... | ctx 11%  ← status bar
 *     ⏵⏵ bypass permissions on (shift+tab ...)
 *
 * Older TUI versions boxed the prompt as `│ > │` inside `╭─╮/╰─╯` corners —
 * both renderings are accepted. The prompt sits ABOVE the multi-line status
 * bar, so the scan window is the last 10 non-empty lines (a 4-line window
 * misses it — caught by the real fixtures).
 *
 * Used as EVIDENCE in the escalation payload AND as one of the hard gates of
 * the restricted recovery-nudge endpoint (plan §3.5): a nudge is only sent
 * into a frame that visibly shows an idle input box.
 */
export function detectInputBoxPresent(output: string): boolean {
	const tail = output
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.slice(-10);
	// Prompt line: current TUI `❯` at line start, or legacy boxed `│ > `,
	// or a bare `> ` prompt. With or without typed text after it.
	const promptLine = /^\s*(❯|>\s|[│|]\s*>\s?)/;
	// Box rule: a long run of `─` (current TUI) or rounded corners (legacy).
	const boxBorder = /(─{8,}|[╭╰╮╯]─*)/;
	const hasPrompt = tail.some((l) => promptLine.test(l));
	const hasBorder = tail.some((l) => boxBorder.test(l));
	return hasPrompt && hasBorder;
}

/** Extract trailing non-empty lines as evidence. */
function extractTail(output: string, lines: number): string {
	return output
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.slice(-lines)
		.join("\n");
}

/**
 * Decide whether a session is a stuck candidate this poll, and advance the
 * per-execution episode state.
 *
 * Hard safety gates (in order), any of which excludes (and clears the episode):
 *   1. status !== "running"               → not_running / parked_review_status
 *   2. hasPendingGate                     → pending_gate
 *   2.5 hasRecentCommActivity (FLY-253)   → recent_comm_activity
 *   3. hasPendingReviewSignal (gray zone) → pending_review_signal
 * Then stagnation tracking:
 *   4. output changed / first sighting    → start a fresh episode, output_changing
 *   5. stagnant < threshold               → below_threshold
 *   6. stagnant ≥ threshold, not yet escalated → CANDIDATE (mark escalated)
 *   7. stagnant ≥ threshold, already escalated → already_escalated (dedup)
 */
export function evaluateStuckCandidate(
	input: StuckCandidateInput,
): StuckCandidateResult {
	const thresholdMs = input.thresholdMs ?? STUCK_THRESHOLD_MS;
	const tailLines = input.tailLines ?? DEFAULT_TAIL_LINES;

	// Gate 1: status — clears episode (session not in a stuck-eligible context).
	if (!isStuckEligibleStatus(input.status)) {
		const exclusion: StuckExclusionReason =
			input.status === "awaiting_review" || input.status === "approved_to_ship"
				? "parked_review_status"
				: "not_running";
		return { candidate: false, exclusion, episode: null };
	}

	// Gate 2: legitimately parked at a gate.
	if (input.hasPendingGate) {
		return { candidate: false, exclusion: "pending_gate", episode: null };
	}

	// Gate 2.5 (FLY-253 L1): recent CommDB outbound activity ⇒ alive. Clears
	// the episode INCLUDING an already-escalated one — intentional semantics:
	// the runner messaging its Lead refutes the stuck condition that justified
	// the escalation, so a pending Q7 grace dies with the episode (never page
	// Annie about a runner that just talked to its Lead). Worst-case detection
	// delay for a runner that freezes right after its last message: activity
	// window + threshold (+ grace for Q7) — a delay, not a miss.
	if (input.hasRecentCommActivity) {
		return {
			candidate: false,
			exclusion: "recent_comm_activity",
			episode: null,
		};
	}

	// Gate 3: gray zone — needs_review emitted but status row not yet flipped.
	if (input.hasPendingReviewSignal) {
		return {
			candidate: false,
			exclusion: "pending_review_signal",
			episode: null,
		};
	}

	// FLY-1048 (A3, env-gated): repeated-error-signature path. A retry loop
	// keeps CHANGING the pane text, so the fingerprint stagnation clock below
	// resets every poll and never fires (the module-header documented MISS).
	// When a known error signature appears in the evidence TAIL (tail-scoped so
	// a stale error line high in scrollback never counts — FP3), the episode is
	// tracked by NORMALIZED SIGNATURE instead, with the episode fingerprint
	// pinned to the signature so Lead dispositions + the Q7 grace window key
	// stably across churning text. Runs AFTER the hard safety gates.
	// FLY-1243: FLYWHEEL_STUCK_ERRORSIG retired (固化 default-on) — the
	// repeated-error-signature path always runs.
	const tailHits = scanErrorSignatures(extractTail(input.output, tailLines));
	if (tailHits.length > 0) {
		return evaluateErrorSignatureEpisode(
			input,
			tailHits,
			thresholdMs,
			tailLines,
		);
	}
	// No signature in the tail → legacy fingerprint flow below; fresh
	// episodes never copy sig-tracking fields, so tracking resets naturally.

	// Stagnation tracking.
	const fp = fingerprintOutput(input.output);
	const sameOutput = input.prior?.fingerprint === fp;

	if (!sameOutput) {
		// Output changed (progress) or first sighting → fresh episode.
		return {
			candidate: false,
			exclusion: "output_changing",
			episode: {
				fingerprint: fp,
				firstStagnantAt: input.now,
				escalated: false,
			},
		};
	}

	// Same output as last poll: episode continues. Spread preserves the
	// detector-layer fields (escalatedAt / annieAlerted) across polls.
	const episode: StuckEpisodeState = { ...input.prior! };
	const stagnantMs = input.now - episode.firstStagnantAt;

	if (stagnantMs < thresholdMs) {
		return { candidate: false, exclusion: "below_threshold", episode };
	}

	if (episode.escalated) {
		// Already escalated this episode — dedup, no re-emit.
		return { candidate: false, exclusion: "already_escalated", episode };
	}

	// Threshold crossed and not yet escalated → CANDIDATE.
	const evidence: StuckEvidence = {
		stuck_minutes: Math.floor(stagnantMs / 60_000),
		tail: extractTail(input.output, tailLines),
		stream_error_signature: detectStreamErrorSignature(input.output),
		input_box_present: detectInputBoxPresent(input.output),
	};
	return {
		candidate: true,
		episode: {
			...episode,
			escalated: true,
			// FLY-927 (W-B): classify the stall flavor from the SAME capture.
			throttleStalled: detectThrottleStall(input.output),
		},
		evidence,
	};
}

/**
 * FLY-1048 (A3): stable episode fingerprint for a tracked error signature.
 * Exported for PR-C (C4): the unified flow's case-c episodes must key by the
 * SAME family the old flow uses, or the C4a mutual exclusion cannot match.
 */
export function sigFingerprint(signature: string): string {
	return `sig:${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

/**
 * FLY-1048 (A3): advance/emit for an episode whose evidence tail carries a
 * known error signature. Continuity is by NORMALIZED SIGNATURE (full-text
 * fingerprints may churn — the retry-loop MISS this path fixes); the same
 * threshold/dedup shape as the fingerprint flow applies. A legacy fingerprint
 * episode that already escalated this exact static pane carries its
 * escalation state over (a flag flip mid-episode must not double-alert).
 */
function evaluateErrorSignatureEpisode(
	input: StuckCandidateInput,
	tailHits: ErrorSignatureHit[],
	thresholdMs: number,
	tailLines: number,
): StuckCandidateResult {
	const prior = input.prior;
	const continuing =
		prior?.errorSig !== undefined &&
		tailHits.some((h) => h.signature === prior.errorSig);
	const tracked = continuing ? prior.errorSig! : tailHits[0]!.signature;
	const trackedHit = tailHits.find((h) => h.signature === tracked)!;
	const firstAt = continuing ? (prior.firstErrorSigAt ?? input.now) : input.now;

	const carryEscalation = continuing
		? prior
		: prior?.escalated && prior.fingerprint === fingerprintOutput(input.output)
			? prior
			: undefined;

	const episode: StuckEpisodeState = {
		...(carryEscalation ?? {}),
		fingerprint: sigFingerprint(tracked),
		firstStagnantAt: firstAt,
		escalated: carryEscalation?.escalated ?? false,
		errorSig: tracked,
		firstErrorSigAt: firstAt,
	};

	const sigAgeMs = input.now - firstAt;
	if (sigAgeMs < thresholdMs) {
		return { candidate: false, exclusion: "below_threshold", episode };
	}
	if (episode.escalated) {
		return { candidate: false, exclusion: "already_escalated", episode };
	}

	const evidence: StuckEvidence = {
		stuck_minutes: Math.floor(sigAgeMs / 60_000),
		tail: extractTail(input.output, tailLines),
		stream_error_signature: detectStreamErrorSignature(input.output),
		input_box_present: detectInputBoxPresent(input.output),
		errorSignature: trackedHit.kind,
	};
	return {
		candidate: true,
		episode: {
			...episode,
			escalated: true,
			throttleStalled: detectThrottleStall(input.output),
		},
		evidence,
	};
}

/**
 * FLY-927 (W-B): a RUNNER pane genuinely stalled after a 529/overloaded
 * throttle. Runner-side, deliberately independent of the Lead-side
 * `isTransientThrottlePane` (FLY-218) to avoid coupling — but reuses its
 * line-level retry-evidence idea: only the CURRENT interruptible spinner
 * line's OWN retry text vouches for a live retry (a stale error line's
 * "Retrying…(attempt N/M)" never does).
 *
 * Caller contract: only consulted on an ALREADY-STAGNANT pane (the 10-min
 * fingerprint gate ran first) — a healthy 529 whose retry counter is ticking
 * keeps changing the pane and never reaches this.
 *  - no throttle residue → false (a plain frozen turn stays runner_stuck_unhandled)
 *  - residue + a spinner line CARRYING retry text → false (conservative:
 *    stays runner_stuck_unhandled — the generic stall, not the throttle flavor)
 *  - residue + spinner without retry text / no spinner at all → true
 */
export function detectThrottleStall(output: string): boolean {
	const lines = output.replace(/\r/g, "").split("\n");
	const hasThrottleResidue = lines.some((l) =>
		/server is temporarily limiting requests|overloaded_error|not your usage limit/i.test(
			l,
		),
	);
	if (!hasThrottleResidue) return false;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/esc to interrupt/i.test(lines[i]!)) {
			return !/\bretry(?:ing)?\b|\battempt\s+\d+\s*\/\s*\d+/i.test(lines[i]!);
		}
	}
	return true;
}
