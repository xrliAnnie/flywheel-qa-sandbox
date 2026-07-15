/**
 * QA · FLY-1006 round-3 — independent reproduction of the Annie P6 barge-in
 * STORM against the REAL EarsReceiver, confirming the holdoff latch fix.
 *
 * Annie's P6 session (evidence/m2-annie-p6-session.md): her natural speech —
 * one long sentence broken by breaths/pauses — fired local barge-in 8+ times in
 * a single utterance, thrashing the /eleven turn state and cascading latency
 * from 1.5s to 28.5s. This test drives the SAME shape (a train of >350ms
 * speaking bursts separated by sub-holdoff pauses) through the real
 * EarsReceiver and asserts the round-3 holdoff makes it AT MOST ONE barge-in —
 * while a genuine new interruption after ≥ holdoff silence still fires.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarsReceiver } from "../audio/EarsReceiver.js";

class FakeSpeaking {
	private h: Record<"start" | "end", ((u: string) => void)[]> = {
		start: [],
		end: [],
	};
	on(e: "start" | "end", cb: (u: string) => void): void {
		this.h[e].push(cb);
	}
	fire(e: "start" | "end", u: string): void {
		for (const cb of this.h[e]) cb(u);
	}
}

function makeRig(over: Record<string, unknown> = {}) {
	const speaking = new FakeSpeaking();
	const bargeIns: string[] = [];
	const receiver = new EarsReceiver({
		speaking,
		subscribe: () => new PassThrough(),
		createDecoder: () => new PassThrough(),
		isHuman: (u: string) => u.startsWith("human"),
		backchannelMs: 350,
		bargeInHoldoffMs: 1000,
		onFrame: () => {},
		onBargeIn: (u: string) => bargeIns.push(u),
		onError: () => {},
		...over,
	});
	receiver.attach();
	return { speaking, bargeIns, receiver };
}

describe("QA FLY-1006 R3 — barge-in storm holdoff (Annie P6 defect ①)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("one utterance = one barge-in (8-burst storm → ≤1), not the P6 8+", async () => {
		const { speaking, bargeIns } = makeRig();
		const u = "human-annie";

		// Annie's utterance: 8 speaking bursts, each > the 350ms backchannel gate
		// (so each would classically fire barge-in), separated by ~400ms breaths
		// (< the 1000ms holdoff → same utterance).
		for (let i = 0; i < 8; i++) {
			speaking.fire("start", u);
			await vi.advanceTimersByTimeAsync(500); // sustained speech → crosses gate
			speaking.fire("end", u);
			await vi.advanceTimersByTimeAsync(400); // breath/pause < holdoff
		}
		// let any pending unlatch settle
		await vi.advanceTimersByTimeAsync(1100);

		expect(bargeIns.length).toBe(1); // was 8+ in P6 before the fix
	});

	it("a GENUINE new interruption after ≥holdoff silence still fires", async () => {
		const { speaking, bargeIns } = makeRig();
		const u = "human-annie";

		// utterance 1 → one barge-in
		speaking.fire("start", u);
		await vi.advanceTimersByTimeAsync(500);
		speaking.fire("end", u);
		// continuous silence ≥ holdoff → utterance ends, latch clears
		await vi.advanceTimersByTimeAsync(1200);
		// utterance 2 (a real new interruption) → fires again
		speaking.fire("start", u);
		await vi.advanceTimersByTimeAsync(500);
		speaking.fire("end", u);
		await vi.advanceTimersByTimeAsync(1200);

		expect(bargeIns.length).toBe(2); // debounce doesn't swallow real interrupts
	});

	it("a resumed burst that restarts BEFORE holdoff elapses does not clear the latch", async () => {
		const { speaking, bargeIns } = makeRig();
		const u = "human-annie";

		speaking.fire("start", u);
		await vi.advanceTimersByTimeAsync(500);
		speaking.fire("end", u); // silence clock starts
		await vi.advanceTimersByTimeAsync(700); // < 1000ms holdoff
		speaking.fire("start", u); // resumes → same utterance, restart clock
		await vi.advanceTimersByTimeAsync(500);
		speaking.fire("end", u);
		await vi.advanceTimersByTimeAsync(700); // < holdoff again
		speaking.fire("start", u);
		await vi.advanceTimersByTimeAsync(500);
		speaking.fire("end", u);
		await vi.advanceTimersByTimeAsync(1100);

		expect(bargeIns.length).toBe(1); // still one utterance despite the resumes
	});
});
