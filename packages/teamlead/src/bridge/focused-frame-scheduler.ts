/**
 * FLY-1048 (Task A7): focused-frame scheduler.
 *
 * The ~1h fleet sweep (DEFAULT_IDLE_POLL_MS — deliberately untouched, FLY-628
 * token line) stays the coarse fallback; suspects surfaced by the gap scan
 * (A6 `pane_progress_suspect`) get TARGETED extra frames instead: one capture
 * per `intervalMs` (default 4min) per target, at most `capturesPerTick`
 * captures per tick, until the window holds ≥2 frames and a mechanical
 * verdict is possible:
 *   - c_candidate (silence / repeated error signature) → the caller routes it
 *     to the EXISTING escalation entry (stuck-runner-detector via `onFrame` —
 *     its hard gates + dispositions stay authoritative);
 *   - active (content flowing) → suspicion clears;
 *   - unclear → fail-suspicious (A5) or the judge (PR-B).
 * Capture failures are FAIL-CLOSED: no frame is recorded and no verdict is
 * drawn from a blind window; the cooldown still applies so a broken capture
 * path is never hammered every tick.
 */

import {
	computeFrameDeltas,
	createFrameWindowStore,
	type FrameDeltas,
	type FrameWindowStore,
	type PaneFrame,
} from "./pane-frames.js";

export interface FocusedFrameTarget {
	targetKey: string;
	projectName: string;
}

export interface FocusedFrameVerdict {
	target: FocusedFrameTarget;
	verdict: "c_candidate" | "active" | "unclear";
	deltas: FrameDeltas;
	/** Latest captured pane text (feeds A5 evidence / the PR-B judge). */
	latestFrame: string;
	/** FLY-1048 PR-B: the full frame window (chronological) so an unclear
	 * verdict can consult the judge with ≥2 frames. */
	window: PaneFrame[];
}

export interface FocusedFrameSchedulerDeps {
	/** Capture the target's pane. null = capture failed (fail-closed skip). */
	capture: (target: FocusedFrameTarget) => Promise<string | null>;
	/** Fired for EVERY successful capture — the caller feeds the existing
	 * stuck-runner detector (`checkSession` with a precaptured outcome), so
	 * suspects accumulate episode time at the focused cadence instead of the
	 * 1h sweep. Best-effort; errors are logged, never thrown. */
	onFrame?: (
		target: FocusedFrameTarget,
		frameText: string,
	) => void | Promise<void>;
	/** Fired when a MATURE window (≥2 frames, span ≥ minSpanMs) yields a
	 * verdict. Best-effort; errors are logged, never thrown. */
	onVerdict?: (verdict: FocusedFrameVerdict) => void | Promise<void>;
	/** Per-target capture interval (default 4min; FLYWHEEL_FRAME_INTERVAL_MS). */
	intervalMs?: number;
	/** Max capture ATTEMPTS per tick (default 2; FLYWHEEL_FRAME_CAPTURES_PER_TICK). */
	capturesPerTick?: number;
	/** Min first→last span before a silence verdict (default = intervalMs). */
	minSpanMs?: number;
	frames?: FrameWindowStore;
	now?: () => number;
	logger?: (msg: string) => void;
}

export interface FocusedFrameScheduler {
	/** Run one scheduling pass over the CURRENT suspect set. Targets absent
	 * from the set are pruned (their windows die with the suspicion). */
	tick(suspects: FocusedFrameTarget[]): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 240_000;
const DEFAULT_CAPTURES_PER_TICK = 2;

export function createFocusedFrameScheduler(
	deps: FocusedFrameSchedulerDeps,
): FocusedFrameScheduler {
	const frames = deps.frames ?? createFrameWindowStore();
	const now = deps.now ?? (() => Date.now());
	const logger =
		deps.logger ?? ((m: string) => console.log(`[focused-frames] ${m}`));
	const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
	const capturesPerTick = deps.capturesPerTick ?? DEFAULT_CAPTURES_PER_TICK;
	const minSpanMs = deps.minSpanMs ?? intervalMs;
	/** Per-target last capture ATTEMPT (success or failure — cooldown both). */
	const lastAttemptAt = new Map<string, number>();

	async function fireSafely(label: string, fn: () => void | Promise<void>) {
		try {
			await fn();
		} catch (err) {
			logger(`${label} threw (non-fatal): ${(err as Error).message}`);
		}
	}

	return {
		async tick(suspects) {
			const activeKeys = new Set(suspects.map((s) => s.targetKey));
			frames.prune(activeKeys);
			for (const key of lastAttemptAt.keys()) {
				if (!activeKeys.has(key)) lastAttemptAt.delete(key);
			}

			let budget = capturesPerTick;
			const seen = new Set<string>();
			for (const target of suspects) {
				if (budget <= 0) break;
				if (seen.has(target.targetKey)) continue;
				seen.add(target.targetKey);
				const nowMs = now();
				const last = lastAttemptAt.get(target.targetKey);
				if (last !== undefined && nowMs - last < intervalMs) continue;
				budget -= 1;
				lastAttemptAt.set(target.targetKey, nowMs);

				let pane: string | null = null;
				try {
					pane = await deps.capture(target);
				} catch (err) {
					logger(
						`capture threw for ${target.targetKey}: ${(err as Error).message}`,
					);
				}
				if (pane === null) continue; // fail-closed: no blind frames

				frames.push(target.targetKey, { text: pane, capturedAtMs: nowMs });
				if (deps.onFrame) {
					await fireSafely("onFrame", () => deps.onFrame?.(target, pane));
				}

				const window = frames.window(target.targetKey);
				const deltas = computeFrameDeltas(window, { minSpanMs });
				if (window.length < 2 || deltas.spanMs < minSpanMs) continue;

				const verdict: FocusedFrameVerdict["verdict"] =
					deltas.repeatedErrorSig !== null || deltas.silenceDelta
						? "c_candidate"
						: deltas.tokenFlowActive
							? "active"
							: "unclear";
				if (deps.onVerdict) {
					await fireSafely("onVerdict", () =>
						deps.onVerdict?.({
							target,
							verdict,
							deltas,
							latestFrame: pane,
							window,
						}),
					);
				}
			}
		},
	};
}
