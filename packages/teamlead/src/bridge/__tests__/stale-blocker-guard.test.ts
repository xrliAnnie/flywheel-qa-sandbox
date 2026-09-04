/**
 * FLY-742: stale-blocker guard tests — pure two-phase classify + the two
 * side-effect seams (finalize / alert) + orchestration. Covers the riskiest
 * seams Codex R1 #7 called out: tmux tri-state, kill ordering, double re-read
 * race, durable alert dedup/retry, `approved_to_ship` anchor, and "no gh call
 * before local-stale classification".
 */

import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	alertStaleBlockerToLead,
	classifyBlockerLocal,
	classifyStaleWithPr,
	createStaleBlockerGuard,
	finalizeStaleBlocker,
	type PrState,
	staleAnchor,
} from "../stale-blocker-guard.js";
import type { TmuxTargetLookup } from "../tmux-lookup.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000; // fixed epoch ms

/** SQLite-UTC string ("YYYY-MM-DD HH:MM:SS") for `msAgo` before NOW. */
function sqliteAgo(msAgo: number): string {
	return new Date(NOW - msAgo).toISOString().replace("T", " ").slice(0, 19);
}

function session(overrides: Partial<Session>): Session {
	return {
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "sub",
		status: "awaiting_review",
		...overrides,
	} as Session;
}

const TTL = 120 * 60_000; // 120 min

describe("classifyBlockerLocal (Phase 1 — local only)", () => {
	it("running blocker → block_silent (never needs_pr_check)", () => {
		const r = classifyBlockerLocal({
			status: "running",
			lastActivityAt: sqliteAgo(10 * HOUR),
			nowMs: NOW,
			staleTtlMs: TTL,
		});
		expect(r.local).toBe("block_silent");
	});

	it("fresh awaiting_review (< TTL) → block_silent", () => {
		const r = classifyBlockerLocal({
			status: "awaiting_review",
			awaitingReviewEnteredAt: sqliteAgo(5 * 60_000), // 5 min
			nowMs: NOW,
			staleTtlMs: TTL,
		});
		expect(r.local).toBe("block_silent");
	});

	it("stale awaiting_review (>= TTL) → needs_pr_check", () => {
		const r = classifyBlockerLocal({
			status: "awaiting_review",
			awaitingReviewEnteredAt: sqliteAgo(10 * HOUR),
			nowMs: NOW,
			staleTtlMs: TTL,
		});
		expect(r.local).toBe("needs_pr_check");
	});

	it("approved_to_ship uses last_activity_at (NOT the old review timestamp)", () => {
		// Old review entry (10h) but a FRESH approve (2 min ago) → NOT stale.
		const r = classifyBlockerLocal({
			status: "approved_to_ship",
			awaitingReviewEnteredAt: sqliteAgo(10 * HOUR),
			lastActivityAt: sqliteAgo(2 * 60_000),
			nowMs: NOW,
			staleTtlMs: TTL,
		});
		expect(r.local).toBe("block_silent");
	});

	it("approved_to_ship stale by last_activity_at → needs_pr_check", () => {
		const r = classifyBlockerLocal({
			status: "approved_to_ship",
			lastActivityAt: sqliteAgo(10 * HOUR),
			nowMs: NOW,
			staleTtlMs: TTL,
		});
		expect(r.local).toBe("needs_pr_check");
	});

	it("missing / unparseable anchor → block_silent", () => {
		expect(
			classifyBlockerLocal({
				status: "awaiting_review",
				nowMs: NOW,
				staleTtlMs: TTL,
			}).local,
		).toBe("block_silent");
		expect(
			classifyBlockerLocal({
				status: "awaiting_review",
				awaitingReviewEnteredAt: "not-a-date",
				nowMs: NOW,
				staleTtlMs: TTL,
			}).local,
		).toBe("block_silent");
	});

	it("staleAnchor is status-specific", () => {
		expect(
			staleAnchor({
				status: "awaiting_review",
				awaitingReviewEnteredAt: "A",
				lastActivityAt: "B",
			}),
		).toBe("A");
		expect(
			staleAnchor({
				status: "awaiting_review",
				lastActivityAt: "B",
			}),
		).toBe("B");
		expect(
			staleAnchor({
				status: "approved_to_ship",
				awaitingReviewEnteredAt: "A",
				lastActivityAt: "B",
			}),
		).toBe("B");
	});
});

describe("classifyStaleWithPr (Phase 2)", () => {
	it("merged / closed → finalize_proceed", () => {
		expect(classifyStaleWithPr("merged").action).toBe("finalize_proceed");
		expect(classifyStaleWithPr("closed").action).toBe("finalize_proceed");
	});
	it("open / unknown → alert_block (fail-safe)", () => {
		expect(classifyStaleWithPr("open").action).toBe("alert_block");
		expect(classifyStaleWithPr("unknown").action).toBe("alert_block");
	});
});

// ── finalizeStaleBlocker (side-effect seam) ──────────────────────────────────

function foundLookup(): TmuxTargetLookup {
	return {
		kind: "found",
		target: { tmuxWindow: "sub:exec-1", session: "sub", windowId: "1" },
	} as unknown as TmuxTargetLookup;
}

function makeFinalizeDeps(over: {
	sessions: Session[]; // successive getSession returns
	lookup: TmuxTargetLookup;
	cmuxKilled?: boolean;
	windowKilled?: boolean;
	transitionOk?: boolean;
	finalizeOk?: boolean;
}) {
	const seq = [...over.sessions];
	const events: string[] = [];
	const commPrunes: string[] = [];
	const archived: string[] = [];
	const deps = {
		store: {
			getSession: vi.fn(() => seq.shift()),
			recordCommDbFinalizeOutcome: vi.fn(),
			insertEvent: vi.fn((e: { event_type: string }) => {
				events.push(e.event_type);
				return true;
			}),
		},
		lookupTmuxTarget: vi.fn(() => over.lookup),
		killCmuxLinkedSession: vi.fn(async () => ({
			killed: over.cmuxKilled ?? true,
		})),
		killTmuxWindow: vi.fn(async () => ({ killed: over.windowKilled ?? true })),
		closeTerminalView: vi.fn(async () => {}),
		finalizeCommDbSession: vi.fn((execId: string) => {
			if (over.finalizeOk === false) {
				return {
					ok: false as const,
					outcome: "failed" as const,
					retiredGateCount: 0,
					deletedSessionCount: 0,
					error: "sqlite busy",
				};
			}
			commPrunes.push(execId);
			return {
				ok: true as const,
				outcome: "finalized" as const,
				retiredGateCount: 1,
				deletedSessionCount: 1,
			};
		}),
		applyTransition: vi.fn(() => ({ ok: over.transitionOk ?? true })),
		archiveThread: vi.fn(async (s: Session) => {
			archived.push(s.execution_id);
		}),
		sqliteNow: () => "2026-07-01 00:00:00",
	};
	return { deps, events, commPrunes, archived };
}

describe("finalizeStaleBlocker (fail-closed teardown + double re-read)", () => {
	it("tmux lookup 'error' → proceed:false, no transition, audit written", async () => {
		const { deps, events } = makeFinalizeDeps({
			sessions: [session({ status: "awaiting_review" })],
			lookup: { kind: "error", error: "db locked" } as TmuxTargetLookup,
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(false);
		expect(deps.applyTransition).not.toHaveBeenCalled();
		expect(events).toContain("cron_stale_finalize_indeterminate");
	});

	it("'gone' → transition proceeds without a kill", async () => {
		const { deps } = makeFinalizeDeps({
			sessions: [
				session({ status: "awaiting_review" }),
				session({ status: "awaiting_review" }),
			],
			lookup: { kind: "gone" } as TmuxTargetLookup,
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(true);
		expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
		expect(deps.applyTransition).toHaveBeenCalledOnce();
		expect(deps.store.recordCommDbFinalizeOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ runnerDeathProven: false }),
		);
	});

	it("'found' + cmux kill fails → proceed:false, window NOT killed", async () => {
		const { deps } = makeFinalizeDeps({
			sessions: [session({ status: "awaiting_review" })],
			lookup: foundLookup(),
			cmuxKilled: false,
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(false);
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		expect(deps.applyTransition).not.toHaveBeenCalled();
	});

	it("'found' + window kill fails → proceed:false", async () => {
		const { deps } = makeFinalizeDeps({
			sessions: [session({ status: "awaiting_review" })],
			lookup: foundLookup(),
			windowKilled: false,
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(false);
		expect(deps.applyTransition).not.toHaveBeenCalled();
	});

	it("happy path: found → teardown → transition → prune + archive → proceed", async () => {
		const { deps, commPrunes, archived, events } = makeFinalizeDeps({
			sessions: [
				session({ status: "awaiting_review" }), // re-read #1
				session({ status: "awaiting_review" }), // re-read #2
				session({ status: "completed" }), // archive re-fetch
			],
			lookup: foundLookup(),
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(true);
		expect(deps.applyTransition).toHaveBeenCalledOnce();
		expect(commPrunes).toContain("exec-1");
		expect(archived).toContain("exec-1");
		expect(events).toContain("scheduled_run_blocker_finalized");
		expect(deps.store.recordCommDbFinalizeOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ runnerDeathProven: true }),
		);
	});

	it("FLY-1238: CommDB finalization failure blocks transition, archive, and slot release", async () => {
		const { deps, archived } = makeFinalizeDeps({
			sessions: [session({ status: "awaiting_review" })],
			lookup: { kind: "gone" } as TmuxTargetLookup,
			finalizeOk: false,
		});

		const r = await finalizeStaleBlocker(session({}), "merged", deps);

		expect(r.proceed).toBe(false);
		expect(deps.applyTransition).not.toHaveBeenCalled();
		expect(archived).toEqual([]);
	});

	it("re-read #1 already terminal → proceed:true, no teardown", async () => {
		const { deps } = makeFinalizeDeps({
			sessions: [session({ status: "completed" })],
			lookup: foundLookup(),
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(true);
		expect(deps.lookupTmuxTarget).not.toHaveBeenCalled();
		expect(deps.store.recordCommDbFinalizeOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ runnerDeathProven: false }),
		);
	});

	it("missing StateStore row settles orphaned communications without claiming death proof", async () => {
		const { deps } = makeFinalizeDeps({
			sessions: [],
			lookup: foundLookup(),
		});

		const r = await finalizeStaleBlocker(session({}), "merged", deps);

		expect(r.proceed).toBe(true);
		expect(deps.lookupTmuxTarget).not.toHaveBeenCalled();
		expect(deps.store.recordCommDbFinalizeOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ runnerDeathProven: false }),
		);
	});

	it("re-read #2 terminal after teardown → prune + skip audit + proceed", async () => {
		const { deps, commPrunes, events } = makeFinalizeDeps({
			sessions: [
				session({ status: "awaiting_review" }), // re-read #1
				session({ status: "completed" }), // re-read #2 — raced to completed
			],
			lookup: foundLookup(),
		});
		const r = await finalizeStaleBlocker(session({}), "merged", deps);
		expect(r.proceed).toBe(true);
		expect(deps.applyTransition).not.toHaveBeenCalled();
		expect(commPrunes).toContain("exec-1");
		expect(events).toContain(
			"scheduled_run_blocker_finalize_transition_skipped",
		);
	});
});

// ── alertStaleBlockerToLead (durable + deduped) ──────────────────────────────

function makeAlertDeps(over: {
	claimed?: boolean;
	delivered?: boolean;
	queued?: boolean;
	deliverThrows?: boolean;
	leadId?: string | undefined;
}) {
	const marks: number[] = [];
	const failures: Array<{ seq: number; error: string }> = [];
	const deps = {
		store: {
			tryClaimLeadEvent: vi.fn(() => over.claimed ?? true),
			appendLeadEvent: vi.fn(() => 42),
			markLeadEventDelivered: vi.fn((seq: number) => {
				marks.push(seq);
			}),
			recordDeliveryFailure: vi.fn((seq: number, error: string) => {
				failures.push({ seq, error });
			}),
		},
		resolveLeadId: vi.fn(() =>
			over.leadId === undefined && "leadId" in over ? undefined : "lead-a",
		),
		deliver: vi.fn(async () => {
			if (over.deliverThrows) throw new Error("transport down");
			return {
				delivered: over.delivered ?? !over.queued,
				...(over.queued ? { queued: true as const } : {}),
			};
		}),
		isoNow: () => "2026-07-01T00:00:00.000Z",
	};
	return { deps, marks, failures };
}

describe("alertStaleBlockerToLead (durable + deduped)", () => {
	it("first incident: claims → delivers → marks delivered", async () => {
		const { deps, marks } = makeAlertDeps({ claimed: true, delivered: true });
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(deps.store.tryClaimLeadEvent).toHaveBeenCalledOnce();
		expect(deps.deliver).toHaveBeenCalledOnce();
		expect(marks).toEqual([42]);
	});

	it("dedup: claim returns false → no deliver", async () => {
		const { deps } = makeAlertDeps({ claimed: false });
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(deps.deliver).not.toHaveBeenCalled();
		expect(deps.store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("delivery failure → recordDeliveryFailure (retryable by guardrail loop)", async () => {
		const { deps, failures } = makeAlertDeps({
			claimed: true,
			delivered: false,
		});
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.seq).toBe(42);
	});

	it("durably queued delivery is accepted without recording a false failure", async () => {
		const { deps, failures } = makeAlertDeps({ claimed: true, queued: true });
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(failures).toEqual([]);
		expect(deps.deliver).toHaveBeenCalledWith(
			"lead-a",
			expect.objectContaining({
				eventId: expect.stringContaining("scheduled-run-blocked:exec-1:"),
			}),
		);
	});

	it("deliver throws → recordDeliveryFailure", async () => {
		const { deps, failures } = makeAlertDeps({
			claimed: true,
			deliverThrows: true,
		});
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(failures).toHaveLength(1);
	});

	it("no Lead resolved → no claim, no deliver", async () => {
		const { deps } = makeAlertDeps({ leadId: undefined });
		deps.resolveLeadId = vi.fn(() => undefined);
		await alertStaleBlockerToLead(session({ pr_number: 83 }), "open", 24, deps);
		expect(deps.store.tryClaimLeadEvent).not.toHaveBeenCalled();
		expect(deps.deliver).not.toHaveBeenCalled();
	});
});

// ── createStaleBlockerGuard (orchestration) ──────────────────────────────────

function makeGuardDeps(over: {
	enabled?: boolean;
	prState?: PrState;
	finalizeProceed?: boolean;
	reconcileGhost?: (blocker: Session) => Promise<boolean>;
}) {
	const checkPrState = vi.fn(async () => over.prState ?? "unknown");
	const finalizeBlocker = vi.fn(async () => ({
		proceed: over.finalizeProceed ?? true,
	}));
	const alertLead = vi.fn(async () => {});
	const deps = {
		enabled: over.enabled ?? true,
		staleTtlMs: TTL,
		now: () => NOW,
		checkPrState,
		finalizeBlocker,
		alertLead,
		projectRootFor: () => "/repo/sub",
		reconcileGhost: over.reconcileGhost,
	};
	return { deps, checkPrState, finalizeBlocker, alertLead };
}

describe("createStaleBlockerGuard (orchestration)", () => {
	it("residue target hook runs before the FLY-742 kill-switch and releases a reaped ghost", async () => {
		const reconcileGhost = vi.fn(async () => true);
		const { deps, checkPrState } = makeGuardDeps({
			enabled: false,
			reconcileGhost,
		});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				status: "awaiting_review",
				started_at: sqliteAgo(31 * 60_000),
				awaiting_review_entered_at: sqliteAgo(31 * 60_000),
			}),
		);

		expect(r.proceed).toBe(true);
		expect(reconcileGhost).toHaveBeenCalledOnce();
		expect(checkPrState).not.toHaveBeenCalled();
	});

	it("running StateStore ghost can be released before local blocker classification", async () => {
		const reconcileGhost = vi.fn(async () => true);
		const { deps, checkPrState } = makeGuardDeps({ reconcileGhost });
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({ status: "running", started_at: sqliteAgo(10 * HOUR) }),
		);

		expect(r.proceed).toBe(true);
		expect(checkPrState).not.toHaveBeenCalled();
	});

	it("fresh/non-ghost target falls through to the exact old 409 path", async () => {
		const reconcileGhost = vi.fn(async () => false);
		const { deps, checkPrState, finalizeBlocker, alertLead } = makeGuardDeps({
			reconcileGhost,
		});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				status: "awaiting_review",
				started_at: sqliteAgo(5 * 60_000),
				awaiting_review_entered_at: sqliteAgo(5 * 60_000),
			}),
		);

		expect(r.proceed).toBe(false);
		expect(reconcileGhost).toHaveBeenCalledOnce();
		expect(checkPrState).not.toHaveBeenCalled();
		expect(finalizeBlocker).not.toHaveBeenCalled();
		expect(alertLead).not.toHaveBeenCalled();
	});

	it("non-ghost stale blocker preserves FLY-742 ordering after the new hook", async () => {
		const reconcileGhost = vi.fn(async () => false);
		const { deps, checkPrState, finalizeBlocker } = makeGuardDeps({
			reconcileGhost,
			prState: "merged",
		});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				pr_number: 83,
				awaiting_review_entered_at: sqliteAgo(10 * HOUR),
			}),
		);

		expect(r.proceed).toBe(true);
		expect(reconcileGhost.mock.invocationCallOrder[0]).toBeLessThan(
			checkPrState.mock.invocationCallOrder[0]!,
		);
		expect(finalizeBlocker).toHaveBeenCalledOnce();
	});

	it("disabled → proceed:false, no gh call", async () => {
		const { deps, checkPrState } = makeGuardDeps({ enabled: false });
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({ status: "awaiting_review" }),
		);
		expect(r.proceed).toBe(false);
		expect(checkPrState).not.toHaveBeenCalled();
	});

	it("running blocker → proceed:false, NO gh call", async () => {
		const { deps, checkPrState } = makeGuardDeps({});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({ status: "running", last_activity_at: sqliteAgo(10 * HOUR) }),
		);
		expect(r.proceed).toBe(false);
		expect(checkPrState).not.toHaveBeenCalled();
	});

	it("fresh parked blocker → proceed:false, NO gh call", async () => {
		const { deps, checkPrState } = makeGuardDeps({});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				status: "awaiting_review",
				awaiting_review_entered_at: sqliteAgo(60_000),
			}),
		);
		expect(r.proceed).toBe(false);
		expect(checkPrState).not.toHaveBeenCalled();
	});

	it("stale + merged → finalize called, returns its proceed", async () => {
		const { deps, finalizeBlocker, alertLead } = makeGuardDeps({
			prState: "merged",
			finalizeProceed: true,
		});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				pr_number: 83,
				awaiting_review_entered_at: sqliteAgo(10 * HOUR),
			}),
		);
		expect(r.proceed).toBe(true);
		expect(finalizeBlocker).toHaveBeenCalledOnce();
		expect(alertLead).not.toHaveBeenCalled();
	});

	it("stale + open → alert called, proceed:false", async () => {
		const { deps, finalizeBlocker, alertLead } = makeGuardDeps({
			prState: "open",
		});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({
				pr_number: 83,
				awaiting_review_entered_at: sqliteAgo(10 * HOUR),
			}),
		);
		expect(r.proceed).toBe(false);
		expect(alertLead).toHaveBeenCalledOnce();
		expect(finalizeBlocker).not.toHaveBeenCalled();
	});

	it("no pr_number → prState unknown → alert, no gh call", async () => {
		const { deps, checkPrState, alertLead } = makeGuardDeps({});
		const g = createStaleBlockerGuard(deps);
		const r = await g.handleActiveBlocker(
			session({ awaiting_review_entered_at: sqliteAgo(10 * HOUR) }),
		);
		expect(r.proceed).toBe(false);
		expect(checkPrState).not.toHaveBeenCalled();
		expect(alertLead).toHaveBeenCalledOnce();
	});

	it("inFlightFinalize: transient failure releases lock → retry can proceed", async () => {
		const { deps } = makeGuardDeps({ prState: "merged" });
		let call = 0;
		deps.finalizeBlocker = vi.fn(async () => {
			call += 1;
			return { proceed: call >= 2 }; // 1st attempt fails, 2nd proceeds
		});
		const g = createStaleBlockerGuard(deps);
		const blocker = session({
			pr_number: 83,
			awaiting_review_entered_at: sqliteAgo(10 * HOUR),
		});
		const r1 = await g.handleActiveBlocker(blocker);
		expect(r1.proceed).toBe(false);
		const r2 = await g.handleActiveBlocker(blocker); // lock was released in finally
		expect(r2.proceed).toBe(true);
		expect(deps.finalizeBlocker).toHaveBeenCalledTimes(2);
	});
});
