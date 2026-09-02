import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	CODEX_REOWN_ROLLOUT_STALE_MS,
	type CodexSessionReownDeps,
	CodexSessionReowner,
	isCodexReownExcluded,
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
		onRecoveryExhausted,
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("FLY-2211 Codex session re-owner", () => {
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
		vi.mocked(h.deps.nowMs)
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_000 + CODEX_REOWN_ROLLOUT_STALE_MS - 1)
			.mockReturnValueOnce(1_000 + CODEX_REOWN_ROLLOUT_STALE_MS)
			.mockReturnValueOnce(1_000 + CODEX_REOWN_ROLLOUT_STALE_MS + 5 * 60_000);
		const reowner = new CodexSessionReowner(h.deps);

		await reowner.runPass();
		await reowner.runPass();
		expect(h.events).not.toContain("reown_probe_unknown");

		await reowner.runPass();
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

		expect(h.order).toEqual(["claim", "reap", "abort"]);
		expect(h.revive).not.toHaveBeenCalled();
		expect(h.events).toContain("reown_revive_failed");
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

		expect(h.order).toEqual(["claim", "revive", "commit", "abort"]);
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
