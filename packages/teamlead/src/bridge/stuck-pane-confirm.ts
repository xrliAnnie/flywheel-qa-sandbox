/**
 * FLY-1234: the heartbeat `session_stuck` pane/process CONFIRM layer.
 *
 * Production incident 2026-07-13: 5/5 session_stuck alerts were false
 * positives — all fired from the heartbeat quiet path (`getStuckSessions`:
 * running + last_activity_at stale >15min, pure DB), which had NO pane or
 * process evidence step. The pane-side detectors (FLY-195 / FLY-1048) judged
 * the same runners correctly that day but guard a DIFFERENT pipeline.
 *
 * This module is pure ORCHESTRATION over existing detection primitives
 * (convergence rule, plan §4.5 — no fourth inconsistent detector):
 *   ① liveness  — #576/FLY-720 four-state probe, injected (DEATH detector
 *                 only: `alive` alone NEVER suppresses — INV-6);
 *   ② two frames — FLY-92 "look twice" inside one tick, FLY-195 raw-compare
 *                 semantics (a live spinner's second counter changes the raw
 *                 frame → working), FLY-1048 error-signature table;
 *   ③ judge     — FLY-1048 `routeSuspiciousReport` (shared instance,
 *                 single-flight queue), consulted only for the genuinely
 *                 uncertain "static frames, live process" window.
 *
 * Hard contracts (plan §2):
 *  - INV-1 fail-open lineage: any failure / timeout / throw → EMIT (legacy
 *    behavior). Suppression requires POSITIVE health evidence (frames moving /
 *    judge a_working / b_parked with mechanical corroboration).
 *  - INV-4 single emission right: the judge routing injected here only audits
 *    and reports the decision — it never delivers a Lead notification itself.
 *  - INV-6 pane-alive ≠ process-alive: `alive` merely advances to step ②.
 *  - Deadline (R2 #3): the whole call races an injected sleep; a late judge
 *    result resolves into a discarded promise (structurally isolated — the
 *    per-call routing closure's audit rows MAY land late by explicit contract,
 *    but no notification and no dedup can result from a timed-out call).
 */

import { createHash } from "node:crypto";
import type { Session } from "../StateStore.js";
import {
	buildPaneTail,
	type SuspiciousReport,
} from "./detection-suspicious.js";
import type { ErrorSignatureHit } from "./error-signatures.js";
import { quietFingerprint } from "./quiet-classifier.js";
import type { JudgeDecision, WatchdogJudgeInput } from "./watchdog-judge.js";

export type { JudgeDecision } from "./watchdog-judge.js";

// ── Env knobs (T0): bounded, fail-to-default parsing ────────────────────────

export const STUCK_FRAME_GAP_MS_DEFAULT = 15_000;
export const STUCK_FRAME_GAP_MS_MAX = 60_000;
export const STUCK_CONFIRM_PER_TICK_DEFAULT = 3;
export const STUCK_CONFIRM_PER_TICK_MAX = 20;
export const STUCK_CONFIRM_DEADLINE_MS_DEFAULT = 90_000;
export const STUCK_CONFIRM_DEADLINE_MS_MAX = 300_000;

export interface StuckConfirmKnobs {
	frameGapMs: number;
	perTick: number;
	deadlineMs: number;
}

/**
 * Parse contract (Codex R2 #6): positive integer AND ≤ cap; anything else
 * (empty / garbage / 0 / negative / over-cap) falls back to the DEFAULT —
 * never to 0 (which would disable confirmation or starve the budget) and
 * never above the cap (which would blow the latency guardrail).
 *
 * Cross-field contract: after per-field parsing, `frameGapMs >= deadlineMs`
 * is a configuration CONTRADICTION (each field individually legal) — both
 * fall back to defaults together, `warn` fires once per parse. The warn
 * sink is injected so the boot-time parse logs while per-tick call-time
 * parses stay quiet (no 5-minutely spam for a standing misconfig).
 */
export function parseStuckConfirmKnobs(
	env: NodeJS.ProcessEnv = process.env,
	opts?: { warn?: (msg: string) => void },
): StuckConfirmKnobs {
	// Codex code R1 #5: validate the WHOLE string — parseInt would accept
	// numeric prefixes ("20000ms" → 20000, "120000.5" → 120000), which the
	// contract classifies as garbage → default.
	const bounded = (raw: string | undefined, def: number, max: number) => {
		if (raw === undefined || !/^\d+$/.test(raw.trim())) return def;
		const n = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(n) && n > 0 && n <= max ? n : def;
	};
	let frameGapMs = bounded(
		env.FLYWHEEL_STUCK_FRAME_GAP_MS,
		STUCK_FRAME_GAP_MS_DEFAULT,
		STUCK_FRAME_GAP_MS_MAX,
	);
	const perTick = bounded(
		env.FLYWHEEL_STUCK_CONFIRM_PER_TICK,
		STUCK_CONFIRM_PER_TICK_DEFAULT,
		STUCK_CONFIRM_PER_TICK_MAX,
	);
	let deadlineMs = bounded(
		env.FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS,
		STUCK_CONFIRM_DEADLINE_MS_DEFAULT,
		STUCK_CONFIRM_DEADLINE_MS_MAX,
	);
	if (frameGapMs >= deadlineMs) {
		opts?.warn?.(
			`FLY-1234 knob contradiction: FLYWHEEL_STUCK_FRAME_GAP_MS (${frameGapMs}) >= ` +
				`FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS (${deadlineMs}) — both fall back to defaults ` +
				`(${STUCK_FRAME_GAP_MS_DEFAULT}/${STUCK_CONFIRM_DEADLINE_MS_DEFAULT})`,
		);
		frameGapMs = STUCK_FRAME_GAP_MS_DEFAULT;
		deadlineMs = STUCK_CONFIRM_DEADLINE_MS_DEFAULT;
	}
	return { frameGapMs, perTick, deadlineMs };
}

// ── Result contract ─────────────────────────────────────────────────────────

/**
 * Bounded emit-reason enum. NEVER carries pane text or model rationale
 * (R1 #5 / R2 #2) — the wake annotation is built from these codes only.
 */
export type StuckConfirmReason =
	| "dead_pin"
	| "target_absent"
	| "target_gone"
	| "lookup_indeterminate"
	| "capture_failed"
	| "repeated_error_signature" // R2 #5: two-frame same signature = high-confidence C, never judged
	| "frames_static_judge_c_stuck"
	| "judge_suspicious"
	| "judge_unavailable"
	| "deadline_exceeded"
	| "confirm_error"
	| "confirm_budget_exhausted" // annotated by HeartbeatService, not produced here
	| "confirm_unbound"; // annotated by HeartbeatService, not produced here

export type StuckSuppressReason =
	| "frames_changing"
	| "judge_a_working"
	| "judge_b_parked";

export interface StuckConfirmResult {
	action: "emit" | "suppress";
	reason: StuckConfirmReason | StuckSuppressReason;
	/** Present on emit: the wake annotation — fixed reason-code prose only. */
	confirmNote?: string;
}

/**
 * Fixed annotation prose per emit reason. `target_gone` deliberately does NOT
 * claim the process is dead (R1 #7) — only that the target is unresolvable.
 */
export const CONFIRM_NOTES: Record<StuckConfirmReason, string> = {
	dead_pin: "dead_pin: tmux pane process is a remain-on-exit corpse",
	target_absent: "target_absent: tmux window/session is gone",
	target_gone:
		"target_gone: tmux target not resolvable from CommDB — no liveness verdict possible",
	lookup_indeterminate:
		"lookup_indeterminate: liveness probe could not determine process state",
	capture_failed: "capture_failed: pane frame capture failed",
	repeated_error_signature:
		"repeated_error_signature: same normalized error signature across both frames",
	frames_static_judge_c_stuck:
		"frames_static_judge_c_stuck: static frames and judge verdict c_stuck",
	judge_suspicious:
		"judge_suspicious: static frames and judge could not conclude",
	judge_unavailable:
		"judge_unavailable: static frames; judge disabled/failed (fail-open emit)",
	deadline_exceeded:
		"deadline_exceeded: confirm layer exceeded its deadline (fail-open emit)",
	confirm_error: "confirm_error: confirm layer threw (fail-open emit)",
	confirm_budget_exhausted:
		"confirm_budget_exhausted: per-tick confirm budget exhausted (legacy emit, unprobed)",
	confirm_unbound:
		"confirm_unbound: confirm holder not bound (fail-open emit, wiring fault)",
};

// ── Dependency contract ─────────────────────────────────────────────────────

export type ConfirmLiveness =
	| "alive"
	| "dead_pin"
	| "absent"
	| "gone"
	| "indeterminate";

export interface StuckConfirmDeps {
	/**
	 * Assembly-layer mapping (R1 #7): lookupTmuxTarget `found`→process probe /
	 * `gone`→"gone" / `error`→"indeterminate".
	 */
	probeLiveness(session: Session): Promise<ConfirmLiveness>;
	/** capturedAtMs is stamped by the I/O layer — this module never reads the clock. */
	captureFrame(
		session: Session,
	): Promise<{ text: string; capturedAtMs: number } | null>;
	frameGapMs: number;
	/** End-to-end deadline; expiry → emit(deadline_exceeded) (R1 #2). */
	deadlineMs: number;
	sleep(ms: number): Promise<void>;
	/** Kind-aware signature scan (error-signatures.scanErrorSignatures as-is). */
	scanErrorSignatures(text: string): ErrorSignatureHit[];
	/**
	 * R2 #2 + R3 #1: PER-CALL structured judge routing. The adapter constructs
	 * a FRESH routing-deps closure per invocation (deliver/onDecision write to
	 * locals, discarded after use) — no mutable state is shared across
	 * candidates. It must NEVER deliver a Lead notification (INV-4) and must
	 * resolve exactly once with the routing's structured decision.
	 */
	routeToJudge(
		report: SuspiciousReport,
		ctx: { errorSignatureKinds: string[] },
	): Promise<JudgeDecision>;
	logger?(msg: string): void;
}

// ── The confirm decision (plan §T1 decision table) ──────────────────────────

const DEADLINE = Symbol("stuck-confirm-deadline");

function emit(reason: StuckConfirmReason): StuckConfirmResult {
	return { action: "emit", reason, confirmNote: CONFIRM_NOTES[reason] };
}

export async function confirmStuckCandidate(
	session: Session,
	deps: StuckConfirmDeps,
): Promise<StuckConfirmResult> {
	const logger = deps.logger ?? (() => {});
	// Deadline race (R2 #3): the losing side's eventual result resolves into a
	// discarded promise — a late judge answer cannot rewrite the heartbeat
	// decision, emit a second notification, or leak into another candidate
	// (routeToJudge closures are per-call by contract). Audit rows inside the
	// routing MAY land late — an explicit, tested contract (INV-3 note).
	const deadline: Promise<typeof DEADLINE> = deps
		.sleep(deps.deadlineMs)
		.then(() => DEADLINE);
	try {
		const result = await Promise.race([
			runConfirmSteps(session, deps),
			deadline,
		]);
		if (result === DEADLINE) {
			logger(
				`confirm deadline exceeded for ${session.execution_id} — fail-open emit`,
			);
			return emit("deadline_exceeded");
		}
		return result;
	} catch (err) {
		logger(
			`confirm threw for ${session.execution_id} — fail-open emit: ${(err as Error).message}`,
		);
		return emit("confirm_error");
	}
}

async function runConfirmSteps(
	session: Session,
	deps: StuckConfirmDeps,
): Promise<StuckConfirmResult> {
	// ① liveness — death detector ONLY (INV-6: alive alone never suppresses).
	const liveness = await deps.probeLiveness(session);
	if (liveness === "dead_pin") return emit("dead_pin");
	if (liveness === "absent") return emit("target_absent");
	if (liveness === "gone") return emit("target_gone");
	if (liveness === "indeterminate") return emit("lookup_indeterminate");

	// ② two frames, one tick apart (FLY-92 "look twice"; FLY-195 raw compare).
	const frame1 = await deps.captureFrame(session);
	if (frame1 === null) return emit("capture_failed");
	await deps.sleep(deps.frameGapMs);
	const frame2 = await deps.captureFrame(session);
	if (frame2 === null) return emit("capture_failed");

	const hits1 = deps.scanErrorSignatures(frame1.text);
	const hits2 = deps.scanErrorSignatures(frame2.text);
	// R2 #5 / R3 #2: a common normalized (kind, signature) across BOTH frames
	// is high-confidence C — emit directly, never judged, never downgradable
	// (aligned with the A3 "C never missed" contract). Raw-identical frames
	// with any signature always land here (deterministic scanner ⇒ identical
	// hit sets), so the "same frames, one-sided signature" branch is
	// structurally unreachable.
	const keyOf = (h: ErrorSignatureHit) => `${h.kind} ${h.signature}`;
	const sigs1 = new Set(hits1.map(keyOf));
	if (hits2.some((h) => sigs1.has(keyOf(h)))) {
		return emit("repeated_error_signature");
	}

	const framesChanged = frame1.text !== frame2.text;
	const anySignature = hits1.length > 0 || hits2.length > 0;
	if (framesChanged && !anySignature) {
		// Raw output moved and no error signature in sight — the runner is
		// working (a live spinner's second counter alone changes the raw frame).
		return { action: "suppress", reason: "frames_changing" };
	}
	// Remaining windows are mechanically uncertain (R3 #2): static frames with
	// no signature, OR changing frames with a one-sided / mismatched signature
	// (transient error?) — the judge decides, fed the kinds union.
	const kinds = [...new Set([...hits1, ...hits2].map((h) => h.kind))].sort();
	const report: SuspiciousReport = {
		targetKind: "runner",
		targetKey: session.execution_id,
		reason:
			"heartbeat_quiet_confirm: running with stale last_activity and a mechanically-uncertain pane window — confirm layer consulting the judge",
		paneTail: buildPaneTail(frame2.text),
		episodeFingerprint: quietFingerprint(frame2.text),
		frames: [frame1, frame2],
	};
	const decision = await deps.routeToJudge(report, {
		errorSignatureKinds: kinds,
	});
	if (decision.outcome === "suppressed") {
		return {
			action: "suppress",
			reason:
				decision.decision === "b_parked" ? "judge_b_parked" : "judge_a_working",
		};
	}
	switch (decision.decision) {
		case "c_stuck":
			return emit("frames_static_judge_c_stuck");
		case "suspicious":
			return emit("judge_suspicious");
		default:
			return emit("judge_unavailable");
	}
}

// ── Heartbeat judge cache key (T4, R3 #4 + R4 #1/#2) ────────────────────────

/**
 * The heartbeat path's judge cooldown-cache key: a VERSIONED canonical
 * serialization of the evidence identity, hashed. Design contracts:
 *  - `report.targetKey` stays the true execId everywhere else (owner
 *    resolution / getSession / audits — R2 #1); only the CACHE key is derived.
 *  - namespace version + targetKey in the key: different runners never share
 *    a verdict even with identical evidence projections (R4 #1).
 *  - frames enter as RAW text (quietFingerprint would wash spinners and give
 *    two different live panes the same key — R2 #1); capturedAtMs (pure wall
 *    clock) stays OUT.
 *  - comm events enter as (kind, summary, recency-bucket): aging across the
 *    corroboration threshold changes the key → fresh judgment; the exact
 *    ageMs stays out (a per-tick-changing wall clock would kill the cache).
 *    `commCorroborationMs` must be the LIVE stuckCommActivityMs(env) value —
 *    0 means the corroboration bucket is constantly false, in step with the
 *    quiet-classifier exemption being disabled (R5 note).
 *  - JSON array/object structure kills concatenation boundary collisions
 *    (["ab","c"] ≠ ["a","bc"] — R3 #4).
 */
export function buildHeartbeatJudgeCacheKey(
	report: SuspiciousReport,
	input: WatchdogJudgeInput,
	opts: { commCorroborationMs: number },
): string {
	const canonical = JSON.stringify({
		v: "heartbeat-v1",
		targetKey: report.targetKey,
		evidence: {
			frames: input.frames.map((f) => f.text),
			stage: input.stage ?? null,
			fsm: input.fsmStatus ?? null,
			park: input.park ?? null,
			comm: (input.commEvents ?? []).map((e) => ({
				kind: e.kind,
				summary: e.summary,
				recent: e.ageMs < opts.commCorroborationMs,
			})),
			sigKinds: [...(input.errorSignatureKinds ?? [])].sort(),
		},
	});
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
