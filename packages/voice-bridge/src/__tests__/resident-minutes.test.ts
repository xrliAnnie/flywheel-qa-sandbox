/**
 * FLY-1160 §4.1-6 / Codex R1 HIGH-3 — summarizeViaResidentBrain: the host
 * resident final-turn minutes land ONLY on a clean completion; ANY failure
 * (even after a partial prefix) falls back to the raw journal so the meeting's
 * facts are never discarded and a truncated summary never marks the issue Done.
 */
import { describe, expect, it } from "vitest";
import {
	type ResidentSummaryBrain,
	rawJournalMinutes,
	summarizeViaResidentBrain,
} from "../huddle/residentMinutes.js";

const JOURNAL = "[00:01] Annie: 发布定周五\n[00:02] Tadashi: 好的";

/** a brain whose respond yields `chunks`, then optionally throws mid-stream.
 * `disposed` simulates a daemon-shutdown teardown (the stream still ends cleanly,
 * but the brain reports it was being torn down). */
function brain(
	chunks: string[],
	opts: { throwAfter?: boolean; disposed?: boolean } = {},
): ResidentSummaryBrain {
	return {
		async *respond() {
			for (const c of chunks) yield c;
			if (opts.throwAfter) throw new Error("resident brain died mid-summary");
		},
		health: () => ({ disposed: opts.disposed ?? false }),
	};
}

describe("summarizeViaResidentBrain (FLY-1160 §4.1-6)", () => {
	it("a CLEAN completion lands the model output", async () => {
		const out = await summarizeViaResidentBrain(
			brain(["## 结论\n", "1. 周五发布"]),
			JOURNAL,
		);
		expect(out).toBe("## 结论\n1. 周五发布");
	});

	it("a mid-stream failure after a partial prefix falls back to the RAW JOURNAL, never the truncated summary (R1 HIGH-3)", async () => {
		const out = await summarizeViaResidentBrain(
			brain(["## 结论\n", "1. 周五"], { throwAfter: true }),
			JOURNAL,
		);
		expect(out).toBe(rawJournalMinutes(JOURNAL));
		expect(out).toContain(JOURNAL);
		expect(out).not.toContain("1. 周五"); // the partial must NOT be landed
	});

	it("a daemon-shutdown teardown interrupts the summary CLEANLY but still falls back to the raw journal, never the partial (R3 HIGH)", async () => {
		// the stream ends without throwing (an external interrupt → queue.finish),
		// but the brain reports it was torn down → the prefix must NOT be landed.
		const out = await summarizeViaResidentBrain(
			brain(["## 结论\n", "1. 周"], { disposed: true }),
			JOURNAL,
		);
		expect(out).toBe(rawJournalMinutes(JOURNAL));
		expect(out).not.toContain("1. 周");
	});

	it("no host brain → raw journal fallback", async () => {
		expect(await summarizeViaResidentBrain(undefined, JOURNAL)).toBe(
			rawJournalMinutes(JOURNAL),
		);
	});

	it("a clean-but-empty completion → raw journal fallback", async () => {
		expect(await summarizeViaResidentBrain(brain([]), JOURNAL)).toBe(
			rawJournalMinutes(JOURNAL),
		);
	});
});
