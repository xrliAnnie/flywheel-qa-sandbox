/**
 * FLY-1048 Task A2: FrameWindow multi-frame observation window (pure logic).
 *
 * Delta matrix (plan §2 A2): FN2 (error → identical frames), FN3 (post-compact
 * silence), FN1 (text churns but the SAME normalized error signature repeats),
 * FP0 (tokens flowing) — plus the single-frame / below-min-span guards that
 * keep callers from concluding case-c off one capture.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	computeFrameDeltas,
	createFrameWindowStore,
	type PaneFrame,
} from "../pane-frames.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadErrorPane = (name: string): string =>
	readFileSync(join(HERE, "fixtures", "error-panes", name), "utf-8");
const loadLeadPane = (name: string): string =>
	readFileSync(
		join(HERE, "..", "..", "__tests__", "fixtures", "lead-panes", name),
		"utf-8",
	);

const MIN_SPAN = { minSpanMs: 240_000 };
const frame = (text: string, capturedAtMs: number): PaneFrame => ({
	text,
	capturedAtMs,
});

describe("createFrameWindowStore", () => {
	it("keeps at most K frames per target, oldest evicted, chronological order", () => {
		const store = createFrameWindowStore(3);
		for (let i = 1; i <= 5; i++) store.push("t1", frame(`f${i}`, i * 1000));
		const win = store.window("t1");
		expect(win.map((f) => f.text)).toEqual(["f3", "f4", "f5"]);
	});

	it("isolates targets and returns [] for unknown keys", () => {
		const store = createFrameWindowStore(3);
		store.push("a", frame("x", 1));
		expect(store.window("b")).toEqual([]);
		expect(store.window("a")).toHaveLength(1);
	});

	it("prune drops windows for targets no longer active", () => {
		const store = createFrameWindowStore(3);
		store.push("keep", frame("x", 1));
		store.push("drop", frame("y", 1));
		store.prune(new Set(["keep"]));
		expect(store.window("keep")).toHaveLength(1);
		expect(store.window("drop")).toEqual([]);
	});
});

describe("computeFrameDeltas — FN matrix (must-detect)", () => {
	it("FN2: identical error-then-idle frames ≥ minSpan → silenceDelta + repeated signature", () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt");
		const d = computeFrameDeltas(
			[frame(pane, 0), frame(pane, 300_000)],
			MIN_SPAN,
		);
		expect(d.silenceDelta).toBe(true);
		expect(d.tokenFlowActive).toBe(false);
		expect(d.repeatedErrorSig?.kind).toBe("server_error_mid_response");
		expect(d.spanMs).toBe(300_000);
	});

	it("FN3: identical post-work idle frames (no error string) → silenceDelta only", () => {
		const pane = loadLeadPane("idle-cos-lead.txt");
		const d = computeFrameDeltas(
			[frame(pane, 0), frame(pane, 300_000)],
			MIN_SPAN,
		);
		expect(d.silenceDelta).toBe(true);
		expect(d.tokenFlowActive).toBe(false);
		expect(d.repeatedErrorSig).toBeNull();
	});

	it("FN1: frames whose text churns but the SAME ENOENT signature repeats", () => {
		const d = computeFrameDeltas(
			[
				frame(loadErrorPane("fn1-enoent-loop-frame1.txt"), 0),
				frame(loadErrorPane("fn1-enoent-loop-frame2.txt"), 300_000),
			],
			MIN_SPAN,
		);
		// The retry counter churns the live region → not a silence; but the
		// normalized ENOENT signature recurs across frames → the repeat detector
		// still catches the loop (the stuck-candidate MISS this task fixes).
		expect(d.repeatedErrorSig?.kind).toBe("enoent_loop");
		expect(d.silenceDelta).toBe(false);
	});
});

describe("computeFrameDeltas — FP guards (must-not)", () => {
	it("FP0: token flow (changing healthy content) → tokenFlowActive, no silence, no repeat", () => {
		const a = loadErrorPane("fp-healthy-working.txt");
		const b = a.replace("(34s ·", "(87s ·").replace("↑ 2.1k", "↑ 5.7k");
		const d = computeFrameDeltas([frame(a, 0), frame(b, 300_000)], MIN_SPAN);
		expect(d.tokenFlowActive).toBe(true);
		expect(d.silenceDelta).toBe(false);
		expect(d.repeatedErrorSig).toBeNull();
	});

	it("single frame → spanMs 0 and no conclusions", () => {
		const d = computeFrameDeltas(
			[frame(loadErrorPane("fn2-server-error-then-idle.txt"), 0)],
			MIN_SPAN,
		);
		expect(d.spanMs).toBe(0);
		expect(d.silenceDelta).toBe(false);
		expect(d.tokenFlowActive).toBe(false);
		expect(d.repeatedErrorSig).toBeNull();
	});

	it("identical frames below minSpan → not yet a silence (observation window)", () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt");
		const d = computeFrameDeltas(
			[frame(pane, 0), frame(pane, 60_000)],
			MIN_SPAN,
		);
		expect(d.silenceDelta).toBe(false);
		// The repeated signature is still reported — repetition is a fact of the
		// window; the TIME gate lives with the silence/threshold consumers (A3).
		expect(d.repeatedErrorSig?.kind).toBe("server_error_mid_response");
	});

	it("identical frames WITHOUT an empty prompt → no silenceDelta (typed text pending)", () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt").replace(
			/^❯$/m,
			"❯ draft reply not yet sent",
		);
		const d = computeFrameDeltas(
			[frame(pane, 0), frame(pane, 300_000)],
			MIN_SPAN,
		);
		expect(d.silenceDelta).toBe(false);
	});

	it("empty window → inert deltas", () => {
		const d = computeFrameDeltas([], MIN_SPAN);
		expect(d).toEqual({
			silenceDelta: false,
			repeatedErrorSig: null,
			tokenFlowActive: false,
			spanMs: 0,
		});
	});
});
