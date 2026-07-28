/**
 * FLY-799 Part B — stale approved_to_ship re-wake reconciler (RED first).
 *
 * The self-ship flow flips awaiting_review → approved_to_ship + wakes the runner
 * in one pass. If that wake is missed (runner asleep, Bridge restart between the
 * write and the wake), the session strands in approved_to_ship forever. This
 * reconciler re-wakes a LIVE runner; a truly-dead runner is alerted once and
 * deferred to FLY-795 (durable resume) — it never self-ships and never reads
 * 795's progress.md.
 */

import { describe, expect, it, vi } from "vitest";
import {
	classifyStaleShipRunnerLiveness,
	deadAlertAccepted,
	isRewakeCandidate,
	reconcileStaleApprovedShip,
	shipAttemptFailedSuppressedHead,
} from "../stale-approved-ship-reconciler.js";

const NOW = 10_000_000;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const staleActivity = new Date(NOW - 10 * 60_000)
	.toISOString()
	.replace("T", " ")
	.replace("Z", "");
const freshActivity = new Date(NOW - 30_000)
	.toISOString()
	.replace("T", " ")
	.replace("Z", "");

function candidate(over: Record<string, unknown> = {}) {
	return {
		execution_id: "E-1",
		issue_id: "I",
		project_name: "proj",
		status: "approved_to_ship",
		review_question_id: "Q-1",
		pr_head_sha: HEAD_A,
		last_activity_at: staleActivity,
		tmux_session: "cmux-E1",
		...over,
	};
}

describe("isRewakeCandidate", () => {
	const opts = { nowMs: NOW, graceMs: 5 * 60_000 };

	it("approved_to_ship + real binding + pr_head + stale → true", () => {
		expect(isRewakeCandidate(candidate(), opts)).toBe(true);
	});
	it("not approved_to_ship → false", () => {
		expect(
			isRewakeCandidate(candidate({ status: "awaiting_review" }), opts),
		).toBe(false);
	});
	it("unbound review binding → false", () => {
		expect(
			isRewakeCandidate(candidate({ review_question_id: "unbound" }), opts),
		).toBe(false);
	});
	it("missing review_question_id → false", () => {
		expect(
			isRewakeCandidate(candidate({ review_question_id: undefined }), opts),
		).toBe(false);
	});
	it("missing pr_head_sha → false", () => {
		expect(isRewakeCandidate(candidate({ pr_head_sha: undefined }), opts)).toBe(
			false,
		);
	});
	it("still fresh (activity within grace) → false", () => {
		expect(
			isRewakeCandidate(candidate({ last_activity_at: freshActivity }), opts),
		).toBe(false);
	});
	it("same-head ship-attempt failure marker suppresses ONLY the automatic re-wake", () => {
		expect(
			isRewakeCandidate(
				candidate({ shipAttemptFailedHead: HEAD_A.toUpperCase() }),
				opts,
			),
		).toBe(false);
		expect(
			isRewakeCandidate(candidate({ shipAttemptFailedHead: HEAD_B }), opts),
		).toBe(true);
		expect(
			isRewakeCandidate(
				candidate({ shipAttemptFailedHead: "(unknown)" }),
				opts,
			),
		).toBe(true);
	});
});

describe("shipAttemptFailedSuppressedHead", () => {
	it("returns a normalized real marker head from a production session_params row", () => {
		expect(
			shipAttemptFailedSuppressedHead(
				JSON.stringify({
					unrelated: true,
					fly1505_ship_attempt_failed: {
						head_sha: HEAD_A.toUpperCase(),
						attempt_count: 1,
						review_question_id: "Q-1",
					},
				}),
				"Q-1",
			),
		).toBe(HEAD_A);
	});

	it("fails open for a marker from an older approval binding", () => {
		const raw = JSON.stringify({
			fly1505_ship_attempt_failed: {
				head_sha: HEAD_A,
				review_question_id: "Q-old",
			},
		});
		expect(shipAttemptFailedSuppressedHead(raw, "Q-new")).toBeUndefined();
	});

	it.each([
		undefined,
		null,
		"",
		"{bad-json",
		JSON.stringify({}),
		JSON.stringify({ fly1505_ship_attempt_failed: {} }),
		JSON.stringify({
			fly1505_ship_attempt_failed: { head_sha: "(unknown)" },
		}),
		JSON.stringify({
			fly1505_ship_attempt_failed: { head_sha: "not-a-sha" },
		}),
	])("fails open for malformed, missing, or sentinel params: %j", (raw) => {
		expect(shipAttemptFailedSuppressedHead(raw, "Q-1")).toBeUndefined();
	});
});

describe("reconcileStaleApprovedShip", () => {
	function deps(over: Record<string, unknown> = {}) {
		return {
			sessions: [candidate()],
			nowMs: NOW,
			graceMs: 5 * 60_000,
			backoffMs: 5 * 60_000,
			backoff: new Map<string, number>(),
			deadAlerted: new Set<string>(),
			probe: vi.fn().mockResolvedValue("alive"),
			reWake: vi.fn().mockResolvedValue(undefined),
			alertDead: vi.fn().mockResolvedValue(true),
			diagnose: vi.fn(),
			...over,
		};
	}

	it("live runner → re-wakes it (approval), does not alert", async () => {
		const d = deps();
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r.rewoken).toEqual(["E-1"]);
		expect(d.reWake).toHaveBeenCalledOnce();
		expect(d.alertDead).not.toHaveBeenCalled();
	});

	it("dead runner → alerts once (defer to 795), never re-wakes", async () => {
		const d = deps({ probe: vi.fn().mockResolvedValue("dead") });
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r.deadAlerted).toEqual(["E-1"]);
		expect(d.reWake).not.toHaveBeenCalled();
		expect(d.alertDead).toHaveBeenCalledOnce();
	});

	it("dead runner alerted only ONCE across passes (no spam)", async () => {
		const shared = { deadAlerted: new Set<string>() };
		const d1 = deps({
			probe: vi.fn().mockResolvedValue("dead"),
			deadAlerted: shared.deadAlerted,
			backoff: new Map<string, number>(),
		});
		await reconcileStaleApprovedShip(d1 as never);
		const d2 = deps({
			probe: vi.fn().mockResolvedValue("dead"),
			deadAlerted: shared.deadAlerted, // survives across passes
			backoff: new Map<string, number>(),
		});
		await reconcileStaleApprovedShip(d2 as never);
		expect(d2.alertDead).not.toHaveBeenCalled();
	});

	it("per-session backoff: skips a session re-woken within the backoff window", async () => {
		const backoff = new Map<string, number>();
		const d1 = deps({ backoff });
		await reconcileStaleApprovedShip(d1 as never);
		const d2 = deps({ backoff }); // same nowMs → still inside backoff window
		const r2 = await reconcileStaleApprovedShip(d2 as never);
		expect(r2.rewoken).toEqual([]);
		expect(d2.reWake).not.toHaveBeenCalled();
	});

	it("skips non-candidates (fresh / wrong status) without probing", async () => {
		const d = deps({
			sessions: [candidate({ last_activity_at: freshActivity })],
		});
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r.rewoken).toEqual([]);
		expect(d.probe).not.toHaveBeenCalled();
	});

	it("does not dedup a dead alert until the sink durably accepts it", async () => {
		const deadAlerted = new Set<string>();
		const first = deps({
			probe: vi.fn().mockResolvedValue("dead"),
			deadAlerted,
			alertDead: vi.fn().mockResolvedValue(false),
		});
		const r1 = await reconcileStaleApprovedShip(first as never);
		expect(r1.deadAlerted).toEqual([]);
		expect(deadAlerted.size).toBe(0);

		const second = deps({
			probe: vi.fn().mockResolvedValue("dead"),
			deadAlerted,
			alertDead: vi.fn().mockResolvedValue(true),
		});
		const r2 = await reconcileStaleApprovedShip(second as never);
		expect(r2.deadAlerted).toEqual(["E-1"]);
		expect(deadAlerted.has("E-1")).toBe(true);
	});

	it("indeterminate liveness is observable and takes the harmless re-wake path without declaring death", async () => {
		const d = deps({ probe: vi.fn().mockResolvedValue("indeterminate") });
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r).toEqual({ rewoken: ["E-1"], deadAlerted: [] });
		expect(d.reWake).toHaveBeenCalledOnce();
		expect(d.alertDead).not.toHaveBeenCalled();
		expect(d.diagnose).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "E-1" }),
			"indeterminate",
		);
	});

	it("a probe error also fails open only to the idempotent re-wake", async () => {
		const d = deps({
			probe: vi.fn().mockRejectedValue(new Error("probe unavailable")),
		});
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r).toEqual({ rewoken: ["E-1"], deadAlerted: [] });
		expect(d.reWake).toHaveBeenCalledOnce();
		expect(d.alertDead).not.toHaveBeenCalled();
		expect(d.diagnose).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "E-1" }),
			"probe_error",
		);
	});
});

describe("classifyStaleShipRunnerLiveness", () => {
	it.each([
		["alive", "alive"],
		["dead_pin", "dead"],
		["absent", "indeterminate"],
		["indeterminate", "indeterminate"],
	] as const)("maps exact-target %s evidence to %s", (evidence, expected) => {
		expect(classifyStaleShipRunnerLiveness(evidence)).toBe(expected);
	});
});

describe("deadAlertAccepted", () => {
	it("treats a claims-dedup duplicate as durable acceptance", () => {
		expect(deadAlertAccepted({ skipped: "duplicate" })).toBe(true);
	});

	it("does not turn an undeliverable skip into acceptance", () => {
		expect(deadAlertAccepted({ skipped: "no-channel" })).toBe(false);
	});
});
