import { describe, expect, it } from "vitest";
import {
	classifyQuiet,
	normalizeForQuietFingerprint,
	type QuietSignals,
	quietFingerprint,
} from "../bridge/quiet-classifier.js";

function base(over: Partial<QuietSignals> = {}): QuietSignals {
	return {
		status: "running",
		hasPendingGate: false,
		hasRecentComm: false,
		hasPendingReviewSignal: false,
		declaredKind: null,
		...over,
	};
}

describe("classifyQuiet (FLY-626) — cheap stateless exemption", () => {
	it("an unexplained quiet running session may wake the Lead", () => {
		const r = classifyQuiet(base());
		expect(r.verdict).toBe("quiet_unexplained");
		expect(r.mayWake).toBe(true);
	});

	it("a self-declared parked runner never wakes the Lead", () => {
		const r = classifyQuiet(base({ declaredKind: "parked" }));
		expect(r.verdict).toBe("self_parked");
		expect(r.mayWake).toBe(false);
	});

	it("a self-declared long_task runner never wakes the Lead", () => {
		const r = classifyQuiet(base({ declaredKind: "long_task" }));
		expect(r.verdict).toBe("self_long_task");
		expect(r.mayWake).toBe(false);
	});

	it("a pending gate exempts (legitimately parked at a gate)", () => {
		const r = classifyQuiet(base({ hasPendingGate: true }));
		expect(r.verdict).toBe("pending_gate");
		expect(r.mayWake).toBe(false);
	});

	it("recent comm activity exempts (mechanically alive)", () => {
		const r = classifyQuiet(base({ hasRecentComm: true }));
		expect(r.verdict).toBe("recent_comm");
		expect(r.mayWake).toBe(false);
	});

	it("a pending review signal exempts (gray zone)", () => {
		const r = classifyQuiet(base({ hasPendingReviewSignal: true }));
		expect(r.verdict).toBe("review_signal");
		expect(r.mayWake).toBe(false);
	});

	it("a non-running review status exempts (parked-review)", () => {
		for (const status of ["awaiting_review", "approved_to_ship"]) {
			const r = classifyQuiet(base({ status }));
			expect(r.verdict).toBe("parked_review_status");
			expect(r.mayWake).toBe(false);
		}
	});

	it("a declared marker wins over an unexplained quiet (precedence)", () => {
		// even with no other exemption, declared parked must suppress
		expect(classifyQuiet(base({ declaredKind: "parked" })).mayWake).toBe(false);
	});

	// FLY-637 #1: explicit FLY-324 done-but-running skip
	it("an explicit done-but-running session never wakes the Lead", () => {
		const r = classifyQuiet(base({ isDoneButRunning: true }));
		expect(r.verdict).toBe("done_but_running");
		expect(r.mayWake).toBe(false);
	});

	it("done_but_running takes precedence over an otherwise unexplained quiet", () => {
		// no declared marker / gate / comm — would be quiet_unexplained, but the
		// explicit FLY-324 signal must short-circuit to a non-waking verdict.
		const r = classifyQuiet(base({ isDoneButRunning: true }));
		expect(r.mayWake).toBe(false);
	});

	it("absent/false isDoneButRunning preserves pre-FLY-637 behavior (byte-compat)", () => {
		// default base() omits isDoneButRunning → unchanged quiet_unexplained
		expect(classifyQuiet(base()).verdict).toBe("quiet_unexplained");
		expect(classifyQuiet(base({ isDoneButRunning: false })).verdict).toBe(
			"quiet_unexplained",
		);
	});

	it("a non-running done-but-running session still reads as parked_review_status (status gate first)", () => {
		// status gate runs BEFORE the done_but_running check; a non-running status
		// short-circuits regardless of the FLY-324 flag.
		const r = classifyQuiet(
			base({ status: "awaiting_review", isDoneButRunning: true }),
		);
		expect(r.verdict).toBe("parked_review_status");
		expect(r.mayWake).toBe(false);
	});
});

describe("quietFingerprint / normalize (FLY-626) — pane-jitter immunity", () => {
	const PANE_A = [
		"⎿ Reading files...",
		"Searching the codebase for the handler",
		"────────────────────────────────────── @runner ──",
		"❯ ",
		"──────────────────────────────────────",
		"Opus 4.8/xhigh | ⚡runner | ctx 11%",
		"✻ Cooked for 12s",
		"⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");

	// Same real content; only the volatile status-bar / spinner churned.
	const PANE_B = [
		"⎿ Reading files...",
		"Searching the codebase for the handler",
		"────────────────────────────────────── @runner ──",
		"❯ ",
		"──────────────────────────────────────",
		"Opus 4.8/xhigh | ⚡runner | ctx 14%",
		"✻ Cooked for 47s",
		"⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");

	const PANE_C = [
		"⎿ Reading files...",
		"Now editing the handler implementation", // real progress
		"────────────────────────────────────── @runner ──",
		"❯ ",
		"──────────────────────────────────────",
		"Opus 4.8/xhigh | ⚡runner | ctx 14%",
		"✻ Cooked for 47s",
		"⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");

	it("collapses status-bar ctx% + spinner-timer jitter to the same fingerprint", () => {
		expect(quietFingerprint(PANE_A)).toBe(quietFingerprint(PANE_B));
	});

	it("still distinguishes real content change", () => {
		expect(quietFingerprint(PANE_A)).not.toBe(quietFingerprint(PANE_C));
	});

	it("normalize drops the volatile lines", () => {
		const n = normalizeForQuietFingerprint(PANE_A);
		expect(n).not.toMatch(/ctx \d+%/);
		expect(n).not.toMatch(/Cooked for \d+s/);
		expect(n).not.toMatch(/bypass permissions/);
		expect(n).toMatch(/Reading files/);
	});
});
