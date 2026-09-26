/**
 * FLY-1185 §2.12 — unified lifecycle-closeout executor tests.
 * Plan §4 pins: #31 disposition full-status matrix (canceled NEVER fabricates
 * completed; pending/design_done edges FSM-legal; zero forceStatus), #32 DAG
 * (transition failure ⇒ zero teardown signals; terminal-status-but-live veto
 * blocks issue items; Linear item last), #36 park intent arbitration, #38/#39
 * admission barrier + park-vs-start via durable launch claims.
 */

import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { StateStore } from "../../StateStore.js";
import { assertIssueNotLifecycleClosed } from "../lifecycle-admission.js";
import {
	CANCELED_STATUS_ACTIONS,
	closeoutIssue,
	collectIssueCloseoutNodes,
	createIssueMutex,
	type LifecycleCloseoutDeps,
} from "../lifecycle-closeout.js";

const UUID = "11111111-1111-4111-8111-111111111111";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function transitionOpts(store: StateStore): ApplyTransitionOpts {
	return { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) };
}

function baseDeps(
	store: StateStore,
	over: Partial<LifecycleCloseoutDeps> = {},
): LifecycleCloseoutDeps {
	return {
		store,
		transitionOpts: transitionOpts(store),
		withIssueMutex: createIssueMutex(),
		closeRunnerFn: vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		})) as never,
		finalizeCommDbSessionFn: vi.fn(() => ({
			ok: true,
			outcome: "finalized",
			retiredGateCount: 1,
			deletedSessionCount: 1,
		})),
		lookupTarget: (() => ({ kind: "gone" }) as const) as never,
		probeLiveness: async () => "absent" as const,
		log: () => {},
		...over,
	};
}

function seedSession(
	store: StateStore,
	execId: string,
	status: string,
	issueId = UUID,
): void {
	store.upsertSession({
		execution_id: execId,
		issue_id: issueId,
		project_name: "proj",
		status,
		issue_identifier: "FLY-1185",
	});
}

describe("CANCELED_STATUS_ACTIONS (plan §4 #31 full matrix)", () => {
	it("covers EVERY persisted status; canceled never routes through completed", () => {
		const allStatuses = [
			"pending",
			"running",
			"design_done",
			"awaiting_review",
			"approved_to_ship",
			"blocked",
			"failed",
			"completed",
			"terminated",
			"rejected",
			"deferred",
			"shelved",
			"approved",
		];
		for (const s of allStatuses) {
			expect(
				CANCELED_STATUS_ACTIONS[s],
				`status ${s} must be in the table`,
			).toBeDefined();
		}
		// exhaustiveness in the other direction too
		expect(Object.keys(CANCELED_STATUS_ACTIONS).sort()).toEqual(
			allStatuses.sort(),
		);
	});

	it("pending→terminated and design_done→terminated are FSM-legal (new edges)", () => {
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		expect(fsm.canTransition("pending", "terminated")).toBe(true);
		expect(fsm.canTransition("design_done", "terminated")).toBe(true);
	});
});

describe("closeoutIssue — canceled disposition", () => {
	it("running session transitions to terminated via the FSM (never completed), teardown follows", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "running");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(store.getSession("e1")?.status).toBe("terminated");
		expect(closeRunnerFn).toHaveBeenCalled();
		expect(report.outcome).toBe("complete");
		const nodeReport = report.nodes.find((n) => n.node.executionId === "e1");
		expect(nodeReport?.transition.state).toBe("done");
	});

	it("FLY-1238: physical closure without communication finalization blocks issue-level cleanup", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "running");
		const archiveThreads = vi.fn();
		const linearConsistency = vi.fn();
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_failed:sqlite busy",
		}));

		const report = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: closeRunnerFn as never,
				archiveThreads,
				linearConsistency,
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);

		expect(report.outcome).toBe("blocked");
		expect(report.nodes[0]).toMatchObject({
			confirmedGone: true,
			communicationsFinalized: false,
			teardown: {
				state: "failed",
				error: "commdb_finalize_failed:sqlite busy",
			},
		});
		expect(archiveThreads).not.toHaveBeenCalled();
		expect(linearConsistency).not.toHaveBeenCalled();

		const second = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: vi.fn(async () => ({
					closed: true,
					commDbFinalized: true,
					retiredGateCount: 1,
				})) as never,
				archiveThreads,
				linearConsistency,
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(second.outcome).toBe("complete");
		expect(archiveThreads).toHaveBeenCalledTimes(1);
		expect(linearConsistency).toHaveBeenCalledTimes(1);
	});

	it("FSM transition failure ⇒ MCP/window get ZERO signals, node blocked (plan §4 #32)", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "running");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		// an FSM with no edges rejects everything → simulates the concurrent-
		// status-change race the DAG rule pins
		const brokenFsm = new WorkflowFSM({});
		const report = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: closeRunnerFn as never,
				transitionOpts: { store, fsm: brokenFsm },
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(closeRunnerFn).not.toHaveBeenCalled();
		const nodeReport = report.nodes.find((n) => n.node.executionId === "e1");
		expect(nodeReport?.transition.state).toBe("blocked");
		expect(report.outcome).toBe("blocked");
	});

	it("blocked/failed sessions preserve forensics status but tear down the live target with an explicit audit", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "failed");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		// status NOT touched (forensics preserved)
		expect(store.getSession("e1")?.status).toBe("failed");
		// teardown used forcePreserved (issue-terminal authority override)
		expect(closeRunnerFn).toHaveBeenCalledWith(
			expect.objectContaining({ forcePreserved: true }),
			expect.anything(),
		);
	});
});

describe("closeoutIssue — shipped disposition", () => {
	it("non-PASS QA child is closed with CANCELED semantics (terminate, never fabricated completed)", async () => {
		const store = await freshStore();
		seedSession(store, "root-e", "completed");
		seedSession(store, "qa-e", "running", "qa-child-uuid");
		store.claimAutoQaRecord({
			parentExecutionId: "root-e",
			targetPrHeadSha: "sha",
			issueId: UUID,
			projectName: "proj",
		});
		store.setAutoQaQaExecutionId("root-e", "sha", "qa-e");
		const report = await closeoutIssue(baseDeps(store), {
			issueKey: UUID,
			projectName: "proj",
			disposition: "shipped",
			authority: "ship_complete",
		});
		expect(store.getSession("qa-e")?.status).toBe("terminated");
		expect(report.outcome).toBe("complete");
	});

	it("parked design_done phase finalizes via finalizeDone (existing semantics)", async () => {
		const store = await freshStore();
		seedSession(store, "design-e", "design_done");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "shipped",
				authority: "ship_complete",
			},
		);
		expect(closeRunnerFn).toHaveBeenCalledWith(
			expect.objectContaining({ finalizeDone: true }),
			expect.anything(),
		);
	});
});

describe("disposition arbitration (plan §4 #36/#39)", () => {
	it("active founder park intent vs a shipped closeout → disposition_conflict, ZERO mutation", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "running");
		store.upsertIssueDispositionIntent({
			issueUuid: UUID,
			project: "proj",
			founderDecisionId: "fd-1",
		});
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "shipped",
				authority: "ship_complete",
			},
		);
		expect(report.outcome).toBe("conflict");
		expect(closeRunnerFn).not.toHaveBeenCalled();
		expect(store.getSession("e1")?.status).toBe("running");
	});
});

describe("issue-level items (plan §4 #32)", () => {
	it("terminal statuses but a STILL-LIVE window → issue items blocked (triple-veto family)", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "terminated");
		const archiveThreads = vi.fn(async () => {});
		const report = await closeoutIssue(
			baseDeps(store, {
				archiveThreads,
				lookupTarget: (() => ({
					kind: "found",
					target: { tmuxWindow: "w:1" },
				})) as never,
				probeLiveness: async () => "alive" as const,
				closeRunnerFn: vi.fn(async () => ({
					closed: false,
					error: "kill_failed",
				})) as never,
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(archiveThreads).not.toHaveBeenCalled();
		expect(report.outcome).toBe("blocked");
	});

	it("blocked_open_pr style operator items → needs_operator; Linear runs after archive", async () => {
		const store = await freshStore();
		seedSession(store, "e1", "completed");
		const order: string[] = [];
		const report = await closeoutIssue(
			baseDeps(store, {
				archiveThreads: async () => {
					order.push("archive");
				},
				linearConsistency: async () => {
					order.push("linear");
					return { blockedItems: ["blocked_open_pr:42"] };
				},
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(order).toEqual(["archive", "linear"]);
		expect(report.outcome).toBe("needs_operator");
		expect(report.operatorItems).toContain("blocked_open_pr:42");
	});
});

describe("admission barrier + launch claims (plan §4 #38)", () => {
	it("park active → spawn denied; unpark → admitted again; Bridge restart persistence is the same durable table", async () => {
		const store = await freshStore();
		seedSession(store, "seed-e", "completed"); // gives the alias→UUID mapping
		store.upsertIssueDispositionIntent({
			issueUuid: UUID,
			project: "proj",
			founderDecisionId: "fd-1",
		});
		const mutex = createIssueMutex();
		const denied = await assertIssueNotLifecycleClosed(
			{ store, withIssueMutex: mutex },
			{
				issueKey: "FLY-1185",
				projectName: "proj",
				executionId: "new-e",
			},
		);
		expect(denied.admitted).toBe(false);
		if (!denied.admitted) expect(denied.reason).toBe("founder_parked");

		store.supersedeIssueDispositionIntent(UUID, "fd-unpark");
		const admitted = await assertIssueNotLifecycleClosed(
			{ store, withIssueMutex: mutex },
			{
				issueKey: "FLY-1185",
				projectName: "proj",
				executionId: "new-e2",
			},
		);
		expect(admitted.admitted).toBe(true);
	});

	it("start-first: the durable starting claim is VISIBLE to a following park's node collection (R11#1)", async () => {
		const store = await freshStore();
		seedSession(store, "seed-e", "completed");
		const mutex = createIssueMutex();
		const res = await assertIssueNotLifecycleClosed(
			{ store, withIssueMutex: mutex },
			{
				issueKey: UUID,
				projectName: "proj",
				executionId: "spawning-e",
				role: "main",
			},
		);
		expect(res.admitted).toBe(true);
		const nodes = collectIssueCloseoutNodes(store, {
			rootKey: UUID,
			aliasKeys: [UUID, "FLY-1185"],
			projectName: "proj",
		});
		expect(nodes.map((n) => n.executionId)).toContain("spawning-e");
	});

	it("fresh issue with zero history (no UUID mapping) is ADMITTED — availability must not regress", async () => {
		const store = await freshStore();
		const res = await assertIssueNotLifecycleClosed(
			{ store, withIssueMutex: createIssueMutex() },
			{
				issueKey: "FLY-9999",
				projectName: "proj",
				executionId: "first-e",
			},
		);
		expect(res.admitted).toBe(true);
	});
});

describe("createIssueMutex", () => {
	it("multi-key acquisition is sorted + serialized (no single-child locks)", async () => {
		const mutex = createIssueMutex();
		const events: string[] = [];
		const a = mutex(["k2", "k1"], async () => {
			events.push("a-start");
			await new Promise((r) => setTimeout(r, 30));
			events.push("a-end");
		});
		const b = mutex(["k1"], async () => {
			events.push("b");
		});
		await Promise.all([a, b]);
		expect(events).toEqual(["a-start", "a-end", "b"]);
	});
});

// ── FLY-1185 Codex R1 fixes — regression pins ───────────────────────────────

describe("Codex R1 fixes", () => {
	it("R1#4: master switch OFF ⇒ ZERO mutation — no transition, no teardown, blocked report", async () => {
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: closeRunnerFn as never,
				mutationEnabled: () => false,
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(report.outcome).toBe("blocked");
		expect(report.operatorItems).toContain("autoclean_disabled");
		expect(report.nodes).toHaveLength(0);
		expect(closeRunnerFn).not.toHaveBeenCalled();
		expect(store.getSession("e-run")?.status).toBe("running");
	});

	it("R1#8: shipped closeout vs persisted CANCELED observation ⇒ conflict, zero mutation", async () => {
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "started",
			linearUpdatedAt: "2026-07-01T00:00:00.000Z",
		});
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-02T00:00:00.000Z",
		});
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "shipped",
				authority: "ship_complete",
			},
		);
		expect(report.outcome).toBe("conflict");
		expect(report.operatorItems).toContain("shipped_vs_canceled_conflict");
		expect(closeRunnerFn).not.toHaveBeenCalled();
		expect(store.getSession("e-run")?.status).toBe("running");
	});

	it("R1#13: a live legacy `approved` husk is torn down under the issue-terminal override (not blocked forever)", async () => {
		const store = await freshStore();
		seedSession(store, "e-approved", "approved");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, { closeRunnerFn: closeRunnerFn as never }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(closeRunnerFn).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "e-approved",
				issueTerminalOverride: true,
			}),
			expect.anything(),
		);
		expect(report.outcome).toBe("complete");
	});

	it("R1#14: budget exhaustion blocks remaining nodes BEFORE any mutation", async () => {
		const store = await freshStore();
		seedSession(store, "e-1", "running");
		seedSession(store, "e-2", "running");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		// R3#13: the budget is CALL-level (plan.md:156 "mutator 调用 ≤40/run") —
		// a full node teardown costs 2 slots (fsm_transition + teardown), so 2
		// slots let node 1 complete fully and node 2 must block pre-mutation.
		let slots = 2;
		const report = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: closeRunnerFn as never,
				budget: {
					tryConsume: () => {
						if (slots <= 0) return false;
						slots--;
						return true;
					},
				},
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(report.outcome).toBe("blocked");
		expect(closeRunnerFn).toHaveBeenCalledTimes(1);
		const blocked = report.nodes.filter(
			(n) =>
				n.transition.state === "blocked" &&
				n.transition.prerequisite?.startsWith("budget_exhausted"),
		);
		expect(blocked).toHaveLength(1);
		// The budget-blocked node's session was NOT touched.
		const untouched = blocked[0]?.node.executionId;
		expect(store.getSession(untouched ?? "")?.status).toBe("running");
	});

	it("R1#5: a no-row launch claim is CANCELLED (CAS) — and an in-flight `active` claim blocks instead of vanishing", async () => {
		const store = await freshStore();
		// starting claim, no session row → closeout cancels it.
		store.insertLaunchClaim({
			executionId: "claim-a",
			rootUuid: UUID,
			project: "proj",
		});
		const report = await closeoutIssue(baseDeps(store), {
			issueKey: UUID,
			projectName: "proj",
			disposition: "founder_parked",
			authority: "founder_park",
		});
		expect(store.getLaunchClaim("claim-a")?.state).toBe("cancelled");
		// R5#1: cancelling a `starting` claim no longer declares the issue done —
		// a spawn already past the dispatcher's pre-launch verify could still be
		// born (emitStarted fires before the binding). The node stays
		// confirmedGone=false so the intent remains PARTIAL and the next replay
		// tick owns any born runner via its binding-owned residue.
		expect(report.outcome).toBe("blocked");
		const claimANode = report.nodes.find(
			(n) => n.node.executionId === "claim-a",
		);
		expect(claimANode?.confirmedGone).toBe(false);
		expect(claimANode?.teardown).toMatchObject({ state: "done" });

		// active claim (dispatcher won the CAS), still no row → blocked node.
		store.insertLaunchClaim({
			executionId: "claim-b",
			rootUuid: UUID,
			project: "proj",
		});
		store.casLaunchClaimState("claim-b", "starting", "active");
		const report2 = await closeoutIssue(baseDeps(store), {
			issueKey: UUID,
			projectName: "proj",
			disposition: "founder_parked",
			authority: "founder_park",
		});
		const claimNode = report2.nodes.find(
			(n) => n.node.executionId === "claim-b",
		);
		expect(claimNode?.confirmedGone).toBe(false);
		expect(store.getLaunchClaim("claim-b")?.state).toBe("active");
	});

	it("R6#1: a session row written by emitStarted but still mid-launch (open claim, no binding) is NOT declared gone", async () => {
		const store = await freshStore();
		// emitStarted wrote a running session row synchronously...
		seedSession(store, "e-inflight", "running");
		// ...but the launch claim is still starting and there is NO durable
		// worktree binding yet (worktree/window not created).
		store.insertLaunchClaim({
			executionId: "e-inflight",
			rootUuid: UUID,
			project: "proj",
		});
		const report = await closeoutIssue(baseDeps(store), {
			issueKey: UUID,
			projectName: "proj",
			disposition: "founder_parked",
			authority: "founder_park",
		});
		// The node must NOT be confirmedGone — a park cannot complete before the
		// runner is born; the intent stays PARTIAL for the replay to own it.
		const node = report.nodes.find((n) => n.node.executionId === "e-inflight");
		expect(node?.confirmedGone).toBe(false);
		expect(report.outcome).toBe("blocked");
	});

	it("R1#5: parkIssue is atomic — tombstone + authority + closeout under one mutex hold", async () => {
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const { parkIssue } = await import("../lifecycle-closeout.js");
		const report = await parkIssue(baseDeps(store), {
			issueUuid: UUID,
			projectName: "proj",
			founderDecisionId: "founder-1",
		});
		expect(report.outcome).toBe("complete");
		expect(store.getActiveIssueDispositionIntent(UUID)).toBeDefined();
		expect(store.getSession("e-run")?.status).toBe("terminated");
		// unparkIssue supersedes under the same mutex discipline.
		const { unparkIssue } = await import("../lifecycle-closeout.js");
		const changed = await unparkIssue(
			{ store, withIssueMutex: createIssueMutex() },
			{ issueUuid: UUID, supersededBy: "founder-2" },
		);
		expect(changed).toBe(true);
		expect(store.getActiveIssueDispositionIntent(UUID)).toBeUndefined();
	});
});

describe("Codex R2 fixes", () => {
	it("R2#6: closeoutIssueWithSnapshotGuard — drift/linear-drift/no-lookup reject INSIDE the mutex; clean match closes", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const input = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled" as const,
			authority: "linear_reconcile" as const,
		};
		const approvedLinear = {
			stateType: "canceled",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};

		// (a) snapshot drift → rejected, zero mutation
		const drift = await closeoutIssueWithSnapshotGuard(baseDeps(store), input, {
			approvedJson: "APPROVED",
			recompute: () => "DIFFERENT",
			freshLinear: async () => approvedLinear,
			approvedLinear,
		});
		expect(drift).toMatchObject({ rejected: true, reason: "snapshot_drift" });
		expect(store.getSession("e-run")?.status).toBe("running");

		// (b) no fresh-Linear lookup available → rejected fail-closed
		const noLookup = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedJson: "SAME",
				recompute: () => "SAME",
				approvedLinear,
			},
		);
		expect(noLookup).toMatchObject({
			rejected: true,
			reason: "linear_lookup_unavailable",
		});

		// (c) Linear reopened since approval → rejected
		const reopened = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedJson: "SAME",
				recompute: () => "SAME",
				freshLinear: async () => ({
					stateType: "started",
					updatedAt: "2026-07-03T00:00:00.000Z",
				}),
				approvedLinear,
			},
		);
		expect(reopened).toMatchObject({ rejected: true, reason: "linear_drift" });
		expect(store.getSession("e-run")?.status).toBe("running");

		// (d) clean match → the unified closeout runs (session terminated)
		const closed = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedJson: "SAME",
				recompute: () => "SAME",
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(closed).toMatchObject({ outcome: "complete" });
		expect(store.getSession("e-run")?.status).toBe("terminated");
	});

	it("R2#5: freshAuthority=reopened blocks every node mutation (reopen wins)", async () => {
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const closeRunnerFn = vi.fn(async () => ({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 1,
		}));
		const report = await closeoutIssue(
			baseDeps(store, {
				closeRunnerFn: closeRunnerFn as never,
				freshAuthority: async () => "reopened" as const,
			}),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(report.outcome).toBe("blocked");
		expect(closeRunnerFn).not.toHaveBeenCalled();
		expect(store.getSession("e-run")?.status).toBe("running");
	});

	it("R2#1: parkIssue with the master switch OFF writes NO tombstone/authority", async () => {
		const { parkIssue } = await import("../lifecycle-closeout.js");
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const report = await parkIssue(
			baseDeps(store, { mutationEnabled: () => false }),
			{
				issueUuid: UUID,
				projectName: "proj",
				founderDecisionId: "founder-1",
			},
		);
		expect(report.outcome).toBe("blocked");
		expect(report.operatorItems).toContain("autoclean_disabled");
		expect(store.getActiveIssueDispositionIntent(UUID)).toBeUndefined();
		expect(store.getSession("e-run")?.status).toBe("running");
	});

	it("R4#7: closeoutIssue with the master switch OFF is ZERO-write (no audit, session untouched)", async () => {
		const { closeoutIssue } = await import("../lifecycle-closeout.js");
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const insertSpy = vi.spyOn(store, "insertEvent");
		const report = await closeoutIssue(
			baseDeps(store, { mutationEnabled: () => false }),
			{
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				authority: "linear_reconcile",
			},
		);
		expect(report.outcome).toBe("blocked");
		expect(report.operatorItems).toContain("autoclean_disabled");
		// The entry-level gate short-circuits BEFORE any StateStore write —
		// not even an audit row lands.
		expect(insertSpy).not.toHaveBeenCalled();
		expect(store.getSession("e-run")?.status).toBe("running");
		insertSpy.mockRestore();
	});

	it("R4#4: durable approvedHash epoch — complete replays verbatim; a non-complete prior RESUMES past a drifted snapshot", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const input = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled" as const,
			authority: "linear_reconcile" as const,
		};
		const approvedLinear = {
			stateType: "canceled",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};

		// (a) a persisted COMPLETE claim replays verbatim — the closeout is NOT
		// re-run (recompute is never called) and the live session is untouched.
		const priorReport = {
			rootKey: UUID,
			aliasKeys: [UUID],
			disposition: "canceled",
			authority: "linear_reconcile",
			nodes: [],
			operatorItems: ["replayed_marker"],
			outcome: "complete",
		};
		store.putApplyClaim(
			UUID,
			"hash-complete",
			"complete",
			JSON.stringify(priorReport),
		);
		let recomputeCalls = 0;
		const replay = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-complete",
				approvedJson: "SAME",
				recompute: () => {
					recomputeCalls++;
					return "DIFFERENT";
				},
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(replay).toMatchObject({
			outcome: "complete",
			operatorItems: ["replayed_marker"],
		});
		expect(recomputeCalls).toBe(0);
		expect(store.getSession("e-run")?.status).toBe("running");

		// (b) an in_progress prior RESUMES: the byte-compare is SKIPPED, but
		// R5#4 still RECOMPUTES and rejects any object NOT in the approved set.
		// Model "the first run already terminated the node" as a CURRENT snapshot
		// that is a SUBSET of the approved one (a missing object is tolerated).
		const approvedSnap = JSON.stringify({
			nodes: [{ executionId: "e-run", status: "running" }],
			claims: [],
			bindings: [],
			prs: [],
			threadIds: [],
		});
		// R7#1: a MISSING approved node is now rejected — the epoch's legal
		// self-progress is the node moving to its disposition-specific terminal
		// status (canceled → terminated), NOT vanishing.
		const currentSubset = JSON.stringify({
			nodes: [{ executionId: "e-run", status: "terminated" }],
			claims: [],
			bindings: [],
			prs: [],
			threadIds: [],
		});
		store.putApplyClaim(UUID, "hash-resume", "in_progress", "");
		const resumed = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-resume",
				approvedJson: approvedSnap,
				recompute: () => currentSubset,
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(resumed).toMatchObject({ outcome: "complete" });
		expect(store.getSession("e-run")?.status).toBe("terminated");

		// (c) R5#4: a resume that RECOMPUTES a NEW object (not in the approved
		// set) is rejected whole-issue — the approved set is never widened.
		store.putApplyClaim(UUID, "hash-widen", "in_progress", "");
		const widened = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-widen",
				approvedJson: approvedSnap,
				recompute: () =>
					JSON.stringify({
						nodes: [
							{ executionId: "e-run", status: "running" },
							{ executionId: "e-NEW-retry", status: "running" },
						],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(widened).toMatchObject({ rejected: true });
		expect((widened as { reason: string }).reason).toContain("snapshot_drift");
		expect((widened as { reason: string }).reason).toContain("new_node");
	});

	it("R6#3: a resume where a still-present approved node's status drifted to a NON-terminal value is rejected", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const input = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled" as const,
			authority: "linear_reconcile" as const,
		};
		const approvedLinear = {
			stateType: "canceled",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};
		const approvedSnap = JSON.stringify({
			nodes: [{ executionId: "e-run", status: "running" }],
			claims: [],
			bindings: [],
			prs: [],
			threadIds: [],
		});
		store.putApplyClaim(UUID, "hash-drift", "in_progress", "");
		const drifted = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-drift",
				approvedJson: approvedSnap,
				// same node, but a NON-terminal status change (not the epoch's own
				// terminal transition) — must reject.
				recompute: () =>
					JSON.stringify({
						nodes: [{ executionId: "e-run", status: "awaiting_review" }],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(drifted).toMatchObject({ rejected: true });
		expect((drifted as { reason: string }).reason).toContain("node_status");

		// a TERMINAL status change (epoch's own first run terminated it) is OK.
		store.putApplyClaim(UUID, "hash-term", "in_progress", "");
		const terminal = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-term",
				approvedJson: approvedSnap,
				recompute: () =>
					JSON.stringify({
						nodes: [{ executionId: "e-run", status: "terminated" }],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(terminal).toMatchObject({ outcome: "complete" });
	});

	it("R7#1: a canceled resume rejects a NON-self-terminal transition (completed≠terminated) and a MISSING binding", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const store = await freshStore();
		seedSession(store, "e-run", "running");
		const input = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled" as const,
			authority: "linear_reconcile" as const,
		};
		const approvedLinear = {
			stateType: "canceled",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};
		// canceled's ONLY self-produced terminal status is `terminated` — a node
		// that became `completed` was terminated by an EXTERNAL path → reject.
		const approvedSnap = JSON.stringify({
			nodes: [{ executionId: "e-run", status: "running" }],
			claims: [],
			bindings: [{ executionId: "e-run", branch: "b", generation: "g1" }],
			prs: [],
			threadIds: [],
		});
		store.putApplyClaim(UUID, "hash-ext", "in_progress", "");
		const external = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-ext",
				approvedJson: approvedSnap,
				recompute: () =>
					JSON.stringify({
						nodes: [{ executionId: "e-run", status: "completed" }],
						claims: [],
						bindings: [{ executionId: "e-run", branch: "b", generation: "g1" }],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(external).toMatchObject({ rejected: true });
		expect((external as { reason: string }).reason).toContain("node_status");

		// a MISSING approved binding (the closeout does not clear binding
		// metadata) → reject.
		store.putApplyClaim(UUID, "hash-mb", "in_progress", "");
		const missingBinding = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-mb",
				approvedJson: approvedSnap,
				recompute: () =>
					JSON.stringify({
						nodes: [{ executionId: "e-run", status: "terminated" }],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(missingBinding).toMatchObject({ rejected: true });
		expect((missingBinding as { reason: string }).reason).toContain(
			"missing_binding",
		);
	});

	it("R8#1: canceled resume rejects a PRESERVE node (failed) externally moved to terminated", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const store = await freshStore();
		seedSession(store, "e-fail", "failed");
		const input = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled" as const,
			authority: "linear_reconcile" as const,
		};
		const approvedLinear = {
			stateType: "canceled",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};
		// canceled preserves `failed` (no status change); an external path moving
		// it to `terminated` is NOT the epoch's own transition → reject.
		const approvedSnap = JSON.stringify({
			nodes: [{ executionId: "e-fail", status: "failed" }],
			claims: [],
			bindings: [],
			prs: [],
			threadIds: [],
		});
		store.putApplyClaim(UUID, "hash-preserve", "in_progress", "");
		const drifted = await closeoutIssueWithSnapshotGuard(
			baseDeps(store),
			input,
			{
				approvedHash: "hash-preserve",
				approvedJson: approvedSnap,
				recompute: () =>
					JSON.stringify({
						nodes: [{ executionId: "e-fail", status: "terminated" }],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => approvedLinear,
				approvedLinear,
			},
		);
		expect(drifted).toMatchObject({ rejected: true });
		expect((drifted as { reason: string }).reason).toContain("node_status");
	});

	it("R9#1: shipped resume rejects transitions only ANOTHER role could produce", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const shippedLinear = {
			stateType: "completed",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};
		const shippedInput = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "shipped" as const,
			authority: "ship_complete" as const,
		};
		const run = async (
			hash: string,
			approvedNode: Record<string, unknown>,
			currentNode: Record<string, unknown>,
		) => {
			const store2 = await freshStore();
			seedSession(store2, "e-x", "running");
			store2.putApplyClaim(UUID, hash, "in_progress", "");
			const approvedJson = JSON.stringify({
				nodes: [approvedNode],
				claims: [],
				bindings: [],
				prs: [],
				threadIds: [],
			});
			return closeoutIssueWithSnapshotGuard(baseDeps(store2), shippedInput, {
				approvedHash: hash,
				approvedJson,
				recompute: () =>
					JSON.stringify({
						nodes: [currentNode],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => shippedLinear,
				approvedLinear: shippedLinear,
			});
		};

		// (a) a plain running root/session is NOT finalizable → `terminated`
		// (which only a non-PASS QA produces) → reject.
		const rootDrift = await run(
			"h-root",
			{ executionId: "e-x", status: "running", role: "session" },
			{ executionId: "e-x", status: "terminated", role: "session" },
		);
		expect(rootDrift).toMatchObject({ rejected: true });
		expect((rootDrift as { reason: string }).reason).toContain("node_status");

		// (b) a non-PASS QA self-produces only `terminated` → `completed` → reject.
		const qaDrift = await run(
			"h-qa",
			{ executionId: "e-x", status: "running", role: "qa", qaStatus: "failed" },
			{
				executionId: "e-x",
				status: "completed",
				role: "qa",
				qaStatus: "failed",
			},
		);
		expect(qaDrift).toMatchObject({ rejected: true });
		expect((qaDrift as { reason: string }).reason).toContain("node_status");

		// (c) an already-terminal node the epoch never re-finalizes → reject.
		const termDrift = await run(
			"h-term",
			{ executionId: "e-x", status: "rejected", role: "session" },
			{ executionId: "e-x", status: "completed", role: "session" },
		);
		expect(termDrift).toMatchObject({ rejected: true });
		expect((termDrift as { reason: string }).reason).toContain("node_status");

		// sanity: a FINALIZE_DONE source → completed IS a legal shipped self-produced
		// transition (not rejected for status drift).
		const ok = await run(
			"h-ok",
			{ executionId: "e-x", status: "awaiting_review", role: "session" },
			{ executionId: "e-x", status: "completed", role: "session" },
		);
		// awaiting_review→completed passes the drift gate; the closeout then runs.
		expect((ok as { reason?: string }).reason ?? "").not.toContain(
			"node_status",
		);
	});

	it("R10#1/R10#2: resume rejects qaStatus/role drift (status unchanged) and QA terminate from an FSM-illegal source", async () => {
		const { closeoutIssueWithSnapshotGuard } = await import(
			"../lifecycle-closeout.js"
		);
		const shippedLinear = {
			stateType: "completed",
			updatedAt: "2026-07-02T00:00:00.000Z",
		};
		const shippedInput = {
			issueKey: UUID,
			projectName: "proj",
			disposition: "shipped" as const,
			authority: "ship_complete" as const,
		};
		const run = async (
			hash: string,
			approvedNode: Record<string, unknown>,
			currentNode: Record<string, unknown>,
		) => {
			const store2 = await freshStore();
			seedSession(store2, "e-x", "running");
			store2.putApplyClaim(UUID, hash, "in_progress", "");
			return closeoutIssueWithSnapshotGuard(baseDeps(store2), shippedInput, {
				approvedHash: hash,
				approvedJson: JSON.stringify({
					nodes: [approvedNode],
					claims: [],
					bindings: [],
					prs: [],
					threadIds: [],
				}),
				recompute: () =>
					JSON.stringify({
						nodes: [currentNode],
						claims: [],
						bindings: [],
						prs: [],
						threadIds: [],
					}),
				freshLinear: async () => shippedLinear,
				approvedLinear: shippedLinear,
			});
		};

		// R10#1: qaStatus drift (running→passed) with UNCHANGED session status —
		// AutoQaCoordinator flipping the QA verdict between approval and resume.
		const qaDrift = await run(
			"h-qadrift",
			{
				executionId: "e-x",
				status: "running",
				role: "qa",
				qaStatus: "running",
			},
			{ executionId: "e-x", status: "running", role: "qa", qaStatus: "passed" },
		);
		expect(qaDrift).toMatchObject({ rejected: true });
		expect((qaDrift as { reason: string }).reason).toContain("node_qastatus");

		// R10#1: role drift (session→qa) with UNCHANGED status → reject.
		const roleDrift = await run(
			"h-roledrift",
			{ executionId: "e-x", status: "running", role: "session" },
			{ executionId: "e-x", status: "running", role: "qa", qaStatus: "failed" },
		);
		expect(roleDrift).toMatchObject({ rejected: true });
		expect((roleDrift as { reason: string }).reason).toContain("node_role");

		// R10#2: a non-PASS QA at a FSM-illegal terminate source (`approved`) can
		// NOT self-produce `terminated` — an external approved→terminated → reject.
		const qaApproved = await run(
			"h-qaapproved",
			{
				executionId: "e-x",
				status: "approved",
				role: "qa",
				qaStatus: "failed",
			},
			{
				executionId: "e-x",
				status: "terminated",
				role: "qa",
				qaStatus: "failed",
			},
		);
		expect(qaApproved).toMatchObject({ rejected: true });
		expect((qaApproved as { reason: string }).reason).toContain("node_status");

		// R11#1: `blocked`/`failed` DO have a legal FSM →terminated edge and the
		// shipped non-PASS QA executor sets wantTerminate for them (not AUTO_CLOSE),
		// so blocked→terminated / failed→terminated is legit epoch progress — the
		// guard must NOT reject it (else the approved epoch can't converge).
		for (const src of ["blocked", "failed"] as const) {
			const okQa = await run(
				`h-qa-${src}`,
				{ executionId: "e-x", status: src, role: "qa", qaStatus: "failed" },
				{
					executionId: "e-x",
					status: "terminated",
					role: "qa",
					qaStatus: "failed",
				},
			);
			expect(
				(okQa as { reason?: string }).reason ?? "",
				`non-PASS QA ${src}->terminated must be a legal resume`,
			).not.toContain("node_status");
		}

		// R11#1: `timeout` has NO FSM terminate edge → still rejected.
		const qaTimeout = await run(
			"h-qatimeout",
			{ executionId: "e-x", status: "timeout", role: "qa", qaStatus: "failed" },
			{
				executionId: "e-x",
				status: "terminated",
				role: "qa",
				qaStatus: "failed",
			},
		);
		expect(qaTimeout).toMatchObject({ rejected: true });
		expect((qaTimeout as { reason: string }).reason).toContain("node_status");
	});
});
