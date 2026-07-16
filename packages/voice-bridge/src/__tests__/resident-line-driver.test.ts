/**
 * FLY-1160 §4.1-5 — ResidentLineDriver: the /glaw resident-mode turn pump.
 * One founder turn = brain.respond(text) text stream → TextTurnMouth
 * (beginTurn/feed/endTurn). Serial (a new respond waits for the previous
 * pump to settle). barge-in = mouth.flush() SYNC first, then abort the
 * in-flight turn (the brain's respond signal → brain.interrupt()). A real
 * turn failure is fail-loud to onError; a cancelled turn is silent.
 */
import { describe, expect, it, vi } from "vitest";
import {
	ResidentLineDriver,
	type ResidentMouth,
	type ResidentTurnBrain,
} from "../huddle/ResidentLineDriver.js";

function fakeMouth(): { mouth: ResidentMouth; log: string[] } {
	const log: string[] = [];
	const mouth: ResidentMouth = {
		beginTurn: () => log.push("begin"),
		feed: (d) => log.push(`feed:${d}`),
		endTurn: () => log.push("end"),
		flush: () => log.push("flush"),
	};
	return { mouth, log };
}

/** a brain whose respond yields the given deltas, honoring the abort signal
 * (so barge-in ends the stream like the real ResidentClaudeBrain does). */
function scriptedBrain(
	deltas: string[],
	opts: { onInterrupt?: () => void; hang?: boolean } = {},
): ResidentTurnBrain {
	return {
		async *respond(_turn, o) {
			for (const d of deltas) {
				if (o.signal.aborted) return;
				yield d;
			}
			if (opts.hang) {
				// stay open until aborted (simulates a long turn the founder cuts)
				await new Promise<void>((resolve) => {
					o.signal.addEventListener("abort", () => resolve(), { once: true });
				});
			}
		},
		interrupt: async () => {
			opts.onInterrupt?.();
		},
	};
}

const flush = async () => {
	// let the fire-and-forget respond pump(s) run to completion — serial turns
	// chain across many microtasks + macrotask boundaries, so drain generously.
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		for (let j = 0; j < 10; j++) await Promise.resolve();
	}
};

describe("ResidentLineDriver (FLY-1160 §4.1-5)", () => {
	it("pumps a turn: beginTurn → feed each delta → endTurn; onSpeaking once, onAnswer with the full text", async () => {
		const { mouth, log } = fakeMouth();
		let speaking = 0;
		const answers: string[] = [];
		const driver = new ResidentLineDriver({
			brain: scriptedBrain(["你好", "，", "在的"]),
			mouth,
			onSpeaking: () => speaking++,
			onAnswer: (t) => answers.push(t),
		});
		driver.respond("在吗");
		await flush();
		expect(log).toEqual(["begin", "feed:你好", "feed:，", "feed:在的", "end"]);
		expect(speaking).toBe(1); // once, at the first delta
		expect(answers).toEqual(["你好，在的"]); // full turn text for caption + fan-out
	});

	it("serializes turns: the second respond waits for the first pump to finish", async () => {
		const { mouth, log } = fakeMouth();
		const driver = new ResidentLineDriver({
			brain: scriptedBrain(["A"]),
			mouth,
		});
		driver.respond("一");
		driver.respond("二");
		await flush();
		// two full begin→feed→end cycles, never interleaved
		expect(log).toEqual(["begin", "feed:A", "end", "begin", "feed:A", "end"]);
	});

	it("barge-in: mouth.flush() is SYNC (before any await) and aborts the in-flight turn → brain.interrupt", async () => {
		const { mouth, log } = fakeMouth();
		const onInterrupt = vi.fn();
		const driver = new ResidentLineDriver({
			brain: scriptedBrain(["半句"], { hang: true, onInterrupt }),
			mouth,
		});
		driver.respond("说点什么");
		await flush(); // turn is now hanging mid-stream
		log.length = 0;
		driver.bargeIn();
		// flush happened synchronously in the same tick as bargeIn()
		expect(log[0]).toBe("flush");
		await flush();
		expect(onInterrupt).toHaveBeenCalledTimes(1);
	});

	it("same-tick respond()+bargeIn(): the turn is cancelled at admission — never opens the mouth or fires onAnswer (Codex R1 HIGH-1)", async () => {
		const { mouth, log } = fakeMouth();
		const answers: string[] = [];
		const onInterrupt = vi.fn();
		const driver = new ResidentLineDriver({
			brain: scriptedBrain(["不该说的话"], { onInterrupt }),
			mouth,
			onAnswer: (t) => answers.push(t),
		});
		driver.respond("在吗"); // queued (async chain not yet run)
		driver.bargeIn(); // SAME tick — must cancel before the pump starts
		await flush();
		// only the synchronous barge-in flush ran; NO begin/feed/end for a dead turn
		expect(log).toEqual(["flush"]);
		expect(answers).toEqual([]);
		expect(onInterrupt).toHaveBeenCalled();
	});

	it("barge-in aborts BOTH a streaming turn AND a turn queued behind it (Codex R2 HIGH-1)", async () => {
		const f = fakeMouth();
		const answers: string[] = [];
		const driver = new ResidentLineDriver({
			brain: scriptedBrain(["半句"], { hang: true }), // turn A streams then hangs
			mouth: f.mouth,
			onAnswer: (t) => answers.push(t),
		});
		driver.respond("一"); // turn A
		await flush(); // A is now streaming (hung mid-turn)
		driver.respond("二"); // turn B — queued behind the still-streaming A
		driver.bargeIn(); // must cancel BOTH, not just the latest
		await flush();
		// A was cut (never endTurn/onAnswer) and B never ran → no answer at all
		expect(answers).toEqual([]);
		expect(f.log).not.toContain("end");
	});

	it("a cancelled turn is silent (no onError); a real failure is fail-loud to onError", async () => {
		// cancelled: barge-in aborts → no onError
		const cancelErrors: Error[] = [];
		const d1 = new ResidentLineDriver({
			brain: scriptedBrain(["x"], { hang: true }),
			mouth: fakeMouth().mouth,
			onError: (e) => cancelErrors.push(e),
		});
		d1.respond("q");
		await flush();
		d1.bargeIn();
		await flush();
		expect(cancelErrors).toEqual([]);

		// real failure: respond throws (not via abort) → onError + mouth.flush
		const { mouth, log } = fakeMouth();
		const errors: Error[] = [];
		const boomBrain: ResidentTurnBrain = {
			// respond throws synchronously (the driver's for-await setup catches it):
			// a real brain failure, not a barge-in cancel.
			respond: () => {
				throw new Error("脑掉线了");
			},
			interrupt: async () => {},
		};
		const d2 = new ResidentLineDriver({
			brain: boomBrain,
			mouth,
			onError: (e) => errors.push(e),
		});
		d2.respond("q");
		await flush();
		expect(errors.map((e) => e.message)).toEqual(["脑掉线了"]);
		expect(log).toContain("flush"); // dead turn's mouth stream is cleared
	});
});
