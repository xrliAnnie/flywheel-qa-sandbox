/**
 * FLY-1048 (Task A2): multi-frame pane observation window (pure logic).
 *
 * A single static capture cannot distinguish "genuinely frozen" (case c) from
 * "quiet but alive" (case a/b) — the FLY-942 PRD requires ≥2 frames before a
 * case-c conclusion. This module holds the per-target in-memory ring buffer
 * (K=3; a Bridge restart drops the window — acceptable, it re-warms within
 * minutes; raw frames are deliberately NEVER persisted: privacy + size) and the
 * pure cross-frame delta computation consumed by the runner detector (A3), the
 * Lead watchdog multi-frame veto (A4), and the focused-frame scheduler (A7).
 */

import {
	type ErrorSignatureHit,
	scanErrorSignatures,
} from "./error-signatures.js";
import { hashPane, liveRegion } from "./pane-live-region.js";

export interface PaneFrame {
	text: string;
	capturedAtMs: number;
}

/** Per-target ring buffer of recent frames (process memory only). */
export interface FrameWindowStore {
	push(targetKey: string, frame: PaneFrame): void;
	/** Frames in chronological order (oldest first). Unknown key → []. */
	window(targetKey: string): PaneFrame[];
	/** Drop windows for targets no longer active (no unbounded growth). */
	prune(activeKeys: ReadonlySet<string>): void;
}

const DEFAULT_WINDOW_CAPACITY = 3;

export function createFrameWindowStore(
	capacity = DEFAULT_WINDOW_CAPACITY,
): FrameWindowStore {
	const windows = new Map<string, PaneFrame[]>();
	return {
		push(targetKey, frame) {
			const win = windows.get(targetKey) ?? [];
			win.push(frame);
			while (win.length > capacity) win.shift();
			windows.set(targetKey, win);
		},
		window(targetKey) {
			return [...(windows.get(targetKey) ?? [])];
		},
		prune(activeKeys) {
			for (const key of windows.keys()) {
				if (!activeKeys.has(key)) windows.delete(key);
			}
		},
	};
}

export interface FrameDeltas {
	/** Live-region hash unchanged across ALL frames + empty prompt + span ≥
	 * minSpanMs. A silence is a case-c CANDIDATE signal, not a verdict. */
	silenceDelta: boolean;
	/** The same normalized error signature recurring in ≥2 frames — catches
	 * rolling error loops whose full-text fingerprint keeps changing (the
	 * stuck-candidate MISS, FLY-910 ENOENT). Most recent hit reported. */
	repeatedErrorSig: ErrorSignatureHit | null;
	/** Live-region content changed across frames → tokens/renders are flowing.
	 * Orthogonal fact: may hold TOGETHER with repeatedErrorSig (a churning
	 * retry loop); consumers weigh repeatedErrorSig first. */
	tokenFlowActive: boolean;
	/** First→last frame time distance. 0 on a single frame — callers must NOT
	 * conclude case c from a 0-span window. */
	spanMs: number;
}

/**
 * Empty interactive prompt: current TUI `❯` alone, or legacy boxed `│ > │` /
 * bare `>` with nothing typed. Typed-but-unsent text (a draft) is NOT an empty
 * prompt — a frozen pane holding a draft is a different failure shape (FN4
 * family) and must not be classified by the silence path.
 */
const EMPTY_PROMPT_LINE = /^\s*(?:❯|>|[│|]\s*>\s*[│|]?)\s*$/u;

function hasEmptyPrompt(region: string): boolean {
	return region.split("\n").some((l) => EMPTY_PROMPT_LINE.test(l));
}

/**
 * Compute cross-frame deltas over a chronological frame window.
 *
 * Frames are normalized through `liveRegion` internally (idempotent — callers
 * may push raw captures or pre-stripped `ownStateRegion` output; A4 pushes the
 * latter so alert echoes never poison the deltas). Error-signature scanning
 * deliberately reads the FULL frame text: rolling errors often sit above the
 * 4-line live-region budget, and echo immunity is handled upstream (the `▏`
 * quote-skip in the scanner + A4's pre-strip).
 */
export function computeFrameDeltas(
	frames: PaneFrame[],
	opts: { minSpanMs: number },
): FrameDeltas {
	if (frames.length < 2) {
		return {
			silenceDelta: false,
			repeatedErrorSig: null,
			tokenFlowActive: false,
			spanMs: 0,
		};
	}

	const spanMs =
		frames[frames.length - 1]!.capturedAtMs - frames[0]!.capturedAtMs;
	const regions = frames.map((f) => liveRegion(f.text));
	const hashes = regions.map((r) => hashPane(r));
	const allSame = hashes.every((h) => h === hashes[0]);

	// Repeated error signature: same normalized signature in ≥2 frames.
	const perFrameSigs = frames.map((f) => scanErrorSignatures(f.text));
	let repeatedErrorSig: ErrorSignatureHit | null = null;
	const seen = new Map<string, number>();
	for (const sigs of perFrameSigs) {
		const frameUnique = new Map(sigs.map((h) => [h.signature, h]));
		for (const [signature] of frameUnique) {
			seen.set(signature, (seen.get(signature) ?? 0) + 1);
		}
	}
	for (let i = perFrameSigs.length - 1; i >= 0 && !repeatedErrorSig; i--) {
		for (const hit of perFrameSigs[i]!) {
			if ((seen.get(hit.signature) ?? 0) >= 2) {
				repeatedErrorSig = hit;
				break;
			}
		}
	}

	const silenceDelta =
		allSame && spanMs >= opts.minSpanMs && hasEmptyPrompt(regions.at(-1)!);
	const tokenFlowActive = !allSame;

	return { silenceDelta, repeatedErrorSig, tokenFlowActive, spanMs };
}
