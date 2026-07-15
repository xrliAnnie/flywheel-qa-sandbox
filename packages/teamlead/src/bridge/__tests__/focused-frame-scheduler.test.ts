/**
 * FLY-1048 Task A7: focused-frame scheduler — targeted 2nd/3rd frames for
 * suspects only (the 1h fleet sweep stays the fallback; FLY-628 token line).
 * Pins the scheduling semantics: per-target capture interval, per-tick capture
 * budget, capture-failure fail-closed (never conclude case c off a blind
 * frame), verdicts from mature windows only, and state pruning.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createFocusedFrameScheduler,
	type FocusedFrameVerdict,
} from "../focused-frame-scheduler.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadErrorPane = (name: string): string =>
	readFileSync(join(HERE, "fixtures", "error-panes", name), "utf-8");

const T = (key: string) => ({ targetKey: key, projectName: "flywheel" });

function makeHarness(opts: {
	panes: Record<string, string[] | string>; // per-target pane sequence
	capturesPerTick?: number;
	intervalMs?: number;
}) {
	let now = 1_700_000_000_000;
	const captured: string[] = [];
	const frames: Array<{ key: string; text: string }> = [];
	const verdicts: FocusedFrameVerdict[] = [];
	const captureCount = new Map<string, number>();
	const scheduler = createFocusedFrameScheduler({
		capture: async (t) => {
			captured.push(t.targetKey);
			const seq = opts.panes[t.targetKey];
			if (seq === undefined) return null;
			const n = captureCount.get(t.targetKey) ?? 0;
			captureCount.set(t.targetKey, n + 1);
			return typeof seq === "string"
				? seq
				: (seq[Math.min(n, seq.length - 1)] ?? null);
		},
		onFrame: (t, text) => {
			frames.push({ key: t.targetKey, text });
		},
		onVerdict: (v) => {
			verdicts.push(v);
		},
		intervalMs: opts.intervalMs ?? 240_000,
		capturesPerTick: opts.capturesPerTick ?? 2,
		now: () => now,
	});
	return {
		scheduler,
		captured,
		frames,
		verdicts,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("focused-frame scheduler — capture pacing", () => {
	it("captures a suspect once per interval, not every tick", async () => {
		const h = makeHarness({ panes: { a: "pane text" } });
		await h.scheduler.tick([T("a")]);
		await h.scheduler.tick([T("a")]); // same instant → cooldown holds
		expect(h.captured).toEqual(["a"]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.captured).toEqual(["a", "a"]);
	});

	it("caps captures per tick; overflow targets wait for the next tick", async () => {
		const h = makeHarness({
			panes: { a: "x", b: "y", c: "z" },
			capturesPerTick: 2,
		});
		await h.scheduler.tick([T("a"), T("b"), T("c")]);
		expect(h.captured).toEqual(["a", "b"]);
		await h.scheduler.tick([T("a"), T("b"), T("c")]);
		expect(h.captured).toEqual(["a", "b", "c"]);
	});

	it("capture failure is fail-closed: no frame, no verdict, cooldown applies", async () => {
		const h = makeHarness({ panes: {} }); // capture returns null
		await h.scheduler.tick([T("a")]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.captured).toEqual(["a", "a"]);
		expect(h.frames).toEqual([]);
		expect(h.verdicts).toEqual([]);
	});
});

describe("focused-frame scheduler — verdicts", () => {
	it("feeds every successful frame to onFrame (the existing-escalation entry)", async () => {
		const h = makeHarness({ panes: { a: "some pane" } });
		await h.scheduler.tick([T("a")]);
		expect(h.frames).toHaveLength(1);
		expect(h.frames[0]).toEqual({ key: "a", text: "some pane" });
	});

	it("no verdict from a single frame (span 0 — never conclude case c)", async () => {
		const h = makeHarness({
			panes: { a: loadErrorPane("fn2-server-error-then-idle.txt") },
		});
		await h.scheduler.tick([T("a")]);
		expect(h.verdicts).toEqual([]);
	});

	it("frozen error pane across ≥2 frames → c_candidate", async () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt");
		const h = makeHarness({ panes: { a: pane } });
		await h.scheduler.tick([T("a")]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.verdicts).toHaveLength(1);
		expect(h.verdicts[0]!.verdict).toBe("c_candidate");
	});

	it("flowing content → active (suspicion clears)", async () => {
		const a = loadErrorPane("fp-healthy-working.txt");
		const b = a.replace("(34s ·", "(99s ·");
		const h = makeHarness({ panes: { a: [a, b] } });
		await h.scheduler.tick([T("a")]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.verdicts).toHaveLength(1);
		expect(h.verdicts[0]!.verdict).toBe("active");
	});

	it("static pane with a typed-but-unsent draft → unclear (fail-suspicious path)", async () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt")
			.replace(/^❯$/m, "❯ draft reply not sent yet")
			.replace(/API Error: Server error mid-response[^\n]*/, "(clean tail)");
		const h = makeHarness({ panes: { a: pane } });
		await h.scheduler.tick([T("a")]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.verdicts).toHaveLength(1);
		expect(h.verdicts[0]!.verdict).toBe("unclear");
	});

	it("prunes internal state for targets no longer suspect", async () => {
		const pane = loadErrorPane("fn2-server-error-then-idle.txt");
		const h = makeHarness({ panes: { a: pane } });
		await h.scheduler.tick([T("a")]);
		// Target recovers (drops out) then re-enters: the old window must be
		// gone, so the next capture is frame #1 again → no verdict.
		await h.scheduler.tick([]);
		h.advance(240_000);
		await h.scheduler.tick([T("a")]);
		expect(h.verdicts).toEqual([]);
	});
});
