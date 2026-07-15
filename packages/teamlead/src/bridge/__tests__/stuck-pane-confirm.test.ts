/**
 * FLY-1234 (T1): the heartbeat stuck-confirm pure decision module.
 *
 * Decision table (plan §T1) row by row, knob parsing bounds (R2 #6),
 * deadline isolation (R2 #3), the "repeated signature is never downgraded"
 * contract (R2 #5), the target_gone wording contract (R1 #7), and the
 * heartbeat judge cache key (R3 #4 + R4 #1/#2).
 */

import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import { scanErrorSignatures } from "../error-signatures.js";
import {
	buildHeartbeatJudgeCacheKey,
	CONFIRM_NOTES,
	confirmStuckCandidate,
	type JudgeDecision,
	parseStuckConfirmKnobs,
	STUCK_CONFIRM_DEADLINE_MS_DEFAULT,
	STUCK_CONFIRM_PER_TICK_DEFAULT,
	STUCK_FRAME_GAP_MS_DEFAULT,
	type StuckConfirmDeps,
} from "../stuck-pane-confirm.js";
import type { WatchdogJudgeInput } from "../watchdog-judge.js";

function session(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-confirm-1",
		issue_id: "FLY-1234",
		issue_identifier: "FLY-1234",
		project_name: "flywheel",
		status: "running",
		last_activity_at: "2026-07-13 18:00:00",
		...over,
	} as Session;
}

/**
 * Test sleep: the frame gap resolves immediately; the DEADLINE sleep hangs
 * forever (deadline tests inject their own manual scheduler). A both-instant
 * sleep would make the deadline race the work and win nondeterministically.
 */
const instantGapSleep = (ms: number) =>
	ms >= 90_000 ? new Promise<void>(() => {}) : Promise.resolve();

function makeDeps(over: Partial<StuckConfirmDeps> = {}): StuckConfirmDeps {
	return {
		probeLiveness: async () => "alive",
		captureFrame: async () => ({ text: "static frame", capturedAtMs: 1 }),
		frameGapMs: 15_000,
		deadlineMs: 90_000,
		sleep: instantGapSleep,
		scanErrorSignatures,
		routeToJudge: async () => ({
			outcome: "delivered",
			decision: "unavailable",
		}),
		...over,
	};
}

/** Yield event-loop turns until cond() holds (bounded). */
async function waitUntil(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000 && !cond(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
	if (!cond()) throw new Error("waitUntil: condition never became true");
}

describe("parseStuckConfirmKnobs (T0, R2 #6)", () => {
	it("returns defaults on empty env", () => {
		expect(parseStuckConfirmKnobs({})).toEqual({
			frameGapMs: STUCK_FRAME_GAP_MS_DEFAULT,
			perTick: STUCK_CONFIRM_PER_TICK_DEFAULT,
			deadlineMs: STUCK_CONFIRM_DEADLINE_MS_DEFAULT,
		});
	});

	it("accepts legal values", () => {
		expect(
			parseStuckConfirmKnobs({
				FLYWHEEL_STUCK_FRAME_GAP_MS: "20000",
				FLYWHEEL_STUCK_CONFIRM_PER_TICK: "5",
				FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS: "120000",
			}),
		).toEqual({ frameGapMs: 20_000, perTick: 5, deadlineMs: 120_000 });
	});

	it.each([
		["garbage", "abc"],
		["zero", "0"],
		["negative", "-5"],
		["over-cap", "9999999"],
		["empty string", ""],
		// Codex code R1 #5: parseInt prefix-parsing must NOT sneak these in.
		["unit suffix", "20000ms"],
		["trailing garbage", "3oops"],
		["non-integer", "120000.5"],
	])("falls back to default on %s (never 0, never over-cap)", (_label, raw) => {
		const knobs = parseStuckConfirmKnobs({
			FLYWHEEL_STUCK_FRAME_GAP_MS: raw,
			FLYWHEEL_STUCK_CONFIRM_PER_TICK: raw,
			FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS: raw,
		});
		expect(knobs).toEqual({
			frameGapMs: STUCK_FRAME_GAP_MS_DEFAULT,
			perTick: STUCK_CONFIRM_PER_TICK_DEFAULT,
			deadlineMs: STUCK_CONFIRM_DEADLINE_MS_DEFAULT,
		});
	});

	it("cross-field contradiction (gap >= deadline) → BOTH default + warn once", () => {
		const warn = vi.fn();
		// Each individually legal: gap 50s (≤60s cap), deadline 40s (≤300s cap).
		const knobs = parseStuckConfirmKnobs(
			{
				FLYWHEEL_STUCK_FRAME_GAP_MS: "50000",
				FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS: "40000",
			},
			{ warn },
		);
		expect(knobs.frameGapMs).toBe(STUCK_FRAME_GAP_MS_DEFAULT);
		expect(knobs.deadlineMs).toBe(STUCK_CONFIRM_DEADLINE_MS_DEFAULT);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("no warn sink → cross-field fallback still applies silently", () => {
		const knobs = parseStuckConfirmKnobs({
			FLYWHEEL_STUCK_FRAME_GAP_MS: "50000",
			FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS: "40000",
		});
		expect(knobs.frameGapMs).toBe(STUCK_FRAME_GAP_MS_DEFAULT);
		expect(knobs.deadlineMs).toBe(STUCK_CONFIRM_DEADLINE_MS_DEFAULT);
	});
});

describe("confirmStuckCandidate — step ① liveness (death detector only)", () => {
	it.each([
		["dead_pin", "dead_pin"],
		["absent", "target_absent"],
		["gone", "target_gone"],
		["indeterminate", "lookup_indeterminate"],
	] as const)("%s → emit(%s)", async (liveness, reason) => {
		const capture = vi.fn();
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({
				probeLiveness: async () => liveness,
				captureFrame: capture as never,
			}),
		);
		expect(result.action).toBe("emit");
		expect(result.reason).toBe(reason);
		expect(result.confirmNote).toBe(CONFIRM_NOTES[reason]);
		expect(capture).not.toHaveBeenCalled(); // dead → no frames wasted
	});

	it("target_gone annotation never claims process death (R1 #7)", () => {
		expect(CONFIRM_NOTES.target_gone).not.toMatch(/dead|corpse|died|进程死/i);
		expect(CONFIRM_NOTES.target_gone).toMatch(/not resolvable/);
	});

	it("alive alone NEVER suppresses — it only advances to frames (INV-6)", async () => {
		// alive + static frames + judge unavailable → EMIT, not suppress.
		const result = await confirmStuckCandidate(session(), makeDeps());
		expect(result.action).toBe("emit");
		expect(result.reason).toBe("judge_unavailable");
	});
});

describe("confirmStuckCandidate — step ② two frames", () => {
	it("first capture fails → emit(capture_failed)", async () => {
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({ captureFrame: async () => null }),
		);
		expect(result).toMatchObject({ action: "emit", reason: "capture_failed" });
	});

	it("second capture fails → emit(capture_failed)", async () => {
		let call = 0;
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({
				captureFrame: async () =>
					++call === 1 ? { text: "frame", capturedAtMs: 1 } : null,
			}),
		);
		expect(result).toMatchObject({ action: "emit", reason: "capture_failed" });
	});

	it("frames differ + no signature → suppress(frames_changing), judge NOT consulted", async () => {
		let call = 0;
		const judge = vi.fn();
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({
				captureFrame: async () => ({
					text: `✻ Cooked for ${++call}s\n❯ working`,
					capturedAtMs: call,
				}),
				routeToJudge: judge as never,
			}),
		);
		expect(result).toMatchObject({
			action: "suppress",
			reason: "frames_changing",
		});
		expect(judge).not.toHaveBeenCalled();
	});

	it("common normalized (kind, signature) across BOTH frames → emit(repeated_error_signature), judge NOT consulted (R2 #5: never downgradable)", async () => {
		let call = 0;
		// Different raw frames (attempt counter changes) but the SAME normalized
		// ENOENT signature — the rolling-error-loop formation.
		const judge = vi.fn(
			async (): Promise<JudgeDecision> => ({
				outcome: "suppressed",
				decision: "a_working", // a hostile downgrade attempt — must not be reachable
			}),
		);
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({
				captureFrame: async () => ({
					text: `retrying (attempt ${++call})\nError: ENOENT /tmp/gone-${call}`,
					capturedAtMs: call,
				}),
				routeToJudge: judge as never,
			}),
		);
		expect(result).toMatchObject({
			action: "emit",
			reason: "repeated_error_signature",
		});
		expect(judge).not.toHaveBeenCalled();
	});

	it("frames differ + ONE-SIDED signature → judge consulted with the kinds union (R3 #2)", async () => {
		let call = 0;
		let seenKinds: string[] = [];
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({
				captureFrame: async () =>
					++call === 1
						? { text: "❯ running tests", capturedAtMs: 1 }
						: { text: "Error: ENOENT /tmp/x\n❯", capturedAtMs: 2 },
				routeToJudge: async (_r, ctx) => {
					seenKinds = ctx.errorSignatureKinds;
					return { outcome: "delivered", decision: "suspicious" };
				},
			}),
		);
		expect(result).toMatchObject({
			action: "emit",
			reason: "judge_suspicious",
		});
		expect(seenKinds).toEqual(["enoent_loop"]);
	});

	it("identical static frames, no signature → judge consulted", async () => {
		const judge = vi.fn(
			async (): Promise<JudgeDecision> => ({
				outcome: "suppressed",
				decision: "a_working",
			}),
		);
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({ routeToJudge: judge as never }),
		);
		expect(result).toMatchObject({
			action: "suppress",
			reason: "judge_a_working",
		});
		expect(judge).toHaveBeenCalledTimes(1);
	});

	it("the judge report carries the REAL frames + execId targetKey", async () => {
		let seenReport: unknown;
		await confirmStuckCandidate(
			session({ execution_id: "exec-frames" }),
			makeDeps({
				captureFrame: async () => ({
					text: "codex exec — review running\ntail line",
					capturedAtMs: 7,
				}),
				routeToJudge: async (r) => {
					seenReport = r;
					return { outcome: "delivered", decision: "unavailable" };
				},
			}),
		);
		expect(seenReport).toMatchObject({
			targetKind: "runner",
			targetKey: "exec-frames",
			frames: [
				{ text: "codex exec — review running\ntail line", capturedAtMs: 7 },
				{ text: "codex exec — review running\ntail line", capturedAtMs: 7 },
			],
		});
		// Pane tail is bounded evidence, never empty for a non-empty frame.
		expect((seenReport as { paneTail: string }).paneTail).toContain(
			"tail line",
		);
	});
});

describe("confirmStuckCandidate — step ③ judge decisions", () => {
	it.each([
		[
			{ outcome: "suppressed", decision: "a_working" },
			"suppress",
			"judge_a_working",
		],
		[
			{ outcome: "suppressed", decision: "b_parked" },
			"suppress",
			"judge_b_parked",
		],
		[
			{ outcome: "delivered", decision: "c_stuck" },
			"emit",
			"frames_static_judge_c_stuck",
		],
		[
			{ outcome: "delivered", decision: "suspicious" },
			"emit",
			"judge_suspicious",
		],
		[
			{ outcome: "delivered", decision: "unavailable" },
			"emit",
			"judge_unavailable",
		],
	] as const)("judge %o → %s(%s)", async (decision, action, reason) => {
		const result = await confirmStuckCandidate(
			session(),
			makeDeps({ routeToJudge: async () => decision as JudgeDecision }),
		);
		expect(result.action).toBe(action);
		expect(result.reason).toBe(reason);
		if (action === "emit") {
			expect(result.confirmNote).toBe(
				CONFIRM_NOTES[reason as keyof typeof CONFIRM_NOTES],
			);
		}
	});
});

describe("confirmStuckCandidate — fail-open lineage (INV-1)", () => {
	it.each([
		[
			"probeLiveness throws",
			{
				probeLiveness: async () => {
					throw new Error("tmux exploded");
				},
			},
		],
		[
			"captureFrame throws",
			{
				captureFrame: async () => {
					throw new Error("capture exploded");
				},
			},
		],
		[
			"routeToJudge throws",
			{
				routeToJudge: async () => {
					throw new Error("routing exploded");
				},
			},
		],
	] as const)("%s → emit(confirm_error)", async (_label, over) => {
		const result = await confirmStuckCandidate(
			session(),
			makeDeps(over as Partial<StuckConfirmDeps>),
		);
		expect(result).toMatchObject({ action: "emit", reason: "confirm_error" });
		expect(result.confirmNote).toBe(CONFIRM_NOTES.confirm_error);
	});
});

describe("confirmStuckCandidate — deadline (R1 #2 / R2 #3)", () => {
	/**
	 * Fake scheduler: sleeps resolve ONLY when the test releases them, so the
	 * test deterministically decides which side of the race wins.
	 */
	function manualSleeps() {
		const pending: Array<{ ms: number; resolve: () => void }> = [];
		return {
			sleep: (ms: number) =>
				new Promise<void>((resolve) => {
					pending.push({ ms, resolve });
				}),
			release: (predicate: (ms: number) => boolean) => {
				for (const p of pending.filter((p) => predicate(p.ms))) p.resolve();
			},
			pending,
		};
	}

	it("deadline expiry → emit(deadline_exceeded); a LATE a_working is isolated (no rewrite)", async () => {
		const sched = manualSleeps();
		let judgeCalled = false;
		let resolveJudge: ((d: JudgeDecision) => void) | undefined;
		const promise = confirmStuckCandidate(
			session(),
			makeDeps({
				frameGapMs: 15_000,
				deadlineMs: 90_000,
				sleep: sched.sleep,
				routeToJudge: () => {
					judgeCalled = true;
					return new Promise<JudgeDecision>((resolve) => {
						resolveJudge = resolve;
					});
				},
			}),
		);
		// Let the frame gap pass, wait until the judge is genuinely hanging,
		// THEN fire the deadline.
		await waitUntil(() => sched.pending.some((p) => p.ms === 15_000));
		sched.release((ms) => ms === 15_000);
		await waitUntil(() => judgeCalled);
		sched.release((ms) => ms === 90_000);
		const result = await promise;
		expect(result).toMatchObject({
			action: "emit",
			reason: "deadline_exceeded",
		});
		// The judge answers LATE — the already-returned result must not change,
		// and nothing throws (the late resolution lands in a discarded promise).
		resolveJudge?.({ outcome: "suppressed", decision: "a_working" });
		await new Promise((r) => setTimeout(r, 0));
		expect(result.reason).toBe("deadline_exceeded");
	});

	it("late c_stuck after deadline is equally isolated", async () => {
		const sched = manualSleeps();
		let judgeCalled = false;
		let resolveJudge: ((d: JudgeDecision) => void) | undefined;
		const promise = confirmStuckCandidate(
			session(),
			makeDeps({
				sleep: sched.sleep,
				routeToJudge: () => {
					judgeCalled = true;
					return new Promise<JudgeDecision>((resolve) => {
						resolveJudge = resolve;
					});
				},
			}),
		);
		await waitUntil(() => sched.pending.some((p) => p.ms === 15_000));
		sched.release((ms) => ms === 15_000);
		await waitUntil(() => judgeCalled);
		sched.release((ms) => ms === 90_000);
		const result = await promise;
		expect(result.reason).toBe("deadline_exceeded");
		resolveJudge?.({ outcome: "delivered", decision: "c_stuck" });
		await new Promise((r) => setTimeout(r, 0));
		expect(result.reason).toBe("deadline_exceeded");
	});

	it("work finishing before the deadline wins the race", async () => {
		const sched = manualSleeps();
		const promise = confirmStuckCandidate(
			session(),
			makeDeps({
				sleep: sched.sleep,
				routeToJudge: async () => ({
					outcome: "suppressed",
					decision: "a_working",
				}),
			}),
		);
		await waitUntil(() => sched.pending.some((p) => p.ms === 15_000));
		sched.release((ms) => ms === 15_000); // frame gap only — deadline never fires
		const result = await promise;
		expect(result).toMatchObject({
			action: "suppress",
			reason: "judge_a_working",
		});
	});
});

describe("buildHeartbeatJudgeCacheKey (T4, R3 #4 + R4 #1/#2)", () => {
	const baseReport = {
		targetKind: "runner" as const,
		targetKey: "exec-a",
		reason: "r",
		paneTail: "t",
		episodeFingerprint: "fp",
	};
	function input(over: Partial<WatchdogJudgeInput> = {}): WatchdogJudgeInput {
		return {
			frames: [
				{ text: "frame one", capturedAtMs: 100 },
				{ text: "frame one", capturedAtMs: 200 },
			],
			stage: "implement",
			fsmStatus: "running",
			park: null,
			commEvents: [
				{ kind: "stage_changed", ageMs: 60_000, summary: "implement" },
			],
			errorSignatureKinds: [],
			...over,
		};
	}
	const OPTS = { commCorroborationMs: 1_800_000 };

	it("same exec + same evidence, only wall clock moved (bucket unchanged) → SAME key (cache hit)", () => {
		const k1 = buildHeartbeatJudgeCacheKey(baseReport, input(), OPTS);
		const k2 = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				frames: [
					{ text: "frame one", capturedAtMs: 999_100 }, // capturedAtMs excluded
					{ text: "frame one", capturedAtMs: 999_200 },
				],
				commEvents: [
					// age moved 60s → 120s but stays inside the corroboration bucket
					{ kind: "stage_changed", ageMs: 120_000, summary: "implement" },
				],
			}),
			OPTS,
		);
		expect(k2).toBe(k1);
	});

	it.each([
		["frame text", { frames: [{ text: "frame CHANGED", capturedAtMs: 100 }] }],
		["stage", { stage: "qa" }],
		["fsm", { fsmStatus: "awaiting_review" }],
		["sig kinds", { errorSignatureKinds: ["enoent_loop"] }],
	] as const)("evidence component change (%s) → different key", (_l, over) => {
		const k1 = buildHeartbeatJudgeCacheKey(baseReport, input(), OPTS);
		const k2 = buildHeartbeatJudgeCacheKey(
			baseReport,
			input(over as Partial<WatchdogJudgeInput>),
			OPTS,
		);
		expect(k2).not.toBe(k1);
	});

	it("R4 #1 named case: same issue, design+implement runners in parallel — similar panes, DIFFERENT execIds → never share a verdict key", () => {
		// Lead handoff addendum ②: FLY-1224-style dual-phase parallelism. The
		// evidence projections are IDENTICAL by construction; only the execution
		// identity differs — the keys must still differ.
		const designReport = { ...baseReport, targetKey: "exec-design-0d1" };
		const implementReport = { ...baseReport, targetKey: "exec-impl-e8c" };
		const sharedEvidence = input({
			frames: [
				{ text: "✻ Thinking…\n❯ codex review wait", capturedAtMs: 1 },
				{ text: "✻ Thinking…\n❯ codex review wait", capturedAtMs: 2 },
			],
		});
		const kDesign = buildHeartbeatJudgeCacheKey(
			designReport,
			sharedEvidence,
			OPTS,
		);
		const kImplement = buildHeartbeatJudgeCacheKey(
			implementReport,
			sharedEvidence,
			OPTS,
		);
		expect(kDesign).not.toBe(kImplement);
	});

	it("R4 #2 named regression: comm event aging across the corroboration threshold → different key (stale corroboration cannot ride a cached a_working)", () => {
		const fresh = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				commEvents: [{ kind: "progress", ageMs: 1_700_000, summary: "s" }],
			}),
			OPTS,
		);
		const aged = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				commEvents: [{ kind: "progress", ageMs: 1_900_000, summary: "s" }],
			}),
			OPTS,
		);
		expect(aged).not.toBe(fresh);
	});

	it("commCorroborationMs=0 → recency bucket constantly false (in step with the disabled quiet exemption)", () => {
		const k1 = buildHeartbeatJudgeCacheKey(baseReport, input(), {
			commCorroborationMs: 0,
		});
		const k2 = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				commEvents: [
					{ kind: "stage_changed", ageMs: 999_999_999, summary: "implement" },
				],
			}),
			{ commCorroborationMs: 0 },
		);
		expect(k2).toBe(k1); // any age lands in the same (false) bucket
	});

	it("boundary collision: frames ['ab','c'] vs ['a','bc'] → different keys (JSON structure, no concatenation)", () => {
		const k1 = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				frames: [
					{ text: "ab", capturedAtMs: 1 },
					{ text: "c", capturedAtMs: 2 },
				],
			}),
			OPTS,
		);
		const k2 = buildHeartbeatJudgeCacheKey(
			baseReport,
			input({
				frames: [
					{ text: "a", capturedAtMs: 1 },
					{ text: "bc", capturedAtMs: 2 },
				],
			}),
			OPTS,
		);
		expect(k2).not.toBe(k1);
	});
});
