/**
 * FLY-1066 face ③: StateStore non-terminal rows that have no CommDB registry
 * row and whose tmux session is proven dead are terminalized fail-closed.
 */
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	reapStateStoreGhost,
	reconcileStateStoreGhosts,
	type StateStoreGhostDeps,
} from "../bridge/statestore-ghost-reconcile.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

const NOW_MS = Date.parse("2026-07-16T12:00:00Z");
const OLD = "2026-07-16 11:29:59";

describe("StateStore ghost reconcile (FLY-1066)", () => {
	let store: StateStore;
	let transitionOpts: ApplyTransitionOpts;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		transitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
		};
	});
	afterEach(() => store.close());

	function seed(
		executionId: string,
		opts: {
			status?: string;
			startedAt?: string;
			tmuxSession?: string;
			projectName?: string;
			chatThreadRole?: string;
		} = {},
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: `issue-${executionId}`,
			project_name: opts.projectName ?? "geo",
			status: opts.status ?? "running",
			started_at: opts.startedAt ?? OLD,
			tmux_session: opts.tmuxSession ?? "legacy-untrusted-session-name",
			chat_thread_role: opts.chatThreadRole ?? "main",
		});
	}

	function baseDeps(
		overrides: Partial<StateStoreGhostDeps> = {},
	): StateStoreGhostDeps {
		return {
			store,
			transitionOpts,
			ghostMinAgeMs: 30 * 60 * 1000,
			nowMs: () => NOW_MS,
			lookupCommDbSession: vi.fn(() => undefined),
			getProvenDeadTmuxTarget: vi.fn(() => "runner-geo:@42"),
			probe: vi.fn(async () => "dead" as const),
			finalizeCommDbSession: vi.fn(() => ({
				ok: true,
				outcome: "finalized",
				retiredGateCount: 0,
				deletedSessionCount: 0,
			})),
			archiveThread: vi.fn(async () => {}),
			log: () => {},
			...overrides,
		};
	}

	it("reaps an aged workflow ghost in fail-closed order: finalize → transition → archive → event", async () => {
		seed("qa-ghost", { chatThreadRole: "qa" });
		const order: string[] = [];
		transitionOpts.onTransition = () => order.push("transition");
		const deps = baseDeps({
			finalizeCommDbSession: vi.fn(() => {
				order.push("finalize");
				return {
					ok: true,
					outcome: "finalized",
					retiredGateCount: 0,
					deletedSessionCount: 0,
				};
			}),
			archiveThread: vi.fn(async () => {
				order.push("archive");
			}),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("qa-ghost")!,
			deps,
		);

		expect(outcome).toBe("reaped");
		expect(order).toEqual(["finalize", "transition", "archive"]);
		expect(store.getSession("qa-ghost")?.status).toBe("terminated");
		expect(store.getEventsByExecution("qa-ghost")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event_type: "runner_residue_ghost_reaped",
					source: "bridge.statestore-ghost-reconcile",
				}),
			]),
		);
	});

	it.each(["pending", "running"])(
		"terminalizes the active source status %s only with same-pass dead-target evidence",
		async (status) => {
			seed(`ghost-${status}`, { status });
			const outcome = await reapStateStoreGhost(
				store.getSession(`ghost-${status}`)!,
				baseDeps(),
			);
			expect(outcome).toBe("reaped");
			expect(store.getSession(`ghost-${status}`)?.status).toBe("terminated");
		},
	);

	it.each(["awaiting_review", "approved_to_ship", "design_done"])(
		"keeps parked founder-owned status %s even with exact dead-target evidence",
		async (status) => {
			seed(`parked-${status}`, { status });
			const deps = baseDeps();

			const outcome = await reapStateStoreGhost(
				store.getSession(`parked-${status}`)!,
				deps,
			);

			expect(outcome).toBe("kept_non_candidate_status");
			expect(deps.lookupCommDbSession).not.toHaveBeenCalled();
			expect(deps.probe).not.toHaveBeenCalled();
			expect(store.getSession(`parked-${status}`)?.status).toBe(status);
		},
	);

	it("does not scan terminal, preserve, reconnecting, or another project's rows", async () => {
		seed("candidate");
		seed("terminal", { status: "completed" });
		seed("preserve", { status: "failed" });
		seed("reconnecting", { status: "reconnecting" });
		seed("other-project", { projectName: "other" });
		const deps = baseDeps();

		const result = await reconcileStateStoreGhosts("geo", deps);

		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(1);
		expect(deps.probe).toHaveBeenCalledTimes(1);
		expect(store.getSession("terminal")?.status).toBe("completed");
		expect(store.getSession("preserve")?.status).toBe("failed");
		expect(store.getSession("reconnecting")?.status).toBe("reconnecting");
		expect(store.getSession("other-project")?.status).toBe("running");
	});

	it.each([
		["fresh", "2026-07-16 11:30:00"],
		["missing", undefined],
		["invalid", "not-a-datetime"],
		["future", "2026-07-16 12:00:01"],
	] as const)(
		"keeps %s started_at fail-closed without reading CommDB or probing",
		async (id, startedAt) => {
			seed(id, { startedAt: startedAt ?? undefined });
			const deps = baseDeps();

			const candidate = store.getSession(id)!;
			const outcome = await reapStateStoreGhost(
				startedAt === undefined
					? { ...candidate, started_at: undefined }
					: candidate,
				deps,
			);

			expect(outcome).toBe("kept_fresh_or_invalid_age");
			expect(deps.lookupCommDbSession).not.toHaveBeenCalled();
			expect(deps.probe).not.toHaveBeenCalled();
		},
	);

	it("keeps a CommDB-present active holder without probing", async () => {
		seed("active-holder", { status: "pending" });
		const deps = baseDeps({
			lookupCommDbSession: vi.fn(() => ({ status: "running" })),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("active-holder")!,
			deps,
		);

		expect(outcome).toBe("kept_commdb_present");
		expect(deps.probe).not.toHaveBeenCalled();
		expect(store.getSession("active-holder")?.status).toBe("pending");
	});

	it("keeps an unreadable CommDB fail-closed without probing or finalizing", async () => {
		seed("comm-unreadable");
		const deps = baseDeps({
			lookupCommDbSession: vi.fn(() => {
				throw new Error("database is locked");
			}),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("comm-unreadable")!,
			deps,
		);

		expect(outcome).toBe("kept_commdb_indeterminate");
		expect(deps.probe).not.toHaveBeenCalled();
		expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
	});

	it("keeps a production-shaped row with no same-pass authoritative target", async () => {
		seed("no-target", { tmuxSession: "legacy-bare-session" });
		const deps = baseDeps({
			getProvenDeadTmuxTarget: vi.fn(() => undefined),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("no-target")!,
			deps,
		);

		expect(outcome).toBe("kept_no_authoritative_target");
		expect(deps.probe).not.toHaveBeenCalled();
	});

	it("rejects a bare-session evidence target instead of probing shared-session scope", async () => {
		seed("bare-target");
		const deps = baseDeps({
			getProvenDeadTmuxTarget: vi.fn(() => "runner-geo"),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("bare-target")!,
			deps,
		);

		expect(outcome).toBe("kept_invalid_authoritative_target");
		expect(deps.probe).not.toHaveBeenCalled();
	});

	it.each(["alive", "indeterminate"] as const)(
		"keeps running + %s exact window",
		async (probeState) => {
			seed(`review-${probeState}`);
			const deps = baseDeps({ probe: vi.fn(async () => probeState) });

			const outcome = await reapStateStoreGhost(
				store.getSession(`review-${probeState}`)!,
				deps,
			);

			expect(outcome).toBe("kept_target_not_dead");
			expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
			expect(store.getSession(`review-${probeState}`)?.status).toBe("running");
		},
	);

	it("treats a throwing tmux probe as indeterminate and keeps the founder-owned row", async () => {
		seed("probe-error");
		const deps = baseDeps({
			probe: vi.fn(async () => {
				throw new Error("tmux timed out");
			}),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("probe-error")!,
			deps,
		);

		expect(outcome).toBe("kept_target_not_dead");
		expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
	});

	it("keeps when the post-probe StateStore status changes", async () => {
		seed("state-race");
		const deps = baseDeps({
			probe: vi.fn(async () => {
				store.upsertSession({
					execution_id: "state-race",
					issue_id: "issue-state-race",
					project_name: "geo",
					status: "completed",
				});
				return "dead";
			}),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("state-race")!,
			deps,
		);

		expect(outcome).toBe("kept_changed_after_probe");
		expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
		expect(store.getSession("state-race")?.status).toBe("completed");
	});

	it("keeps when a CommDB registration appears after the probe", async () => {
		seed("comm-race");
		const lookup = vi
			.fn()
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ status: "running" });
		const deps = baseDeps({ lookupCommDbSession: lookup });

		const outcome = await reapStateStoreGhost(
			store.getSession("comm-race")!,
			deps,
		);

		expect(outcome).toBe("kept_changed_after_probe");
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
	});

	it("keeps when the final CommDB re-read becomes indeterminate", async () => {
		seed("comm-reread-error");
		const lookup = vi
			.fn()
			.mockReturnValueOnce(undefined)
			.mockImplementationOnce(() => {
				throw new Error("database became unreadable");
			});
		const deps = baseDeps({ lookupCommDbSession: lookup });

		const outcome = await reapStateStoreGhost(
			store.getSession("comm-reread-error")!,
			deps,
		);

		expect(outcome).toBe("kept_commdb_indeterminate");
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(deps.finalizeCommDbSession).not.toHaveBeenCalled();
	});

	it("finalization failure leaves the StateStore row eligible and never transitions", async () => {
		seed("finalize-fail");
		const onTransition = vi.fn();
		transitionOpts.onTransition = onTransition;
		const deps = baseDeps({
			finalizeCommDbSession: vi.fn(() => ({
				ok: false,
				outcome: "failed",
				retiredGateCount: 0,
				deletedSessionCount: 0,
				error: "sqlite busy",
			})),
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("finalize-fail")!,
			deps,
		);

		expect(outcome).toBe("finalize_failed");
		expect(onTransition).not.toHaveBeenCalled();
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("finalize-fail")?.status).toBe("running");
	});

	it("FSM rejection after finalize never force-writes terminated", async () => {
		seed("fsm-reject");
		const deps = baseDeps({
			transitionOpts: {
				store,
				fsm: new WorkflowFSM({ ...WORKFLOW_TRANSITIONS, running: [] }),
			},
		});

		const outcome = await reapStateStoreGhost(
			store.getSession("fsm-reject")!,
			deps,
		);

		expect(outcome).toBe("transition_failed");
		expect(deps.finalizeCommDbSession).toHaveBeenCalledOnce();
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("fsm-reject")?.status).toBe("running");
	});

	it("holds the canonical issue lifecycle mutex across the entire decision and reap", async () => {
		seed("locked");
		const order: string[] = [];
		const deps = baseDeps({
			lifecycleMutex: {
				resolveLockKeys: vi.fn(() => ["root-issue"]),
				withIssueMutex: vi.fn(async (_keys, fn) => {
					order.push("lock-enter");
					const value = await fn();
					order.push("lock-exit");
					return value;
				}),
			},
			finalizeCommDbSession: vi.fn(() => {
				order.push("finalize");
				return {
					ok: true,
					outcome: "finalized",
					retiredGateCount: 0,
					deletedSessionCount: 0,
				};
			}),
		});

		await reapStateStoreGhost(store.getSession("locked")!, deps);

		expect(order).toEqual(["lock-enter", "finalize", "lock-exit"]);
		expect(deps.lifecycleMutex?.resolveLockKeys).toHaveBeenCalledWith(
			"issue-locked",
		);
	});
});
