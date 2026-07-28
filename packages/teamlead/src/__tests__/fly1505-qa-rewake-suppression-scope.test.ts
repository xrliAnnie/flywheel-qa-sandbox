/**
 * FLY-1505 QA characterization: how WIDE is the C7 re-wake suppression really?
 *
 * The plan (§4 / §7) states C7 "只停自动 re-wake" — only the automatic
 * approval_wake is paused. The implementation puts the suppressor inside
 * `isRewakeCandidate`, which is the single `continue` gate at the top of
 * `reconcileStaleApprovedShip`'s loop. Skipping candidacy therefore also skips
 * that pass's liveness probe and its one-time FLY-1393 W-1
 * `stale_approved_ship_dead` alert — strictly more than "只停 re-wake".
 *
 * QA verified this is NOT a silent strand: `approved_to_ship` is a
 * READOPT_PARKED_STATUS (HeartbeatService.ts:357-362), so
 * `readoptParkedPhase` still probes the same runner every heartbeat cycle and
 * still emits a verdict-honest monitoring-lost alert when it is not alive.
 * The net effect is the loss of ONE of TWO overlapping detectors, not the loss
 * of detection.
 *
 * These two cases pin the trade-off so it is a deliberate decision rather than
 * an invisible side effect: the baseline proves the W-1 alert fires without a
 * marker, and the second proves it does not fire with one. Anyone narrowing
 * the suppression to `reWake` alone (the plan's literal wording) should flip
 * the second expectation on purpose.
 */
import { describe, expect, it, vi } from "vitest";
import { reconcileStaleApprovedShip } from "../bridge/stale-approved-ship-reconciler.js";

const HEAD = "a".repeat(40);
const NOW = 10_000_000;
const staleActivity = new Date(NOW - 10 * 60_000)
	.toISOString()
	.replace("T", " ")
	.replace("Z", "");

function deadApprovedShipSession(over: Record<string, unknown> = {}) {
	return {
		execution_id: "E1",
		issue_id: "FLY-1505",
		project_name: "flywheel",
		status: "approved_to_ship",
		review_question_id: "Q-1",
		pr_head_sha: HEAD,
		last_activity_at: staleActivity,
		tmux_session: "cmux-E1",
		...over,
	};
}

async function runPass(sessions: ReturnType<typeof deadApprovedShipSession>[]) {
	const alertDead = vi.fn(async () => true);
	const reWake = vi.fn(async () => {});
	const probe = vi.fn(async () => "dead" as const);
	const result = await reconcileStaleApprovedShip({
		sessions,
		nowMs: NOW,
		graceMs: 5 * 60_000,
		backoffMs: 5 * 60_000,
		backoff: new Map(),
		deadAlerted: new Set(),
		probe,
		reWake,
		alertDead,
	});
	return { alertDead, reWake, probe, result };
}

describe("FLY-1505 QA: scope of the same-head re-wake suppression", () => {
	it("baseline — a dead approved-ship runner WITHOUT a marker is probed and dead-alerted", async () => {
		const { alertDead, probe, result } = await runPass([
			deadApprovedShipSession(),
		]);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(alertDead).toHaveBeenCalledTimes(1);
		expect(result.deadAlerted).toEqual(["E1"]);
	});

	it("with a same-head marker the pass skips the whole session — no re-wake (intended) AND no W-1 dead alert (wider than the plan's wording; readoptParkedPhase still covers it)", async () => {
		const { alertDead, reWake, probe, result } = await runPass([
			deadApprovedShipSession({ shipAttemptFailedHead: HEAD }),
		]);
		// Intended by C7: no automatic re-wake → no unattended repeat :cool:.
		expect(reWake).not.toHaveBeenCalled();
		// Wider than "只停 re-wake": this pass no longer probes or dead-alerts.
		expect(probe).not.toHaveBeenCalled();
		expect(alertDead).not.toHaveBeenCalled();
		expect(result).toEqual({ rewoken: [], deadAlerted: [] });
	});
});
