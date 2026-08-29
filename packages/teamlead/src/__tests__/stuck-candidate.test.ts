import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectInputBoxPresent,
	detectStreamErrorSignature,
	evaluateStuckCandidate,
	fingerprintOutput,
	isStuckEligibleStatus,
	STUCK_THRESHOLD_MS,
	type StuckCandidateInput,
	type StuckEpisodeState,
} from "../bridge/stuck-candidate.js";

const T0 = 1_000_000_000_000;

function baseInput(
	over: Partial<StuckCandidateInput> = {},
): StuckCandidateInput {
	return {
		status: "running",
		output: "reading files...\nstill working",
		now: T0,
		hasPendingGate: false,
		hasPendingReviewSignal: false,
		...over,
	};
}

/** Convenience: run two polls with the same output, threshold apart. */
function runStagnant(
	output: string,
	over: Partial<StuckCandidateInput> = {},
): ReturnType<typeof evaluateStuckCandidate> {
	const first = evaluateStuckCandidate(
		baseInput({ output, now: T0, prior: undefined, ...over }),
	);
	return evaluateStuckCandidate(
		baseInput({
			output,
			now: T0 + STUCK_THRESHOLD_MS,
			prior: first.episode ?? undefined,
			...over,
		}),
	);
}

describe("isStuckEligibleStatus", () => {
	it("only running is eligible", () => {
		expect(isStuckEligibleStatus("running")).toBe(true);
		for (const s of [
			"awaiting_review",
			"approved_to_ship",
			"pending",
			"completed",
			"failed",
			"blocked",
			"terminated",
		]) {
			expect(isStuckEligibleStatus(s)).toBe(false);
		}
	});
});

describe("detectStreamErrorSignature (strict)", () => {
	it("matches the real one-line Claude error", () => {
		expect(
			detectStreamErrorSignature(
				"⎿ Read file\nAPI Error: Stream idle timeout - partial response received\n",
			),
		).toBe(true);
	});
	it("rejects prose containing only 'partial response received'", () => {
		expect(
			detectStreamErrorSignature(
				"We discussed how a partial response received earlier could matter.",
			),
		).toBe(false);
	});
	it("rejects a bare 'API Error:' without the stream phrase", () => {
		expect(detectStreamErrorSignature("API Error: rate limited")).toBe(false);
	});
	it("rejects 'Stream idle timeout' split from 'API Error:' across lines", () => {
		expect(detectStreamErrorSignature("API Error:\nStream idle timeout")).toBe(
			false,
		);
	});
});

describe("detectInputBoxPresent (pinned against real pane fixtures)", () => {
	it("detects a legacy boxed Claude input box at the bottom", () => {
		const out = "some work\n╭───────────────╮\n│ > │\n╰───────────────╯";
		expect(detectInputBoxPresent(out)).toBe(true);
	});
	it("is false when a tool is running (no box)", () => {
		expect(detectInputBoxPresent("⎿ Running tests...\n  PASS 12/12")).toBe(
			false,
		);
	});

	// FLY-169 lesson: never trust an assumed TUI rendering — pin against the
	// REAL committed pane captures from FLY-193 (same Claude Code TUI that
	// Runners render). The prompt sits ABOVE a 3-line status bar, which is
	// exactly what a too-small scan window misses.
	const fixturesDir = join(__dirname, "fixtures", "lead-panes");
	for (const fixture of [
		"idle-cos-lead.txt",
		"idle-ops-lead.txt",
		"idle-product-lead.txt",
		"idle-product-lead-ctx100.txt",
	]) {
		it(`detects the idle input box in real capture ${fixture}`, () => {
			const pane = readFileSync(join(fixturesDir, fixture), "utf8");
			expect(detectInputBoxPresent(pane)).toBe(true);
		});
	}

	it("is false for the real resume-menu freeze capture (no idle input box)", () => {
		const pane = readFileSync(
			join(fixturesDir, "freeze-resume-menu.txt"),
			"utf8",
		);
		expect(detectInputBoxPresent(pane)).toBe(false);
	});
});

describe("evaluateStuckCandidate — status hard gate", () => {
	it("excludes awaiting_review as parked_review_status (FLY-191) and clears episode", () => {
		const prior: StuckEpisodeState = {
			fingerprint: fingerprintOutput("x"),
			firstStagnantAt: T0 - STUCK_THRESHOLD_MS * 2,
			escalated: false,
		};
		const r = evaluateStuckCandidate(
			baseInput({ status: "awaiting_review", output: "x", prior }),
		);
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("parked_review_status");
		expect(r.episode).toBeNull();
	});

	it("excludes approved_to_ship as parked_review_status", () => {
		const r = evaluateStuckCandidate(baseInput({ status: "approved_to_ship" }));
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("parked_review_status");
	});

	it("excludes other non-running statuses as not_running", () => {
		const r = evaluateStuckCandidate(baseInput({ status: "completed" }));
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("not_running");
	});
});

describe("evaluateStuckCandidate — pending-gate / review exclusions", () => {
	it("never flags a runner with a pending gate question (even if long-stagnant)", () => {
		const out = "⎿ flywheel-comm gate approve_to_ship ...";
		const first = evaluateStuckCandidate(
			baseInput({ output: out, hasPendingGate: true }),
		);
		const second = evaluateStuckCandidate(
			baseInput({
				output: out,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
				hasPendingGate: true,
			}),
		);
		expect(second.candidate).toBe(false);
		expect(second.exclusion).toBe("pending_gate");
		expect(second.episode).toBeNull();
	});

	// FLY-253 L1: a runner that recently messaged its Lead via CommDB is alive,
	// however static its pane looks (LEARN-57: the real liveness channel was
	// CommDB, the detector only watched the pane).
	it("never flags a runner with recent CommDB outbound activity (even if long-stagnant)", () => {
		const r = runStagnant("parked after DONE report", {
			hasRecentCommActivity: true,
		});
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("recent_comm_activity");
		expect(r.episode).toBeNull();
	});

	it("gate order: pending_gate wins over recent_comm_activity", () => {
		const r = runStagnant("parked", {
			hasPendingGate: true,
			hasRecentCommActivity: true,
		});
		expect(r.exclusion).toBe("pending_gate");
	});

	it("recent activity cancels an already-escalated episode (intentional: activity refutes the stuck condition, pending Q7 dies with it)", () => {
		const escalated: StuckEpisodeState = {
			fingerprint: fingerprintOutput("frozen frame"),
			firstStagnantAt: T0 - STUCK_THRESHOLD_MS,
			escalated: true,
			escalatedAt: T0 - 1000,
		};
		const r = evaluateStuckCandidate(
			baseInput({
				output: "frozen frame",
				prior: escalated,
				hasRecentCommActivity: true,
			}),
		);
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("recent_comm_activity");
		expect(r.episode).toBeNull();
	});

	it("absent hasRecentCommActivity behaves exactly like false (byte-compat)", () => {
		const withFalse = runStagnant("same frame", {
			hasRecentCommActivity: false,
		});
		const without = runStagnant("same frame");
		expect(withFalse.candidate).toBe(true);
		expect(without.candidate).toBe(true);
	});

	it("never flags the gray zone (needs_review emitted, status not yet flipped)", () => {
		const r = evaluateStuckCandidate(
			baseInput({
				output: "⎿ Waiting for Lead review",
				now: T0 + STUCK_THRESHOLD_MS,
				prior: {
					fingerprint: fingerprintOutput("⎿ Waiting for Lead review"),
					firstStagnantAt: T0 - STUCK_THRESHOLD_MS,
					escalated: false,
				},
				hasPendingReviewSignal: true,
			}),
		);
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("pending_review_signal");
		expect(r.episode).toBeNull();
	});
});

describe("evaluateStuckCandidate — stagnation tracking", () => {
	it("first sighting starts an episode (output_changing), not a candidate", () => {
		const r = evaluateStuckCandidate(baseInput());
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("output_changing");
		expect(r.episode).not.toBeNull();
		expect(r.episode?.firstStagnantAt).toBe(T0);
		expect(r.episode?.escalated).toBe(false);
	});

	it("stagnant but below threshold is not a candidate", () => {
		const first = evaluateStuckCandidate(baseInput());
		const r = evaluateStuckCandidate(
			baseInput({
				now: T0 + STUCK_THRESHOLD_MS - 1,
				prior: first.episode ?? undefined,
			}),
		);
		expect(r.candidate).toBe(false);
		expect(r.exclusion).toBe("below_threshold");
	});

	it("becomes a candidate once output is unchanged >= threshold", () => {
		const out =
			"⎿ Read file\nAPI Error: Stream idle timeout - partial response received\n╭──╮\n│ > │\n╰──╯";
		const r = runStagnant(out);
		expect(r.candidate).toBe(true);
		expect(r.exclusion).toBeUndefined();
		expect(r.episode?.escalated).toBe(true);
		expect(r.evidence?.stuck_minutes).toBe(10);
		expect(r.evidence?.stream_error_signature).toBe(true);
		expect(r.evidence?.input_box_present).toBe(true);
		expect(r.evidence?.tail).toContain("Stream idle timeout");
	});

	it("dedups: does not re-escalate the same episode", () => {
		const out = "stuck output";
		const candidate = runStagnant(out); // escalated=true
		expect(candidate.candidate).toBe(true);
		const again = evaluateStuckCandidate(
			baseInput({
				output: out,
				now: T0 + STUCK_THRESHOLD_MS * 2,
				prior: candidate.episode ?? undefined,
			}),
		);
		expect(again.candidate).toBe(false);
		expect(again.exclusion).toBe("already_escalated");
	});

	it("resets the episode when output changes (progress)", () => {
		const first = evaluateStuckCandidate(baseInput({ output: "a" }));
		const changed = evaluateStuckCandidate(
			baseInput({
				output: "b",
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(changed.candidate).toBe(false);
		expect(changed.exclusion).toBe("output_changing");
		expect(changed.episode?.firstStagnantAt).toBe(T0 + STUCK_THRESHOLD_MS);
		expect(changed.episode?.escalated).toBe(false);
	});

	it("candidate evidence omits stream signature when absent (general stuck cause)", () => {
		const r = runStagnant("⎿ Read file\n(no error, just stopped)\n");
		expect(r.candidate).toBe(true);
		expect(r.evidence?.stream_error_signature).toBe(false);
	});
});

// FLY-1243: FLYWHEEL_STUCK_ERRORSIG is retired — the repeated-error-signature
// path always runs now (no more `errorSigEnabled` input field, so the setup
// calls below no longer pass it). The "env unset (default)" off-path
// sentinel is deleted since that off-path no longer exists.
describe("FLY-1048 A3: repeated-error-signature path (env-gated)", () => {
	const errorPanesDir = join(
		__dirname,
		"..",
		"bridge",
		"__tests__",
		"fixtures",
		"error-panes",
	);
	const loadErrorPane = (name: string): string =>
		readFileSync(join(errorPanesDir, name), "utf8");

	const frame1 = loadErrorPane("fn1-enoent-loop-frame1.txt");
	const frame2 = loadErrorPane("fn1-enoent-loop-frame2.txt");

	it("FN1: rolling ENOENT loop (text churns) becomes a CANDIDATE when enabled", () => {
		const first = evaluateStuckCandidate(baseInput({ output: frame1 }));
		expect(first.candidate).toBe(false);
		expect(first.episode?.errorSig).toBeDefined();
		const second = evaluateStuckCandidate(
			baseInput({
				output: frame2,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(second.candidate).toBe(true);
		expect(second.evidence?.errorSignature).toBe("enoent_loop");
		expect(second.episode?.escalated).toBe(true);
		// The episode fingerprint is PINNED to the signature (stable across
		// churning text) so Lead dispositions + Q7 grace key consistently.
		expect(second.episode?.fingerprint).toBe(first.episode?.fingerprint);
	});

	// FLY-1243: the "env unset (default) keeps the pre-FLY-1048 behavior
	// byte-for-byte" off-path sentinel is deleted — there is no more
	// env/flag-off behavior to be byte-compatible with; the signature path
	// always runs (see the FN1 case above, which now exercises the same
	// scenario unconditionally).

	it("reads FLYWHEEL_STUCK_ERRORSIG=1 when the input override is absent", () => {
		process.env.FLYWHEEL_STUCK_ERRORSIG = "1";
		try {
			const first = evaluateStuckCandidate(baseInput({ output: frame1 }));
			expect(first.episode?.errorSig).toBeDefined();
		} finally {
			delete process.env.FLYWHEEL_STUCK_ERRORSIG;
		}
	});

	it("FP3: a stale error line ABOVE the evidence tail does not start tracking", () => {
		// Error long scrolled up; fresh healthy output below fills the tail.
		const stale = [
			"  ⎿  Error: ENOENT: no such file or directory, open '/tmp/x.ts'",
			...Array.from({ length: 20 }, (_, i) => `✓ processed chunk ${i}`),
		].join("\n");
		const first = evaluateStuckCandidate(baseInput({ output: stale }));
		expect(first.episode?.errorSig).toBeUndefined();
		const second = evaluateStuckCandidate(
			baseInput({
				output: `${stale}\n✓ processed chunk 20`,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(second.candidate).toBe(false);
	});

	it("signature disappearing resets the tracking", () => {
		const first = evaluateStuckCandidate(baseInput({ output: frame1 }));
		const healthy = evaluateStuckCandidate(
			baseInput({
				output: "✓ file restored\n✓ read ok\nall good",
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(healthy.candidate).toBe(false);
		expect(healthy.episode?.errorSig).toBeUndefined();
	});

	it("dedup: after the signature candidate fired, the episode is already_escalated (drives Q7)", () => {
		const first = evaluateStuckCandidate(baseInput({ output: frame1 }));
		const second = evaluateStuckCandidate(
			baseInput({
				output: frame2,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(second.candidate).toBe(true);
		const third = evaluateStuckCandidate(
			baseInput({
				output: frame1,
				now: T0 + STUCK_THRESHOLD_MS * 2,
				prior: second.episode ?? undefined,
			}),
		);
		expect(third.candidate).toBe(false);
		expect(third.exclusion).toBe("already_escalated");
		expect(third.episode?.fingerprint).toBe(second.episode?.fingerprint);
	});

	it("hard gates still win over the signature path", () => {
		const first = evaluateStuckCandidate(baseInput({ output: frame1 }));
		const gated = evaluateStuckCandidate(
			baseInput({
				output: frame2,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
				hasPendingGate: true,
			}),
		);
		expect(gated.candidate).toBe(false);
		expect(gated.exclusion).toBe("pending_gate");
	});

	it("FN2: static error-then-idle pane carries the truthful errorSignature kind", () => {
		const fn2 = loadErrorPane("fn2-server-error-then-idle.txt");
		const first = evaluateStuckCandidate(baseInput({ output: fn2 }));
		const second = evaluateStuckCandidate(
			baseInput({
				output: fn2,
				now: T0 + STUCK_THRESHOLD_MS,
				prior: first.episode ?? undefined,
			}),
		);
		expect(second.candidate).toBe(true);
		expect(second.evidence?.errorSignature).toBe("server_error_mid_response");
	});

	it("a legacy-escalated static episode is not double-alerted when the flag turns on", () => {
		const fn2 = loadErrorPane("fn2-server-error-then-idle.txt");
		// Legacy path escalated this exact static pane (flag was off).
		const legacy = runStagnant(fn2);
		expect(legacy.candidate).toBe(true);
		// Flag flips on mid-episode: same pane, signature now tracked — must NOT
		// re-emit a fresh candidate for the same static failure.
		const flipped = evaluateStuckCandidate(
			baseInput({
				output: fn2,
				now: T0 + STUCK_THRESHOLD_MS * 3,
				prior: legacy.episode ?? undefined,
			}),
		);
		expect(flipped.candidate).toBe(false);
	});
});
