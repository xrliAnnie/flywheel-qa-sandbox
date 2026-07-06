/**
 * FLY-871 R3/C9 — rescue orchestration: structural guards (pending + confirmed
 * only), lead kickstart + resume-menu unstick with one retry then escalate,
 * runner close+successor, and the post-switch sweep.
 */

import { describe, expect, it, vi } from "vitest";
import {
	findPendingLeadAlert,
	findPendingRunnerAlert,
	type PendingAlert,
	postSwitchRescueSweep,
	rescueLead,
	rescueRunner,
} from "../bridge/rescue.js";

const RESUME_MENU = "Resume from summary?  Enter to confirm";
const HEALTHY = "⏵⏵ bypass permissions · ctx 40%";
const isResumeMenu = (p: string) => /resume from summary/i.test(p);

function leadAlert(over: Partial<PendingAlert> = {}): PendingAlert {
	return {
		correlationKey: "c-lead",
		eventType: "login_expired",
		sessionKey: null,
		leadId: "mufasa-lead",
		projectName: "growth",
		evidence: "lead-pane:login_expired",
		...over,
	};
}
function runnerAlert(over: Partial<PendingAlert> = {}): PendingAlert {
	return {
		correlationKey: "c-runner",
		eventType: "runner_login_expired",
		sessionKey: "exec-1",
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		evidence: "runner-pane:login_expired",
		...over,
	};
}

describe("rescue guards", () => {
	it("finds a pending confirmed lead alert; ignores resolved/suspicious/other", () => {
		const rows = [leadAlert()];
		expect(findPendingLeadAlert(rows, "mufasa-lead", "growth")).toBeDefined();
		expect(findPendingLeadAlert(rows, "other", "growth")).toBeUndefined();
		// suspicious (low-confidence) is NEVER rescuable
		expect(
			findPendingLeadAlert(
				[leadAlert({ evidence: "lead-pane:suspicious" })],
				"mufasa-lead",
				"growth",
			),
		).toBeUndefined();
	});

	it("finds a pending confirmed runner alert by execution id; ignores suspicious", () => {
		expect(findPendingRunnerAlert([runnerAlert()], "exec-1")).toBeDefined();
		expect(findPendingRunnerAlert([runnerAlert()], "exec-9")).toBeUndefined();
		expect(
			findPendingRunnerAlert(
				[runnerAlert({ evidence: "runner-pane:suspicious" })],
				"exec-1",
			),
		).toBeUndefined();
	});
});

function leadDeps(over: Record<string, unknown> = {}) {
	return {
		pendingAlerts: () => [leadAlert()],
		kickstart: vi.fn(async () => true),
		capturePane: vi.fn(async () => HEALTHY),
		sendEnter: vi.fn(async () => {}),
		isResumeMenu,
		postEvidence: vi.fn(async () => {}),
		resolveAlert: vi.fn(async () => {}),
		audit: vi.fn(),
		waitMs: async () => {},
		...over,
	};
}

describe("rescueLead", () => {
	it("refuses when there is no pending login_expired alert (never kickstarts)", async () => {
		const d = leadDeps({ pendingAlerts: () => [] });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("no_pending_login_expired_alert");
		expect(d.kickstart).not.toHaveBeenCalled();
		expect(d.audit).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "refused" }),
		);
	});

	it("kickstarts + posts evidence into the incident thread, resolves it on success", async () => {
		const d = leadDeps();
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(true);
		expect(d.kickstart).toHaveBeenCalledOnce();
		expect(d.sendEnter).not.toHaveBeenCalled(); // no resume menu → no key sent
		expect(d.postEvidence).toHaveBeenCalledTimes(2);
		// FLY-871 R2/W-review HIGH: evidence routes to THAT incident's thread.
		expect(d.postEvidence).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ threadKey: "c-lead" }),
		);
		// A healed session ⇒ resolve the alert so the sweep stops re-hitting it.
		expect(d.resolveAlert).toHaveBeenCalledWith("c-lead");
	});

	it("escalation @-pings the founder for real (mention:true) + does NOT resolve", async () => {
		const d = leadDeps({ kickstart: vi.fn(async () => false) });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.escalated).toBe(true);
		expect(d.postEvidence).toHaveBeenLastCalledWith(
			expect.stringContaining("@Annie"),
			expect.objectContaining({ threadKey: "c-lead", mention: true }),
		);
		expect(d.resolveAlert).not.toHaveBeenCalled();
	});

	it("sends Enter to unstick a resume menu, then verifies healthy", async () => {
		const capturePane = vi
			.fn()
			.mockResolvedValueOnce(RESUME_MENU) // the post-kickstart pane
			.mockResolvedValueOnce(HEALTHY); // the verify re-capture
		const d = leadDeps({ capturePane });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(true);
		expect(d.sendEnter).toHaveBeenCalledOnce();
	});

	it("escalates after one retry when kickstart keeps failing", async () => {
		const d = leadDeps({ kickstart: vi.fn(async () => false) });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(false);
		expect(r.escalated).toBe(true);
		expect(r.reason).toBe("kickstart_failed");
		expect(d.kickstart).toHaveBeenCalledTimes(2); // one retry
	});

	it("escalates when still stuck at the resume menu after the retry", async () => {
		const d = leadDeps({ capturePane: vi.fn(async () => RESUME_MENU) });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(false);
		expect(r.escalated).toBe(true);
		expect(r.reason).toBe("stuck_resume_menu");
	});

	// Codex R2 HIGH: a null verify-capture ("no window / cannot tell") is NOT a
	// success — the Lead may still be logged out. It must escalate, NOT post ✅,
	// and NOT resolve the alert (else a still-dead Lead drops off the sweep).
	it("escalates (no ✅, no resolve) when the verify capture cannot be read", async () => {
		const d = leadDeps({ capturePane: vi.fn(async () => null) });
		const r = await rescueLead(
			{ projectName: "growth", leadId: "mufasa-lead" },
			d,
		);
		expect(r.ok).toBe(false);
		expect(r.escalated).toBe(true);
		expect(r.reason).toBe("verify_capture_failed");
		expect(d.resolveAlert).not.toHaveBeenCalled();
		for (const call of d.postEvidence.mock.calls) {
			expect(call[0]).not.toContain("✅");
		}
	});
});

function runnerDeps(over: Record<string, unknown> = {}) {
	return {
		pendingAlerts: () => [runnerAlert()],
		closeAndDispatchSuccessor: vi.fn(async () => "exec-2"),
		postEvidence: vi.fn(async () => {}),
		resolveAlert: vi.fn(async () => {}),
		audit: vi.fn(),
		...over,
	};
}

describe("rescueRunner", () => {
	it("refuses without a pending runner_login_expired alert", async () => {
		const d = runnerDeps({ pendingAlerts: () => [] });
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(false);
		expect(d.closeAndDispatchSuccessor).not.toHaveBeenCalled();
	});

	it("closes + dispatches a resumed successor, evidence to thread, resolves on success", async () => {
		const d = runnerDeps();
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(true);
		expect(d.postEvidence).toHaveBeenCalledTimes(2);
		expect(d.postEvidence).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ threadKey: "c-runner" }),
		);
		// The old kicked-out execId's alert is resolved so the sweep doesn't re-hit
		// a now-terminated session.
		expect(d.resolveAlert).toHaveBeenCalledWith("c-runner");
	});

	it("a recovered runner resolves its stale alert (report-only, no close)", async () => {
		const d = runnerDeps({
			revalidate: vi.fn(async () => ({
				confirmed: false,
				category: "healthy",
			})),
		});
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.reason).toBe("revalidation_not_confirmed");
		expect(d.closeAndDispatchSuccessor).not.toHaveBeenCalled();
		expect(d.resolveAlert).toHaveBeenCalledWith("c-runner");
	});

	it("close/dispatch escalation @-pings the founder + does NOT resolve", async () => {
		const d = runnerDeps({
			closeAndDispatchSuccessor: vi.fn(async () => null),
		});
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.escalated).toBe(true);
		expect(d.postEvidence).toHaveBeenLastCalledWith(
			expect.stringContaining("@Annie"),
			expect.objectContaining({ threadKey: "c-runner", mention: true }),
		);
		expect(d.resolveAlert).not.toHaveBeenCalled();
	});

	it("escalates after one retry when close/dispatch keeps failing", async () => {
		const d = runnerDeps({
			closeAndDispatchSuccessor: vi.fn(async () => null),
		});
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(false);
		expect(r.escalated).toBe(true);
		expect(d.closeAndDispatchSuccessor).toHaveBeenCalledTimes(2);
	});

	// FLY-871 Lead ②: LIVE revalidation immediately before the destructive
	// close+dispatch — the alert row may be stale (the runner self-recovered or a
	// human fixed it between the alert and the rescue). A still-logged-out runner
	// is rescued; a recovered one is NEVER closed (report-only).
	it("revalidates before acting: a still-confirmed runner is rescued", async () => {
		const revalidate = vi.fn(async () => ({
			confirmed: true,
			category: "login_expired",
		}));
		const d = runnerDeps({ revalidate });
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(true);
		expect(revalidate).toHaveBeenCalledOnce();
		expect(d.closeAndDispatchSuccessor).toHaveBeenCalledOnce();
	});

	it("refuses (report-only, NOT escalated) when revalidation shows the runner recovered", async () => {
		const revalidate = vi.fn(async () => ({
			confirmed: false,
			category: "healthy",
		}));
		const d = runnerDeps({ revalidate });
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("revalidation_not_confirmed");
		expect(r.escalated).toBeFalsy(); // recovery is good news, not an escalation
		// The destructive op MUST NOT run on a recovered runner.
		expect(d.closeAndDispatchSuccessor).not.toHaveBeenCalled();
		// A report is posted so the no-op is visible.
		expect(d.postEvidence).toHaveBeenCalledOnce();
	});

	it("escalates (does NOT close) when revalidation cannot be performed", async () => {
		const revalidate = vi.fn(async () => {
			throw new Error("pane capture failed");
		});
		const d = runnerDeps({ revalidate });
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("revalidation_error");
		expect(r.escalated).toBe(true); // never close on uncertainty; page instead
		expect(d.closeAndDispatchSuccessor).not.toHaveBeenCalled();
	});

	it("byte-compat: no revalidate seam ⇒ proceeds on the alert row alone", async () => {
		const d = runnerDeps(); // no revalidate
		const r = await rescueRunner({ executionId: "exec-1" }, d);
		expect(r.ok).toBe(true);
		expect(d.closeAndDispatchSuccessor).toHaveBeenCalledOnce();
	});
});

describe("postSwitchRescueSweep", () => {
	it("rescues every pending lead + runner, skips suspicious, survives an exception", async () => {
		const rescueLeadFn = vi.fn(async () => ({
			ok: true,
			target: "lead:mufasa-lead",
		}));
		const rescueRunnerFn = vi.fn(async () => {
			throw new Error("boom");
		});
		const outcomes = await postSwitchRescueSweep({
			pendingAlerts: () => [
				leadAlert(),
				runnerAlert(),
				runnerAlert({
					correlationKey: "c-susp",
					sessionKey: "exec-9",
					evidence: "runner-pane:suspicious",
				}),
			],
			rescueLead: rescueLeadFn,
			rescueRunner: rescueRunnerFn,
		});
		// lead rescued + runner attempted (threw → captured); suspicious skipped
		expect(rescueLeadFn).toHaveBeenCalledOnce();
		expect(rescueRunnerFn).toHaveBeenCalledOnce();
		expect(outcomes).toHaveLength(2);
		expect(outcomes.some((o) => o.reason === "sweep_exception")).toBe(true);
	});
});
