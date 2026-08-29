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
	isRewakeCandidate,
	reconcileStaleApprovedShip,
} from "../stale-approved-ship-reconciler.js";

const NOW = 10_000_000;
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
		pr_head_sha: "sha-1",
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
			isAlive: vi.fn().mockResolvedValue(true),
			reWake: vi.fn().mockResolvedValue(undefined),
			alertDead: vi.fn().mockResolvedValue(undefined),
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
		const d = deps({ isAlive: vi.fn().mockResolvedValue(false) });
		const r = await reconcileStaleApprovedShip(d as never);
		expect(r.deadAlerted).toEqual(["E-1"]);
		expect(d.reWake).not.toHaveBeenCalled();
		expect(d.alertDead).toHaveBeenCalledOnce();
	});

	it("dead runner alerted only ONCE across passes (no spam)", async () => {
		const shared = { deadAlerted: new Set<string>() };
		const d1 = deps({
			isAlive: vi.fn().mockResolvedValue(false),
			deadAlerted: shared.deadAlerted,
			backoff: new Map<string, number>(),
		});
		await reconcileStaleApprovedShip(d1 as never);
		const d2 = deps({
			isAlive: vi.fn().mockResolvedValue(false),
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
		expect(d.isAlive).not.toHaveBeenCalled();
	});
});
