/**
 * FLY-245 D2 — authoritative started-evidence checker (plan §5.2.1, R4-HIGH +
 * the R5 implementation note). The R5 distinctions are the point of this suite:
 *   - a CommDB row EXISTING is NOT evidence (row exists ≠ live);
 *   - a `:pending` row is pre-registration, NOT started;
 *   - (early StateStore `session_started` events are never consulted at all —
 *     the checker reads only CommDB + a live tmux probe, by construction).
 *
 * Codex code-review R1 HIGH-4: the liveness probe must be TRI-STATE. Only a
 * "window/session genuinely not found" answer is `tmux_dead`; a timeout /
 * ENOENT / EACCES / unknown error is `indeterminate` → `lookup_error`
 * (fail-closed), NOT a false "dead" that would re-dispatch a second Runner.
 */
import { describe, expect, it, vi } from "vitest";
import { checkStartedEvidence } from "../started-evidence.js";
import type { TmuxTargetLookup, TmuxWindowProbe } from "../tmux-lookup.js";

const EXEC = "succ-exec-1";
const PROJ = "geoforge3d";

function lookupOf(result: TmuxTargetLookup) {
	return vi.fn((_e: string, _p: string) => result);
}

function probeOf(result: TmuxWindowProbe) {
	return vi.fn(async (_w: string) => result);
}

describe("checkStartedEvidence (D2)", () => {
	it("no CommDB row → not started (no_row)", async () => {
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({ kind: "gone" }),
			probeWindow: probeOf("alive"),
		});
		expect(res).toEqual({ started: false, reason: "no_row" });
	});

	it("`:pending` pre-registration row is NOT started evidence, even with a live shared session", async () => {
		const probeWindow = probeOf("alive");
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({
				kind: "found",
				target: {
					tmuxWindow: "runner-geoforge3d:pending",
					sessionName: "runner-geoforge3d",
				},
			}),
			probeWindow,
		});
		expect(res).toEqual({ started: false, reason: "pending_only" });
		// the probe must not even run — a pending row can never become evidence
		expect(probeWindow).not.toHaveBeenCalled();
	});

	it("non-pending row whose tmux window is provably dead → not started (row exists ≠ live)", async () => {
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({
				kind: "found",
				target: {
					tmuxWindow: "runner-geoforge3d:@42",
					sessionName: "runner-geoforge3d",
				},
			}),
			probeWindow: probeOf("dead"),
		});
		expect(res).toEqual({ started: false, reason: "tmux_dead" });
	});

	it("non-pending row + live tmux window → STARTED (the one authoritative shape)", async () => {
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({
				kind: "found",
				target: {
					tmuxWindow: "runner-geoforge3d:@42",
					sessionName: "runner-geoforge3d",
				},
			}),
			probeWindow: probeOf("alive"),
		});
		expect(res).toEqual({ started: true, tmuxWindow: "runner-geoforge3d:@42" });
	});

	it("an INDETERMINATE probe (timeout/EACCES/ENOENT) → lookup_error, NEVER tmux_dead (HIGH-4)", async () => {
		// This is the exact false-negative HIGH-4 flags: a transient probe failure
		// must not look like "the runner never started" — that would re-dispatch.
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({
				kind: "found",
				target: {
					tmuxWindow: "runner-geoforge3d:@42",
					sessionName: "runner-geoforge3d",
				},
			}),
			probeWindow: probeOf("indeterminate"),
		});
		expect(res).toEqual({ started: false, reason: "lookup_error" });
	});

	it("CommDB lookup error → lookup_error (fail-closed: cannot prove either way)", async () => {
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({ kind: "error", error: "db locked" }),
			probeWindow: probeOf("alive"),
		});
		expect(res).toEqual({ started: false, reason: "lookup_error" });
	});

	it("a thrown probe is lookup_error (fail-closed), never a guess", async () => {
		const res = await checkStartedEvidence(EXEC, PROJ, {
			lookup: lookupOf({
				kind: "found",
				target: { tmuxWindow: "s:@1", sessionName: "s" },
			}),
			probeWindow: vi.fn(async () => {
				throw new Error("tmux exploded");
			}),
		});
		expect(res).toEqual({ started: false, reason: "lookup_error" });
	});
});
