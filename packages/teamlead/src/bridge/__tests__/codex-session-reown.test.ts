import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	admitCodexAgentHome,
	type CodexLaunchSnapshot,
	type CodexLeaseHolderProbeResult,
	codexAgentHomeDir,
	releaseCodexAgentHomeLease,
} from "flywheel-claude-runner";
import type { AdapterExecutionContext } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import { type Session, StateStore } from "../../StateStore.js";
import {
	acceptReownTurnReconciliation,
	CODEX_REOWN_ROLLOUT_STALE_MS,
	type CodexSessionReownDeps,
	CodexSessionReowner,
	isCodexReownExcluded,
	prepareCodexRecoveryAgentHome,
} from "../codex-session-reown.js";

function session(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "issue-1",
		issue_identifier: "FLY-2211",
		project_name: "flywheel",
		status: "running",
		adapter_type: "codex-tmux",
		lifecycle_revision: 7,
		...overrides,
	};
}

function harness(
	input: {
		candidate?: Session;
		liveness?: "alive" | "absent" | "unknown";
		gateHeld?: boolean;
		owned?: boolean;
		current?: boolean;
		reapOutcome?: "reaped" | "absent" | "residual" | "unverifiable";
	} = {},
) {
	const candidate = input.candidate ?? session();
	const order: string[] = [];
	let owned = input.owned ?? false;
	const events: string[] = [];
	const claim = vi.fn(() => {
		order.push("claim");
		return {
			ok: true as const,
			claimToken: "claim-1",
			episodeId: "episode-1",
			attempt: 1,
			reservationSeq: 1,
			expiresAtMs: 61_000,
		};
	});
	const abort = vi.fn(() => {
		order.push("abort");
		return true;
	});
	const commit = vi.fn(() => {
		order.push("commit");
		return { ok: true as const, lifecycleRevision: 8 };
	});
	const prepareCapabilities = vi.fn(() => ({
		ok: true as const,
		enrolled: false,
		workflowSubmissionExpected: false,
		founderReviewRequired: false,
	}));
	const onRecoveryExhausted = vi.fn(async () => {
		order.push("terminal");
	});
	const reconcileTurn = vi.fn(async () => {});
	const revive = vi.fn(
		async (
			_candidate: Session,
			hooks: Parameters<CodexSessionReownDeps["revive"]>[1],
		) => {
			order.push("revive");
			owned = true;
			await hooks.onRecoveryOwnershipEstablished({
				kind: "turn_started",
				threadId: "thread-1",
				turnId: "turn-1",
			});
			return {
				success: true,
				sessionId: candidate.execution_id,
				durationMs: 1,
				timedOut: false,
			};
		},
	);
	const deps: CodexSessionReownDeps = {
		store: {
			getReadoptCandidateSessions: vi.fn(() => [candidate]),
			claimCodexRecovery: claim,
			prepareCodexRecoveryCapabilities: prepareCapabilities,
			abortCodexRecovery: abort,
			commitCodexRecovery: commit,
			finalizeCodexRecoveryExhaustion: vi.fn(() => undefined),
			settleCodexRecoveryFailure: vi.fn(() => {
				order.push("settle");
				return { ok: false as const, reason: "claim_lost" as const };
			}),
		},
		owners: {
			isExecutionOwned: vi.fn(() => owned),
		},
		isCurrentBinding: vi.fn(() => input.current ?? true),
		hasOpenGate: vi.fn(async () => input.gateHeld ?? false),
		probe: vi.fn(async () => input.liveness ?? "absent"),
		reap: vi.fn(async () => {
			order.push("reap");
			return {
				outcome: input.reapOutcome ?? "reaped",
				socketPath: "/tmp/test.sock",
			};
		}),
		revive,
		reconcileTurn,
		readTurnHolder: vi.fn(async () => candidate.execution_id),
		onRecoveryExhausted,
		record: vi.fn((event) => {
			events.push(event);
		}),
		alert: vi.fn(async () => undefined),
		nowMs: vi.fn(() => 1_000),
		holderId: "bridge-test",
		isExcluded: isCodexReownExcluded,
	};
	return {
		candidate,
		deps,
		order,
		events,
		claim,
		abort,
		commit,
		revive,
		reconcileTurn,
		onRecoveryExhausted,
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function recoveryContext(): AdapterExecutionContext {
	return {
		executionId: "exec-1",
		issueId: "issue-1",
		prompt: "resume",
		cwd: "/tmp/worktree",
	};
}

function recoverySnapshot(
	skillFrameworkMode: "superpowers" | "matt" | "bare" | null = "bare",
): CodexLaunchSnapshot {
	return {
		launchContext: { skillFrameworkMode },
	} as CodexLaunchSnapshot;
}

describe("FLY-2358 Codex reown agent-home preparation", () => {
	it("never migrates a deployment-era legacy execution home", async () => {
		const admit = vi.fn();
		const context = recoveryContext();
		expect(
			await prepareCodexRecoveryAgentHome(
				{
					session: session({ workflow_node_id: "implement" }),
					snapshot: recoverySnapshot(),
					context,
				},
				{
					resolve: () => ({ kind: "legacy", home: "/tmp/legacy" }),
					admit,
					release: vi.fn(),
				},
			),
		).toBe(context);
		expect(admit).not.toHaveBeenCalled();
	});

	it.each(["keyed", "prepublished"] as const)(
		"re-admits a %s execution and carries the exact handle into resume",
		async (kind) => {
			const admit = vi.fn(async () => ({
				handle: {
					project: "flywheel",
					role: "implement",
					home: "/tmp/keyed",
					executionId: "exec-1",
					token: "0123456789abcdef0123456789abcdef",
				},
				effectiveAssemblyArm: "bare" as const,
				inherited: false,
				liveLeases: 1,
				createdLease: kind === "keyed",
			}));
			const result = await prepareCodexRecoveryAgentHome(
				{
					session: session({ workflow_node_id: "implement" }),
					snapshot: recoverySnapshot("bare"),
					context: recoveryContext(),
				},
				{
					resolve: () => ({
						kind,
						project: "flywheel",
						role: "implement",
						home: "/tmp/keyed",
					}),
					admit,
					release: vi.fn(),
				},
			);
			expect(admit).toHaveBeenCalledWith({
				project: "flywheel",
				role: "implement",
				executionId: "exec-1",
				requestedAssemblyArm: "bare",
			});
			expect(result.codexAgentHome).toEqual({
				project: "flywheel",
				role: "implement",
				home: "/tmp/keyed",
				token: "0123456789abcdef0123456789abcdef",
				assemblyArm: "bare",
				createdLease: kind === "keyed",
			});
		},
	);

	it("fails closed and releases a newly-created lease when the immutable arm drifts", async () => {
		const handle = {
			project: "flywheel",
			role: "implement",
			home: "/tmp/keyed",
			executionId: "exec-1",
			token: "0123456789abcdef0123456789abcdef",
		};
		const release = vi.fn(async () => undefined);
		await expect(
			prepareCodexRecoveryAgentHome(
				{
					session: session({ workflow_node_id: "implement" }),
					snapshot: recoverySnapshot("bare"),
					context: recoveryContext(),
				},
				{
					resolve: () => ({
						kind: "keyed",
						project: "flywheel",
						role: "implement",
						home: "/tmp/keyed",
					}),
					admit: async () => ({
						handle,
						effectiveAssemblyArm: "matt",
						inherited: true,
						liveLeases: 2,
						createdLease: true,
					}),
					release,
				},
			),
		).rejects.toThrow("keyed_home_reown_arm_mismatch");
		expect(release).toHaveBeenCalledWith(handle);
	});

	it.each([
		["still hold it", { status: "ok", holders: [86434] }, true],
		[
			"cannot be vouched for",
			{ status: "unknown", reason: "probe_failed" },
			true,
		],
		["are gone", { status: "ok", holders: [] }, false],
	] as const)(
		"FLY-2877 rolls back a re-admitted lease only when its codex processes %s",
		async (_label, holders: CodexLeaseHolderProbeResult, leaseKept) => {
			const identity = { project: "flywheel", role: "implement" };
			// Another execution pins the home's arm to bare, so re-admitting with
			// superpowers creates this lease and then fails the arm check.
			await admitCodexAgentHome({
				...identity,
				executionId: "exec-other",
				requestedAssemblyArm: "bare",
			});
			const probe = vi.fn(async () => holders);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			await expect(
				prepareCodexRecoveryAgentHome(
					{
						session: session({ workflow_node_id: "implement" }),
						snapshot: recoverySnapshot("superpowers"),
						context: recoveryContext(),
					},
					{
						resolve: () => ({
							kind: "keyed",
							...identity,
							home: codexAgentHomeDir(identity),
						}),
						admit: admitCodexAgentHome,
						release: (handle) =>
							releaseCodexAgentHomeLease(handle, undefined, { probe }),
					},
				),
			).rejects.toThrow("keyed_home_reown_arm_mismatch");
			const home = codexAgentHomeDir(identity);
			expect(probe).toHaveBeenCalledWith(home, "exec-1");
			expect(existsSync(join(home, ".flywheel-leases", "exec-1"))).toBe(
				leaseKept,
			);
			expect(existsSync(join(home, ".flywheel-leases", "exec-other"))).toBe(
				true,
			);
			expect(
				warn.mock.calls.some((call) =>
					String(call[0]).includes(
						"[codex-session-reown] keyed_home_lease_retained exec=exec-1",
					),
				),
			).toBe(leaseKept);
			warn.mockRestore();
		},
	);

	it("fails closed for unresolved keyed state and skips admission without a role", async () => {
		const admit = vi.fn();
		await expect(
			prepareCodexRecoveryAgentHome(
				{
					session: session({ workflow_node_id: "implement" }),
					snapshot: recoverySnapshot(),
					context: recoveryContext(),
				},
				{
					resolve: () => ({
						kind: "unknown",
						reason: "invalid_agent_home_record",
					}),
					admit,
					release: vi.fn(),
				},
			),
		).rejects.toThrow("invalid_agent_home_record");

		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const context = recoveryContext();
		expect(
			await prepareCodexRecoveryAgentHome(
				{
					session: session({ workflow_node_id: undefined }),
					snapshot: recoverySnapshot(),
					context,
				},
				{ resolve: vi.fn(), admit, release: vi.fn() },
			),
		).toBe(context);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("identity_unresolved reason=no_role"),
		);
	});
});

describe("FLY-2211 Codex session re-owner", () => {
	it("treats a non-holder turn reconcile as a normal no-op", () => {
		expect(() =>
			acceptReownTurnReconciliation({ ok: false, reason: "not_holder" }),
		).not.toThrow();
		expect(() =>
			acceptReownTurnReconciliation({
				ok: false,
				reason: "active_turn_mismatch",
			}),
		).toThrow("active_turn_mismatch");
	});

	it.each([
		{
			name: "running gate-free alive watches without touching the daemon",
			status: "running",
			gateHeld: false,
			liveness: "alive" as const,
			expectedOrder: [] as string[],
			event: "reown_watch_started",
		},
		{
			name: "running gate-free absent revives without a recycle",
			status: "running",
			gateHeld: false,
			liveness: "absent" as const,
			expectedOrder: ["claim", "revive", "commit"],
			event: "reown_revive_succeeded",
		},
		{
			name: "running gate-held alive recycles before revive",
			status: "running",
			gateHeld: true,
			liveness: "alive" as const,
			expectedOrder: ["claim", "reap", "revive", "commit"],
			event: "reown_revive_succeeded",
		},
		{
			name: "running gate-held absent revives with the gate latch restored by the owner",
			status: "running",
			gateHeld: true,
			liveness: "absent" as const,
			expectedOrder: ["claim", "revive", "commit"],
			event: "reown_revive_succeeded",
		},
		{
			name: "parked alive recycles before revive",
			status: "awaiting_review",
			gateHeld: false,
			liveness: "alive" as const,
			expectedOrder: ["claim", "reap", "revive", "commit"],
			event: "reown_revive_succeeded",
		},
		{
			name: "parked absent revives directly",
			status: "design_done",
			gateHeld: false,
			liveness: "absent" as const,
			expectedOrder: ["claim", "revive", "commit"],
			event: "reown_revive_succeeded",
		},
	])("$name", async ({ status, gateHeld, liveness, expectedOrder, event }) => {
		const h = harness({
			candidate: session({ status }),
			gateHeld,
			liveness,
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await settle();

		expect(h.order).toEqual(expectedOrder);
		expect(h.events).toContain(event);
	});

	it("removes process-local owners before every probe or recovery mutation", async () => {
		const h = harness({ owned: true, liveness: "alive", gateHeld: true });
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.deps.probe).not.toHaveBeenCalled();
		expect(h.claim).not.toHaveBeenCalled();
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
	});

	it("does not auto-reown a no-demand workflow standby", async () => {
		const h = harness({ liveness: "absent" });
		h.deps.isIntentionalStandby = vi.fn(() => true);

		await new CodexSessionReowner(h.deps).runPass();

		expect(h.deps.probe).not.toHaveBeenCalled();
		expect(h.claim).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
	});

	it("reconciles a live daemon turn before publishing the watch-arm event", async () => {
		const h = harness({ liveness: "alive", gateHeld: false });
		const sequence: string[] = [];
		h.reconcileTurn.mockImplementation(async () => {
			sequence.push("reconcile");
		});
		h.deps.record = vi.fn((event) => {
			if (event === "reown_watch_started") sequence.push("watch");
		});

		await new CodexSessionReowner(h.deps).runPass();

		expect(sequence).toEqual(["reconcile", "watch"]);
	});

	it("does not publish a watch-arm event when turn reconciliation fails", async () => {
		const h = harness({ liveness: "alive", gateHeld: false });
		h.reconcileTurn.mockRejectedValue(new Error("thread/read malformed"));

		await new CodexSessionReowner(h.deps).runPass();

		expect(h.events).toContain("reown_turn_reconcile_failed");
		expect(h.events).not.toContain("reown_watch_started");
	});

	it("reconciles a revived daemon turn after recovery commit and before its arm event", async () => {
		const h = harness({ liveness: "absent", gateHeld: false });
		h.reconcileTurn.mockImplementation(async () => {
			h.order.push("reconcile");
		});

		await new CodexSessionReowner(h.deps).runPass();
		await settle();

		expect(h.order).toEqual(["claim", "revive", "commit", "reconcile"]);
		expect(h.events).toContain("reown_revive_succeeded");
	});

	it("does not publish a revive-arm event when post-commit reconciliation fails", async () => {
		const h = harness({ liveness: "absent", gateHeld: false });
		h.reconcileTurn.mockRejectedValue(new Error("commdb unavailable"));

		await new CodexSessionReowner(h.deps).runPass();
		await settle();

		expect(h.events).toContain("reown_turn_reconcile_failed");
		expect(h.events).not.toContain("reown_revive_succeeded");
	});

	it("filters superseded, non-Codex, and explicit generalized-room rows before liveness", async () => {
		const roomInfo = {
			schemaVersion: 1,
			slot: 3,
			projectName: "test-slot-3",
			generalized: true,
		};
		const rows = [
			session({ execution_id: "superseded", retry_successor: "next" }),
			session({ execution_id: "not-current" }),
			session({ execution_id: "claude", adapter_type: "claude-tmux" }),
			session({
				execution_id: "9b08b5aa-7ba7-4e24-9d7c-a43f3844c288",
				project_name: "test-slot-3",
				tmux_session: "runner-test-slot-3",
				worktree_path: "/tmp/flywheel-test-slot-3/project-slot-3-FLY-2211",
			}),
		];
		const h = harness({ candidate: rows[0] });
		h.deps.isExcluded = (candidate) =>
			isCodexReownExcluded(candidate, roomInfo);
		vi.mocked(h.deps.store.getReadoptCandidateSessions).mockReturnValue(rows);
		vi.mocked(h.deps.isCurrentBinding).mockImplementation(
			(row) => row.execution_id !== "not-current",
		);
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.deps.probe).not.toHaveBeenCalled();
		expect(
			h.events.filter((event) => event === "reown_skipped_superseded"),
		).toHaveLength(2);
	});

	it("requires explicit room-info for a real generalized-room session shape", () => {
		const candidate = session({
			execution_id: "9b08b5aa-7ba7-4e24-9d7c-a43f3844c288",
			project_name: "test-slot-3",
			tmux_session: "runner-test-slot-3",
			worktree_path: "/tmp/flywheel-test-slot-3/project-slot-3-FLY-2211",
		});
		const roomInfo = {
			schemaVersion: 1,
			slot: 3,
			projectName: "test-slot-3",
			generalized: true,
		};

		expect(isCodexReownExcluded(candidate)).toBe(false);
		expect(isCodexReownExcluded(candidate, roomInfo)).toBe(true);
		expect(() =>
			isCodexReownExcluded(candidate, {
				...roomInfo,
				generalized: "true",
			}),
		).toThrow(/room-info/i);
	});

	it("fails closed on unknown evidence and alerts only after two consecutive passes", async () => {
		const h = harness({ liveness: "unknown" });
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await reowner.runPass();

		expect(h.claim).not.toHaveBeenCalled();
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
		expect(
			h.events.filter((event) => event === "reown_probe_unknown"),
		).toHaveLength(2);
		expect(h.deps.alert).toHaveBeenCalledTimes(1);
	});

	it("records one watch-start across repeated healthy periodic passes", async () => {
		const h = harness({ liveness: "alive", gateHeld: false });
		const probeRolloutMtime = vi
			.fn()
			.mockResolvedValueOnce({ kind: "found" as const, mtimeMs: 1_777 })
			.mockResolvedValueOnce({ kind: "found" as const, mtimeMs: 1_778 });
		(
			h.deps as CodexSessionReownDeps & {
				probeRolloutMtime: typeof probeRolloutMtime;
			}
		).probeRolloutMtime = probeRolloutMtime;
		vi.mocked(h.deps.nowMs)
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_000 + CODEX_REOWN_ROLLOUT_STALE_MS);
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await reowner.runPass();

		expect(
			h.events.filter((event) => event === "reown_watch_started"),
		).toHaveLength(1);
		expect(probeRolloutMtime).toHaveBeenCalledTimes(2);
		expect(h.deps.record).toHaveBeenCalledWith(
			"reown_watch_started",
			expect.anything(),
			expect.objectContaining({ rolloutMtimeMs: 1_777 }),
		);
		expect(h.claim).not.toHaveBeenCalled();
	});

	it("uses the rollout staleness threshold before classifying a live daemon unhealthy", async () => {
		const h = harness({ liveness: "alive", gateHeld: false });
		const probeRolloutMtime = vi.fn(async () => ({
			kind: "found" as const,
			mtimeMs: 1_777,
		}));
		(
			h.deps as CodexSessionReownDeps & {
				probeRolloutMtime: typeof probeRolloutMtime;
			}
		).probeRolloutMtime = probeRolloutMtime;
		let now = 1000;
		h.deps.nowMs = () => now;
		const reowner = new CodexSessionReowner(h.deps);
		await reowner.runPass();
		now = 1000 + CODEX_REOWN_ROLLOUT_STALE_MS - 1;
		await reowner.runPass();
		expect(h.events).not.toContain("reown_probe_unknown");
		now = 1000 + CODEX_REOWN_ROLLOUT_STALE_MS;
		await reowner.runPass();
		now = 1000 + CODEX_REOWN_ROLLOUT_STALE_MS + 5 * 60000;
		await reowner.runPass();

		expect(probeRolloutMtime).toHaveBeenCalledTimes(4);
		expect(
			h.events.filter((event) => event === "reown_watch_started"),
		).toHaveLength(1);
		expect(
			h.events.filter((event) => event === "reown_probe_unknown"),
		).toHaveLength(2);
		expect(h.deps.record).toHaveBeenCalledWith(
			"reown_probe_unknown",
			expect.anything(),
			expect.objectContaining({
				reason: expect.stringMatching(/^rollout_mtime_stale:/),
			}),
		);
		expect(h.deps.alert).toHaveBeenCalledTimes(1);
		expect(h.claim).not.toHaveBeenCalled();
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
	});

	it("treats a gate/probe exception as unknown for only that candidate", async () => {
		const first = session({ execution_id: "broken-evidence" });
		const second = session({ execution_id: "healthy-watch" });
		const h = harness({ candidate: first, liveness: "alive" });
		vi.mocked(h.deps.store.getReadoptCandidateSessions).mockReturnValue([
			first,
			second,
		]);
		vi.mocked(h.deps.hasOpenGate).mockImplementation(async (candidate) => {
			if (candidate.execution_id === first.execution_id) {
				throw new Error("commdb unavailable");
			}
			return false;
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.events).toContain("reown_probe_unknown");
		expect(h.events).toContain("reown_watch_started");
		expect(h.claim).not.toHaveBeenCalled();
	});

	it("refuses an old launch snapshot before spending a recovery attempt or reaping", async () => {
		const h = harness({ liveness: "alive", gateHeld: true });
		h.deps.preflightRecovery = vi.fn(() => {
			throw new Error("snapshot lacks rehydration context");
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.claim).not.toHaveBeenCalled();
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).toContain("reown_revive_failed");
		expect(h.deps.alert).toHaveBeenCalledTimes(1);
	});

	it("aborts without spawn when an owned execution appears after claim", async () => {
		const h = harness({ liveness: "absent" });
		let checks = 0;
		vi.mocked(h.deps.owners.isExecutionOwned).mockImplementation(
			() => ++checks >= 3,
		);
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.order).toEqual(["claim", "abort"]);
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).toContain("reown_fence_lost");
	});

	it("refuses spawn when an audited recycle cannot prove the daemon absent", async () => {
		const h = harness({
			candidate: session({ status: "awaiting_review" }),
			liveness: "alive",
			reapOutcome: "residual",
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.order).toEqual(["claim", "reap", "settle"]);
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).toContain("reown_revive_failed");
	});

	it("FLY-2352 aborts without spawn when capabilities resolve to an ambiguous activation", async () => {
		const h = harness({ liveness: "absent" });
		vi.mocked(h.deps.store.prepareCodexRecoveryCapabilities).mockReturnValue({
			ok: false,
			reason: "activation_ambiguous",
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.order).toEqual(["claim", "settle"]);
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.deps.store.settleCodexRecoveryFailure).toHaveBeenCalled();
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.deps.store.settleCodexRecoveryFailure).toHaveBeenCalledWith(
			"exec-1",
			"claim-1",
			7,
			1,
			expect.objectContaining({
				code: "owner_failed_unknown",
				stage: "context",
			}),
			1000,
			undefined,
		);
	});

	it("aborts before recycle when a crashed TURN writer already changed CommDB", async () => {
		const h = harness({ liveness: "alive", gateHeld: true });
		vi.mocked(h.deps.readTurnHolder).mockResolvedValue("replacement-exec");
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.order).toEqual(["claim", "abort"]);
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).toContain("reown_fence_lost");
		expect(h.abort).toHaveBeenCalledWith("exec-1", "claim-1", {
			releaseAttempt: true,
		});
	});

	it("classifies a parked session whose TURN moved on as an expected skip", async () => {
		const h = harness({
			candidate: session({ status: "awaiting_review" }),
			liveness: "alive",
		});
		vi.mocked(h.deps.readTurnHolder).mockResolvedValue("qa-exec");
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await reowner.runPass();

		expect(h.order).toEqual(["claim", "abort", "claim", "abort"]);
		expect(h.deps.reap).not.toHaveBeenCalled();
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).not.toContain("reown_fence_lost");
		expect(
			h.events.filter((event) => event === "reown_skipped_not_turn_holder"),
		).toHaveLength(2);
	});

	it("commits recovery only once when a restarted daemon replays the ownership hook", async () => {
		const h = harness({ liveness: "absent" });
		h.revive.mockImplementation(async (_candidate, hooks) => {
			h.order.push("revive");
			await hooks.onRecoveryOwnershipEstablished({
				kind: "turn_started",
				threadId: "thread-1",
				turnId: "turn-1",
			});
			await hooks.onRecoveryOwnershipEstablished({
				kind: "turn_started",
				threadId: "thread-1",
				turnId: "turn-2",
			});
			return {
				success: true,
				sessionId: h.candidate.execution_id,
				durationMs: 1,
				timedOut: false,
			};
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await settle();

		expect(h.commit).toHaveBeenCalledTimes(1);
		expect(h.events).not.toContain("reown_fence_lost");
		expect(h.events).toContain("reown_revive_succeeded");
	});

	it("makes overlapping boot and periodic passes one process-local single flight", async () => {
		const h = harness({ liveness: "absent" });
		let releaseProbe!: () => void;
		const pendingProbe = new Promise<"absent">((resolve) => {
			releaseProbe = () => resolve("absent");
		});
		vi.mocked(h.deps.probe).mockReturnValue(pendingProbe);
		const reowner = new CodexSessionReowner(h.deps);

		const boot = reowner.runPass();
		const periodic = reowner.runPass();
		expect(periodic).toBe(boot);
		releaseProbe();
		await boot;
		await settle();

		expect(h.claim).toHaveBeenCalledTimes(1);
		expect(h.revive).toHaveBeenCalledTimes(1);
	});

	it("propagates a hard recovery commit refusal into adapter cleanup and abort", async () => {
		const h = harness({ liveness: "absent" });
		h.commit.mockImplementation(() => {
			h.order.push("commit");
			return { ok: false as const, reason: "turn_holder_changed" };
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await settle();

		expect(h.order).toEqual(["claim", "revive", "commit", "settle"]);
		expect(h.events).toContain("reown_fence_lost");
		expect(h.events).toContain("reown_revive_failed");
	});

	it("terminalizes an exhausted episode once without starting a third owner", async () => {
		const h = harness({ liveness: "absent" });
		h.claim.mockImplementation(() => {
			h.order.push("claim");
			return {
				ok: false as const,
				reason: "episode_exhausted",
				attempts: 2,
			};
		});
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();

		expect(h.order).toEqual(["claim", "terminal"]);
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.onRecoveryExhausted).toHaveBeenCalledWith(h.candidate, 2);
		expect(h.events).toContain("reown_revive_failed");
		expect(h.deps.alert).toHaveBeenCalledTimes(1);
	});
});

describe("FLY-2505 durable reown settlement", () => {
	it.each(["readiness", "success_without_receipt"])(
		"settles %s using the production store",
		async (kind) => {
			const store = await StateStore.create(":memory:");
			try {
				store.upsertSession({
					execution_id: "exec-1",
					issue_id: "issue-1",
					project_name: "flywheel",
					status: "running",
					adapter_type: "codex-tmux",
				});
				const h = harness({ candidate: store.getSession("exec-1")! });
				h.deps.store = store;
				let now = 1000;
				h.deps.nowMs = () => now;
				h.deps.revive = async () => {
					now = 71000;
					return kind === "readiness"
						? {
								success: false,
								sessionId: "exec-1",
								recoveryFailure: {
									version: 1,
									code: "daemon_socket_not_ready",
									stage: "daemon_spawn",
									summary: "socket not ready",
									cleanup: "confirmed_absent",
								},
							}
						: { success: true, sessionId: "exec-1" };
				};
				await new CodexSessionReowner(h.deps).runPass();
				await settle();
				const events = store.getEventsByExecution("exec-1");
				expect(events).toHaveLength(1);
				expect(events[0].payload).toMatchObject({
					failure: {
						code:
							kind === "readiness"
								? "daemon_socket_not_ready"
								: "owner_result_missing",
					},
					budgetDecision: kind === "readiness" ? "refunded" : "charged",
				});
				expect(store.getCodexRecoveryEpisode("exec-1")?.episodeAttempts).toBe(
					kind === "readiness" ? 0 : 1,
				);
				expect(store.getSession("exec-1")?.status).toBe("running");
			} finally {
				store.close();
			}
		},
	);
});

describe("FLY-2505 late recovery receipt fences", () => {
	it.each(["before_receipt", "during_turn_read"])(
		"rejects a receipt after settlement %s",
		async (mode) => {
			const store = await StateStore.create(":memory:");
			try {
				store.upsertSession({
					execution_id: "exec-1",
					issue_id: "issue-1",
					project_name: "flywheel",
					status: "running",
					adapter_type: "codex-tmux",
				});
				const h = harness({ candidate: store.getSession("exec-1")! });
				h.deps.store = store;
				let hooks: Parameters<CodexSessionReownDeps["revive"]>[1] | undefined;
				let receipt: Promise<void> | undefined;
				let release: ((holder: string) => void) | undefined;
				const evidence = {
					kind: "turn_started" as const,
					threadId: "thread-1",
					turnId: "turn-1",
				};
				h.deps.revive = async (_session, input) => {
					hooks = input;
					if (mode === "during_turn_read") {
						h.deps.readTurnHolder = () =>
							new Promise((resolve) => {
								release = resolve;
							});
						receipt = input.onRecoveryOwnershipEstablished(evidence);
					}
					return { success: true, sessionId: "exec-1" };
				};
				await new CodexSessionReowner(h.deps).runPass();
				await settle();
				if (mode === "before_receipt")
					receipt = hooks!.onRecoveryOwnershipEstablished(evidence);
				else release!("exec-1");
				await expect(receipt).rejects.toThrow(/commit_refused/);
				expect(store.getSession("exec-1")?.lifecycle_revision).toBe(0);
				expect(store.getEventsByExecution("exec-1")).toHaveLength(1);
			} finally {
				store.close();
			}
		},
	);
});

it("FLY-2505 a reap rejection settles the reserved attempt with a safe diagnostic", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		const h = harness({
			candidate: store.getSession("exec-1")!,
			liveness: "alive",
			gateHeld: true,
		});
		h.deps.store = store;
		h.deps.reap = async () => {
			throw new Error("error password=private-secret /Users/private/path");
		};
		await new CodexSessionReowner(h.deps).runPass();
		await settle();
		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({
			budgetDecision: "charged",
			failure: { code: "owner_failed_unknown" },
		});
		expect(JSON.stringify(events)).not.toContain("private-secret");
	} finally {
		store.close();
	}
});

it("FLY-2505 preflight exceptions never echo raw credentials to events or alerts", async () => {
	const h = harness();
	h.deps.preflightRecovery = () => {
		throw new Error("error password=private-secret /Users/private/path");
	};
	await new CodexSessionReowner(h.deps).runPass();
	expect(
		JSON.stringify([
			vi.mocked(h.deps.record).mock.calls,
			vi.mocked(h.deps.alert).mock.calls,
		]),
	).not.toContain("private-secret");
	expect(h.claim).not.toHaveBeenCalled();
});

it("FLY-2505 retries durable exhaustion before probing or preflight after a sink failure", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		for (let n = 0; n < 2; n++) {
			const claim = store.claimCodexRecovery("exec-1", 0, {
				holder: "bridge",
				nowMs: n * 100000,
				ttlMs: 60000,
			});
			if (!claim.ok) throw new Error("claim failed");
			store.settleCodexRecoveryFailure(
				"exec-1",
				claim.claimToken,
				0,
				claim.reservationSeq,
				undefined,
				n * 100000 + 1,
			);
		}
		const h = harness({
			candidate: store.getSession("exec-1")!,
			liveness: "unknown",
		});
		h.deps.store = store;
		h.deps.nowMs = () => 200000;
		h.deps.preflightRecovery = vi.fn(() => {
			throw new Error("snapshot missing");
		});
		h.onRecoveryExhausted.mockRejectedValueOnce(new Error("sink unavailable"));
		const reowner = new CodexSessionReowner(h.deps);
		await expect(reowner.runPass()).resolves.toBeDefined();
		await reowner.finalizeDueExhaustion("exec-1");
		expect(h.onRecoveryExhausted).toHaveBeenCalledTimes(2);
		expect(h.deps.probe).not.toHaveBeenCalled();
		expect(h.deps.preflightRecovery).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("exec-1")).toHaveLength(3);
	} finally {
		store.close();
	}
});

it.each([
	"stale_revision",
	"lease_expired",
	"activation_ambiguous",
	"claim_lost",
])("retains capabilities failure %s with context stage", async (reason) => {
	const h = harness();
	vi.mocked(h.deps.store.prepareCodexRecoveryCapabilities).mockReturnValue({
		ok: false,
		reason,
	} as never);
	await new CodexSessionReowner(h.deps).runPass();
	const failure = vi.mocked(h.deps.store.settleCodexRecoveryFailure).mock
		.calls[0]?.[4];
	expect(failure).toMatchObject({
		code: "owner_failed_unknown",
		stage: "context",
		summary: `recovery capabilities ${reason.replace(/_/g, " ")}`,
	});
	expect(h.revive).not.toHaveBeenCalled();
});
it.each(["refused", "indeterminate"] as const)(
	"retains recycle failure %s with teardown stage",
	async (reason) => {
		const h = harness({
			liveness: "alive",
			gateHeld: true,
			reapOutcome: reason,
		});
		await new CodexSessionReowner(h.deps).runPass();
		const failure = vi.mocked(h.deps.store.settleCodexRecoveryFailure).mock
			.calls[0]?.[4];
		expect(failure).toMatchObject({
			code: "owner_failed_unknown",
			stage: "teardown",
			summary: `recovery recycle ${reason}`,
		});
		expect(h.revive).not.toHaveBeenCalled();
	},
);

it("records a sanitized nonaccounting observation when precommit settlement loses its claim", async () => {
	const h = harness();
	h.revive.mockImplementation(async () => ({
		success: false,
		sessionId: "exec-1",
		durationMs: 1,
		timedOut: false,
		resultText: "owner failed token=private-secret",
	}));
	await new CodexSessionReowner(h.deps).runPass();
	await settle();
	expect(h.deps.record).toHaveBeenCalledWith(
		"reown_revive_failed",
		h.candidate,
		expect.objectContaining({
			settlement: "claim_lost",
			accounting: false,
			stale: true,
			failure: expect.objectContaining({
				code: "owner_failed_unknown",
				summary: "owner failed [credential]",
			}),
			reservationSeq: 1,
		}),
	);
	const observations = vi
		.mocked(h.deps.record)
		.mock.calls.filter(([event]) => event === "reown_revive_failed");
	expect(observations).toHaveLength(1);
	expect(JSON.stringify(observations)).not.toContain("private-secret");
	expect(observations[0][2]).not.toHaveProperty("budgetDecision");
	expect(h.deps.store.settleCodexRecoveryFailure).toHaveBeenCalledTimes(1);
});

it("isolates a poisoned exhaustion candidate and records the failure before recovering later candidates", async () => {
	const h = harness({ liveness: "alive" });
	const later = session({ execution_id: "exec-later" });
	vi.mocked(h.deps.store.getReadoptCandidateSessions).mockReturnValue([
		h.candidate,
		later,
	]);
	vi.mocked(
		h.deps.store.finalizeCodexRecoveryExhaustion,
	).mockImplementationOnce(() => {
		throw new Error("recovery_exhaustion_alert_identity_missing");
	});
	await expect(
		new CodexSessionReowner(h.deps).runPass(),
	).resolves.toBeDefined();
	expect(h.deps.probe).toHaveBeenCalledWith(later.execution_id);
	expect(h.deps.record).toHaveBeenCalledWith(
		"reown_revive_failed",
		h.candidate,
		expect.objectContaining({
			accounting: false,
			phase: "candidate_inspection",
			failure: expect.objectContaining({ code: "owner_failed_unknown" }),
		}),
	);
	expect(h.deps.record).toHaveBeenCalledWith(
		"reown_watch_started",
		later,
		expect.anything(),
	);
});

it("records original owner failure outside a rolled-back settlement transaction", async () => {
	const h = harness();
	h.revive.mockImplementation(async () => ({
		success: false,
		sessionId: "exec-1",
		durationMs: 1,
		timedOut: false,
		resultText: "owner failed token=private-secret",
	}));
	vi.mocked(h.deps.store.settleCodexRecoveryFailure).mockImplementation(() => {
		throw new Error("workflow_alert_uid_conflict:private-uid");
	});
	await new CodexSessionReowner(h.deps).runPass();
	await settle();
	expect(h.deps.record).toHaveBeenCalledWith(
		"reown_revive_failed",
		h.candidate,
		expect.objectContaining({
			accounting: false,
			settlement: "write_failed",
			failure: expect.objectContaining({
				summary: "owner failed [credential]",
			}),
			settlementFailure: expect.objectContaining({
				summary: "recovery exhaustion alert UID conflict",
			}),
		}),
	);
	expect(JSON.stringify(vi.mocked(h.deps.record).mock.calls)).not.toMatch(
		/private-secret|private-uid/,
	);
});
