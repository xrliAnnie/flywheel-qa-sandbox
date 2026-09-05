import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isPostApproveShipComplete,
	runPostShipFinalization,
	runResumablePostShipFinalization,
	settleShipAttemptFailed,
} from "../bridge/post-ship-finalization.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// ── Mocks ────────────────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxSession = vi.fn();
const mockHasHostProcessByExecutionId = vi.fn();
const mockProbeRunExecutionLiveness = vi.fn();
const mockHasEndedCommDbSession = vi.fn();

const mockKillCmuxLinkedSession = vi.fn(async () => ({ killed: true }));

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	lookupTmuxTarget: () => ({ kind: "gone" as const }),
	probeRunnerProcessLiveness: () => Promise.resolve("absent" as const),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxSession(...args),
	killCmuxLinkedSession: (...args: unknown[]) =>
		mockKillCmuxLinkedSession(...args),
}));

vi.mock("../bridge/generalized-launch-recovery.js", () => ({
	hasHostProcessByExecutionId: (...args: unknown[]) =>
		mockHasHostProcessByExecutionId(...args),
}));

vi.mock("../bridge/run-quiescence.js", () => ({
	probeRunExecutionLiveness: (...args: unknown[]) =>
		mockProbeRunExecutionLiveness(...args),
}));

// FLY-1238: stub the atomic CommDB finalizer.
const mockFinalizeCommDbSession = vi.fn(() => ({
	ok: true as const,
	outcome: "finalized" as const,
	retiredGateCount: 1,
	deletedSessionCount: 1,
}));
vi.mock("../bridge/commdb-session-prune.js", () => ({
	finalizeCommDbSession: (...args: unknown[]) =>
		mockFinalizeCommDbSession(...args),
	hasEndedCommDbSession: (...args: unknown[]) =>
		mockHasEndedCommDbSession(...args),
	resolveCommDbPath: () => undefined,
}));

// Capture ordering of Discord-side calls via a shared spy list.
const callOrder: string[] = [];

let fetchImpl: ReturnType<typeof vi.fn>;
let discordArchived = false;
let discordFrontierId = "";

const PROJECTS: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "lead-a",
				chatChannel: "chan-1",
				botToken: "bot-token",
				match: { labels: [] },
			},
		],
	},
];

function seedSession(store: StateStore, status = "completed"): void {
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-102",
		project_name: "flywheel",
		status,
	});
}

function seedThread(store: StateStore): void {
	store.upsertChatThread("thread-1", "chan-1", "FLY-102");
}

function snowflakeAt(ms: number): string {
	return ((BigInt(ms) - 1420070400000n) << 22n).toString();
}

function seedCompletedFinalization(store: StateStore): void {
	store.insertEvent({
		event_id: "post-ship-finalization-exec-1",
		execution_id: "exec-1",
		issue_id: "FLY-102",
		project_name: "flywheel",
		event_type: "post_ship_finalization_claim",
		source: "test",
	});
	store.insertEvent({
		event_id: "post-ship-finalization-completed-exec-1",
		execution_id: "exec-1",
		issue_id: "FLY-102",
		project_name: "flywheel",
		event_type: "post_ship_finalization_completed",
		source: "test",
	});
}

function seedLandOperationClaim(store: StateStore) {
	// recordLandOperationStep compares the lease with the real clock, so this
	// fixture must stay relative to now instead of becoming a wall-clock fuse.
	const base = Date.now();
	const operation = store.ensureLandOperation({
		issueId: "FLY-102",
		projectName: "flywheel",
		prNumber: 1832,
		approvedHead: "a".repeat(40),
		now: new Date(base - 1_000).toISOString(),
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "land-worker",
		now: new Date(base).toISOString(),
		leaseExpiresAt: new Date(base + 60 * 60 * 1_000).toISOString(),
	});
	if (!claim) throw new Error("test land claim missing");
	return {
		operationId: operation.operation_id,
		ownerId: claim.ownerId,
		generation: claim.generation,
	};
}

async function flushMicrotasks(rounds = 4): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await Promise.resolve();
	}
}

// ── Predicate tests ──────────────────────────────────────────

describe("isPostApproveShipComplete", () => {
	it("returns true for approved_to_ship + merged landing (FLY-208 5a: merge evidence required)", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: undefined,
				landingStatus: { status: "merged" },
			}),
		).toBe(true);
	});

	it("returns FALSE for approved_to_ship WITHOUT merge evidence (FLY-208 5a evidence-gap suppression)", () => {
		// Pre-FLY-208 this returned true on existingStatus alone — which would
		// run tmux teardown / ready-to-close / thread archive for the
		// evidence-gap unstick path even though nothing proves the PR merged
		// (Codex design R2 #1). Cleanup for these is owned by FLY-210.
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: undefined,
				landingStatus: undefined,
			}),
		).toBe(false);
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: "needs_review",
				landingStatus: { status: "ready_to_merge" },
			}),
		).toBe(false);
	});

	it("returns true for auto_approve + merged", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "auto_approve",
				landingStatus: { status: "merged" },
			}),
		).toBe(true);
	});

	it("returns false for auto_approve + awaiting_review", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "auto_approve",
				landingStatus: { status: "awaiting_review" },
			}),
		).toBe(false);
	});

	it("returns false for route=needs_review (no landing status)", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "needs_review",
				landingStatus: undefined,
			}),
		).toBe(false);
	});

	it("returns false for route=needs_review + ready_to_merge (PR not yet merged)", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "needs_review",
				landingStatus: { status: "ready_to_merge" },
			}),
		).toBe(false);
	});

	// FLY-115 v1.24.5 (FLY-120): Lead unblocked approve_to_ship via
	// `flywheel-comm respond` so existingStatus never reached
	// `approved_to_ship`. Without this case the Runner tmux + chat thread
	// stay alive after the PR has merged.
	it("returns true for route=needs_review + landingStatus.merged (FLY-120 self-shipped path)", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "needs_review",
				landingStatus: { status: "merged" },
			}),
		).toBe(true);
	});

	it("returns false when existingStatus !== approved_to_ship AND not auto_approve+merged (Round 2 Issue #2)", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: undefined,
				landingStatus: undefined,
			}),
		).toBe(false);
	});
});

describe("settleShipAttemptFailed (FLY-1505 attempt-head authority)", () => {
	let store: StateStore;
	const HEAD_A = "a".repeat(40);
	const HEAD_B = "b".repeat(40);

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-ship-attempt",
			issue_id: "FLY-1505",
			project_name: "flywheel",
			status: "approved_to_ship",
		});
		store.setSessionParams("exec-ship-attempt", {
			unrelated: { survives: true },
		});
	});

	afterEach(() => store.close());

	it("marks a matching real head, normalizes it, and increments only the same-head attempt", () => {
		const first = settleShipAttemptFailed(store, "exec-ship-attempt", {
			attemptHeadSha: HEAD_A.toUpperCase(),
			currentHeadSha: HEAD_A,
			prNumber: 715,
			summary: "ship job still running",
		});
		expect(first).toEqual({
			outcome: "marked",
			firstAttemptForHead: true,
			attemptCount: 1,
		});

		const second = settleShipAttemptFailed(store, "exec-ship-attempt", {
			attemptHeadSha: HEAD_A,
			currentHeadSha: HEAD_A.toUpperCase(),
			prNumber: 715,
			summary: "repeat completion",
		});
		expect(second).toEqual({
			outcome: "marked",
			firstAttemptForHead: false,
			attemptCount: 2,
		});
		expect(store.getSessionParams("exec-ship-attempt")).toMatchObject({
			unrelated: { survives: true },
			fly1505_ship_attempt_failed: {
				pr_number: 715,
				head_sha: HEAD_A,
				summary: "repeat completion",
				attempt_count: 2,
			},
		});
	});

	it("treats a real event head that differs from the current approved head as stale with zero write", () => {
		const before = store.getSessionParams("exec-ship-attempt");
		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: HEAD_A,
				currentHeadSha: HEAD_B,
			}),
		).toEqual({ outcome: "stale_attempt" });
		expect(store.getSessionParams("exec-ship-attempt")).toEqual(before);
	});

	it("treats an attempt bound to an older approval as stale even when the head is unchanged", () => {
		const before = store.getSessionParams("exec-ship-attempt");
		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: HEAD_A,
				currentHeadSha: HEAD_A,
				reviewQuestionId: "approval-q1",
				currentReviewQuestionId: "approval-q2",
			}),
		).toEqual({ outcome: "stale_attempt" });
		expect(store.getSessionParams("exec-ship-attempt")).toEqual(before);
	});

	it("upgrades an unknown sentinel to the real head without double-alerting and never downgrades a real marker", () => {
		const firstUnknown = settleShipAttemptFailed(store, "exec-ship-attempt", {
			attemptHeadSha: null,
			currentHeadSha: HEAD_A,
		});
		expect(firstUnknown).toEqual({
			outcome: "unknown_head_marked",
			firstAttemptForHead: true,
			attemptCount: 1,
		});
		expect(store.getSessionParams("exec-ship-attempt")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: "(unknown)",
				attempt_count: 1,
			},
		});

		const repeatedUnknown = settleShipAttemptFailed(
			store,
			"exec-ship-attempt",
			{
				attemptHeadSha: "not-a-sha",
				currentHeadSha: HEAD_A,
			},
		);
		expect(repeatedUnknown).toEqual({
			outcome: "unknown_head_marked",
			firstAttemptForHead: false,
			attemptCount: 2,
		});

		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: HEAD_A,
				currentHeadSha: HEAD_A,
			}),
		).toEqual({
			outcome: "marked",
			firstAttemptForHead: false,
			attemptCount: 3,
		});
		const realMarker = store.getSessionParams("exec-ship-attempt");

		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: undefined,
				currentHeadSha: HEAD_A,
			}),
		).toEqual({ outcome: "unknown_head_skipped" });
		expect(store.getSessionParams("exec-ship-attempt")).toEqual(realMarker);
	});

	it("never lets unknown evidence from a newer binding overwrite a prior real-head marker", () => {
		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: HEAD_A,
				currentHeadSha: HEAD_A,
				reviewQuestionId: "approval-q1",
				currentReviewQuestionId: "approval-q1",
			}),
		).toMatchObject({ outcome: "marked" });
		const realMarker = store.getSessionParams("exec-ship-attempt");

		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: undefined,
				currentHeadSha: HEAD_A,
				reviewQuestionId: "approval-q2",
				currentReviewQuestionId: "approval-q2",
			}),
		).toEqual({ outcome: "unknown_head_skipped" });
		expect(store.getSessionParams("exec-ship-attempt")).toEqual(realMarker);
	});

	it("records and alerts a real attempt head when the legacy approved row has no current head authority", () => {
		expect(
			settleShipAttemptFailed(store, "exec-ship-attempt", {
				attemptHeadSha: HEAD_A,
				currentHeadSha: undefined,
				reviewQuestionId: "legacy-q",
			}),
		).toEqual({
			outcome: "marked",
			firstAttemptForHead: true,
			attemptCount: 1,
		});
		expect(store.getSessionParams("exec-ship-attempt")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: HEAD_A,
				review_question_id: "legacy-q",
			},
		});
	});
});

// ── Orchestrator ordering + dual-path tests ──────────────────

describe("runPostShipFinalization", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		seedSession(store);
		seedThread(store);
		callOrder.length = 0;
		discordArchived = false;
		discordFrontierId = snowflakeAt(Date.now() - 2 * 60 * 60_000);
		mockGetTmuxTarget.mockReset();
		mockKillTmuxSession.mockReset();
		mockHasHostProcessByExecutionId.mockReset();
		mockHasHostProcessByExecutionId.mockResolvedValue(true);
		mockProbeRunExecutionLiveness.mockReset();
		mockProbeRunExecutionLiveness.mockImplementation(async () =>
			(await mockHasHostProcessByExecutionId()) ? "alive" : "dead",
		);
		mockHasEndedCommDbSession.mockReset();
		mockHasEndedCommDbSession.mockReturnValue(true);
		mockFinalizeCommDbSession.mockReset();
		mockFinalizeCommDbSession.mockReturnValue({
			ok: true,
			outcome: "finalized",
			retiredGateCount: 1,
			deletedSessionCount: 1,
		});

		mockGetTmuxTarget.mockImplementation(() => {
			callOrder.push("tmux:lookup");
			return { tmuxWindow: "FLY-102:@0", sessionName: "FLY-102" };
		});
		mockKillTmuxSession.mockImplementation(async () => {
			callOrder.push("tmux:kill");
			return { killed: true };
		});

		fetchImpl = vi
			.fn()
			.mockImplementation(async (url: string, init: unknown) => {
				const method = (init as { method?: string }).method ?? "GET";
				if (method === "POST" && String(url).includes("/messages")) {
					callOrder.push("discord:post-message");
					return new Response(JSON.stringify({ id: "message-1" }), {
						status: 200,
					});
				}
				if (method === "PATCH") {
					callOrder.push("discord:archive");
					discordArchived = true;
					return new Response("{}", { status: 200 });
				}
				if (method === "DELETE") {
					callOrder.push("discord:remove-user");
					return new Response("{}", { status: 200 });
				}
				if (String(url).includes("/messages?")) {
					return new Response(JSON.stringify([{ id: discordFrontierId }]), {
						status: 200,
					});
				}
				return new Response(
					JSON.stringify({
						name: "thread",
						thread_metadata: { archived: discordArchived },
					}),
					{ status: 200 },
				);
			});
		vi.stubGlobal("fetch", fetchImpl);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("derives the land seed lease from the clock (FLY-1863)", async () => {
		const fakeBase = Date.now() + 400 * 24 * 60 * 60 * 1_000;
		vi.useFakeTimers({ toFake: ["Date"], now: fakeBase });
		try {
			let archived = false;
			const landOperation = seedLandOperationClaim(store);
			const operation = store.getLandOperation(landOperation.operationId);

			expect(operation?.created_at).toBe(
				new Date(fakeBase - 1_000).toISOString(),
			);
			expect(operation?.updated_at).toBe(new Date(fakeBase).toISOString());
			expect(operation?.lease_expires_at).toBe(
				new Date(fakeBase + 60 * 60 * 1_000).toISOString(),
			);

			const result = await runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					issueIdentifier: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
					landOperation,
				},
				{
					store,
					projects: PROJECTS,
					removeCleanWorktree: vi.fn().mockResolvedValue({
						removed: true,
						bindingVerified: true,
					}),
					markIssueDone: vi.fn().mockResolvedValue({ done: true }),
					recordLinearDoneDisposition: vi.fn().mockReturnValue({
						ok: true,
						idempotentReplay: false,
					}),
					archiveFn: vi.fn().mockImplementation(async () => {
						archived = true;
						return {
							archived: true,
							attempts: 1,
							status: 200,
							reason: "ok" as const,
						};
					}),
					fetchImpl: vi.fn(async (url: string, init: RequestInit) => {
						if (init.method === "POST") {
							return new Response(JSON.stringify({ id: "message-1" }), {
								status: 200,
							});
						}
						if (url.includes("/messages?")) {
							return new Response(
								JSON.stringify([
									{ id: snowflakeAt(fakeBase - 2 * 60 * 60_000) },
								]),
								{ status: 200 },
							);
						}
						return new Response(
							JSON.stringify({
								name: "thread",
								thread_metadata: { archived },
							}),
							{ status: 200 },
						);
					}) as unknown as typeof fetch,
				},
			);

			expect(result).toMatchObject({
				complete: true,
				outcome: "completed",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs tmux → notifier → archive in strict order (archive not before notifier)", async () => {
		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "user-annie",
				fallbackBotToken: undefined,
			},
			{ store, projects: PROJECTS },
		);

		// Expect tmux operations come first, then notifier post, then archive ops.
		const postIdx = callOrder.indexOf("discord:post-message");
		const archiveIdx = callOrder.indexOf("discord:archive");
		const removeIdx = callOrder.indexOf("discord:remove-user");
		const killIdx = callOrder.indexOf("tmux:kill");

		expect(killIdx).toBeGreaterThanOrEqual(0);
		expect(postIdx).toBeGreaterThan(killIdx);
		expect(archiveIdx).toBeGreaterThan(postIdx);
		expect(removeIdx).toBeGreaterThan(postIdx);
	});

	it("FLY-1238: skips archive when post-merge communication finalization fails", async () => {
		mockFinalizeCommDbSession.mockReturnValue({
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			deletedSessionCount: 0,
			error: "sqlite busy",
		} as never);

		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "user-annie",
				fallbackBotToken: undefined,
			},
			{ store, projects: PROJECTS },
		);

		expect(callOrder).toContain("discord:post-message");
		expect(callOrder).not.toContain("discord:archive");
		expect(callOrder).not.toContain("discord:remove-user");
	});

	it("FLY-2313: a dead terminal pending target reaches archive and Linear Done", async () => {
		mockGetTmuxTarget.mockImplementation(() => {
			callOrder.push("tmux:lookup");
			return {
				tmuxWindow: "runner-flywheel:pending",
				sessionName: "runner-flywheel",
			};
		});
		mockKillTmuxSession.mockImplementation(async () => {
			callOrder.push("tmux:kill");
			return {
				killed: false,
				error: "tmux window identity is still pending",
			};
		});
		mockHasEndedCommDbSession.mockReturnValue(true);
		mockHasHostProcessByExecutionId.mockResolvedValue(false);
		const landOperation = seedLandOperationClaim(store);
		const archiveFn = vi.fn().mockImplementation(async () => {
			discordArchived = true;
			return {
				archived: true,
				attempts: 1,
				status: 200,
				reason: "ok" as const,
			};
		});
		const markIssueDone = vi.fn().mockResolvedValue({ done: true });

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				issueCloseout: vi.fn().mockResolvedValue({ outcome: "completed" }),
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone,
				recordLinearDoneDisposition: vi.fn().mockReturnValue({
					ok: true,
					idempotentReplay: false,
				}),
				archiveFn,
				fetchImpl,
			},
		);

		expect(result).toMatchObject({ complete: true, outcome: "completed" });
		expect(mockFinalizeCommDbSession).toHaveBeenCalledWith(
			"exec-1",
			"flywheel",
		);
		expect(archiveFn).toHaveBeenCalledOnce();
		expect(markIssueDone).toHaveBeenCalledOnce();
	});

	it("dual-path Promise.all: Discord post-message hit exactly once", async () => {
		const opts = {
			executionId: "exec-1",
			issueId: "FLY-102",
			issueIdentifier: "FLY-102",
			projectName: "flywheel",
			sessionStatus: "completed",
			discordOwnerUserId: "user-annie",
			fallbackBotToken: undefined,
		};

		await Promise.all([
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
		]);

		const postCalls = callOrder.filter((s) => s === "discord:post-message");
		expect(postCalls).toHaveLength(1);

		const notified = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "runner_ready_to_close_notified");
		expect(notified).toHaveLength(1);
	});

	it("dual-path: archive + remove-user each happen exactly once (orchestrator claim)", async () => {
		const opts = {
			executionId: "exec-1",
			issueId: "FLY-102",
			issueIdentifier: "FLY-102",
			projectName: "flywheel",
			sessionStatus: "completed",
			discordOwnerUserId: "user-annie",
			fallbackBotToken: undefined,
		};

		await Promise.all([
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
		]);

		expect(callOrder.filter((s) => s === "discord:archive")).toHaveLength(1);
		expect(callOrder.filter((s) => s === "discord:remove-user")).toHaveLength(
			1,
		);
		expect(callOrder.filter((s) => s === "tmux:kill")).toHaveLength(1);

		const claims = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "post_ship_finalization_claim");
		expect(claims).toHaveLength(1);
	});

	it("loser is a no-op: second sequential call writes no further side effects", async () => {
		const opts = {
			executionId: "exec-1",
			issueId: "FLY-102",
			issueIdentifier: "FLY-102",
			projectName: "flywheel",
			sessionStatus: "completed",
			discordOwnerUserId: "user-annie",
			fallbackBotToken: undefined,
		};

		await runPostShipFinalization(opts, { store, projects: PROJECTS });
		const beforeRetry = callOrder.length;

		await runPostShipFinalization(opts, { store, projects: PROJECTS });
		expect(callOrder.length).toBe(beforeRetry);
	});

	it("loser archive never races winner's still-in-flight notifier POST", async () => {
		// Delay the first POST /messages by 50ms so a naïve implementation
		// would run the loser's archive/remove-user before the winner's
		// notifier completes. Orchestrator claim prevents that.
		let postStarted = false;
		fetchImpl.mockImplementation(async (url: string, init: unknown) => {
			const method = (init as { method?: string }).method ?? "GET";
			if (method === "POST" && String(url).includes("/messages")) {
				if (!postStarted) {
					postStarted = true;
					callOrder.push("discord:post-message:start");
					await new Promise((r) => setTimeout(r, 50));
					callOrder.push("discord:post-message:end");
				} else {
					callOrder.push("discord:post-message");
				}
			} else if (method === "PATCH") {
				callOrder.push("discord:archive");
				discordArchived = true;
			} else if (method === "DELETE") {
				callOrder.push("discord:remove-user");
			}
			if (String(url).includes("/messages?")) {
				return new Response(JSON.stringify([{ id: discordFrontierId }]), {
					status: 200,
				});
			}
			return new Response(
				JSON.stringify({
					id: "message-1",
					name: "thread",
					thread_metadata: { archived: discordArchived },
				}),
				{ status: 200 },
			);
		});

		const opts = {
			executionId: "exec-1",
			issueId: "FLY-102",
			issueIdentifier: "FLY-102",
			projectName: "flywheel",
			sessionStatus: "completed",
			discordOwnerUserId: "user-annie",
			fallbackBotToken: undefined,
		};

		await Promise.all([
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
		]);

		const startIdx = callOrder.indexOf("discord:post-message:start");
		const endIdx = callOrder.indexOf("discord:post-message:end");
		const archiveIdx = callOrder.indexOf("discord:archive");
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(startIdx);
		// Archive MUST land after POST completes (or not at all if loser).
		expect(archiveIdx).toBeGreaterThan(endIdx);
		// And exactly one archive.
		expect(callOrder.filter((s) => s === "discord:archive")).toHaveLength(1);
	});

	it("FLY-108 Variant B: running → completed path still fires exactly-once", async () => {
		// Seed a session whose pre-FSM state was `running` (Variant B — docs-only
		// compressed pipeline). After `running → completed` FSM transition,
		// event-route calls runPostShipFinalization with sessionStatus="completed".
		// Orchestrator claim must still dedupe across retries regardless of how
		// we got here (no pre-existing `approved_to_ship` history needed).
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-108",
			project_name: "flywheel",
			status: "completed", // post-transition value event-route passes in
		});
		store.upsertChatThread("thread-1", "chan-1", "FLY-108");

		const opts = {
			executionId: "exec-1",
			issueId: "FLY-108",
			issueIdentifier: "FLY-108",
			projectName: "flywheel",
			sessionStatus: "completed",
			discordOwnerUserId: "user-annie",
			fallbackBotToken: undefined,
		};

		await Promise.all([
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
			runPostShipFinalization(opts, { store, projects: PROJECTS }),
		]);

		expect(callOrder.filter((s) => s === "discord:archive")).toHaveLength(1);
		expect(callOrder.filter((s) => s === "discord:remove-user")).toHaveLength(
			1,
		);
		expect(callOrder.filter((s) => s === "tmux:kill")).toHaveLength(1);
		expect(callOrder.filter((s) => s === "discord:post-message")).toHaveLength(
			1,
		);

		const claims = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "post_ship_finalization_claim");
		expect(claims).toHaveLength(1);
	});

	it("FLY-292: writes a chat_thread_archived audit event on success", async () => {
		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "user-annie",
				fallbackBotToken: undefined,
			},
			{ store, projects: PROJECTS },
		);

		const archived = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "chat_thread_archived");
		expect(archived).toHaveLength(1);

		const failed = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "chat_thread_archive_failed");
		expect(failed).toHaveLength(0);

		// FLY-369: a ship-path archive marks archived_at (archive-once record).
		expect(
			store.getChatThreadByIssue("FLY-102", "chan-1")?.archived_at,
		).toBeTruthy();
	});

	it("FLY-292: marks thread missing + audits failure when Discord 404s the thread", async () => {
		// PATCH (archive) → 404; everything else → 200.
		fetchImpl.mockImplementation(async (url: string, init: unknown) => {
			const method = (init as { method?: string }).method ?? "GET";
			if (method === "POST" && String(url).includes("/messages")) {
				return new Response("{}", { status: 200 });
			}
			if (method === "PATCH") {
				return new Response('{"message":"Unknown Channel"}', { status: 404 });
			}
			if (String(url).includes("/messages?")) {
				return new Response(
					JSON.stringify([{ id: snowflakeAt(Date.now() - 2 * 60 * 60_000) }]),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					name: "thread",
					thread_metadata: { archived: false },
				}),
				{ status: 200 },
			);
		});

		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "user-annie",
				fallbackBotToken: undefined,
			},
			{ store, projects: PROJECTS },
		);

		const failed = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "chat_thread_archive_failed");
		expect(failed).toHaveLength(1);

		// 404 → thread marked missing → no longer resolvable for this issue.
		expect(store.getChatThreadByIssue("FLY-102", "chan-1")).toBeUndefined();
	});

	it("never throws when postMergeTmuxCleanup errors", async () => {
		mockGetTmuxTarget.mockImplementationOnce(() => {
			throw new Error("CommDB corrupted");
		});

		await expect(
			runPostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{ store, projects: PROJECTS },
			),
		).resolves.toBeUndefined();
	});

	// FLY-799 (Codex R1 HIGH-1): auto-Linear-Done must never block teardown.
	it("markIssueDone is called with the issue id on a confirmed ship", async () => {
		const markIssueDone = vi.fn().mockResolvedValue(undefined);
		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{ store, projects: PROJECTS, markIssueDone },
		);
		expect(markIssueDone).toHaveBeenCalledWith(
			"FLY-102",
			"FLY-102",
			expect.any(AbortSignal),
		);
		// teardown still ran: the atomic claim event exists.
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((e) => e.event_id === "post-ship-finalization-exec-1"),
		).toBe(true);
	});

	it("a rejecting markIssueDone never breaks finalization (best-effort)", async () => {
		const markIssueDone = vi.fn().mockRejectedValue(new Error("linear down"));
		await expect(
			runPostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					issueIdentifier: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{ store, projects: PROJECTS, markIssueDone },
			),
		).resolves.toBeUndefined();
		expect(markIssueDone).toHaveBeenCalledOnce();
	});

	it("land replay resumes an existing claim and closes the issue before worktree deletion", async () => {
		const order: string[] = [];
		const issueCloseout = vi
			.fn()
			.mockImplementationOnce(async () => {
				order.push("closeout:partial");
				return { outcome: "blocked" };
			})
			.mockImplementationOnce(async () => {
				order.push("closeout:completed");
				return { outcome: "completed" };
			});
		const removeCleanWorktree = vi.fn().mockImplementation(async () => {
			order.push("worktree");
			return { removed: true, bindingVerified: true };
		});
		const markIssueDone = vi.fn().mockResolvedValue({ done: true });
		const recordLinearDoneDisposition = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});
		const opts = {
			executionId: "exec-1",
			issueId: "FLY-102",
			issueIdentifier: "FLY-102",
			projectName: "flywheel",
			sessionStatus: "completed",
		};

		expect(
			await runResumablePostShipFinalization(opts, {
				store,
				projects: PROJECTS,
				issueCloseout,
				removeCleanWorktree,
				markIssueDone,
				recordLinearDoneDisposition,
			}),
		).toMatchObject({ complete: false, outcome: "partial" });
		expect(removeCleanWorktree).not.toHaveBeenCalled();

		expect(
			await runResumablePostShipFinalization(opts, {
				store,
				projects: PROJECTS,
				issueCloseout,
				removeCleanWorktree,
				markIssueDone,
				recordLinearDoneDisposition,
			}),
		).toMatchObject({ complete: true, outcome: "completed" });
		expect(order).toEqual([
			"closeout:partial",
			"closeout:completed",
			"worktree",
		]);
	});

	it.each(["partial", "needs_operator"] as const)(
		"keeps a typed %s lifecycle diagnostic non-blocking",
		async (outcome) => {
			const removeCleanWorktree = vi.fn().mockResolvedValue({
				removed: true,
				bindingVerified: true,
			});
			const markIssueDone = vi.fn().mockResolvedValue({ done: true });
			const result = await runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					issueIdentifier: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{
					store,
					projects: PROJECTS,
					issueCloseout: vi.fn().mockResolvedValue({
						outcome,
						cause: "phase_shutdown_unacked",
					}),
					removeCleanWorktree,
					markIssueDone,
					recordLinearDoneDisposition: vi.fn().mockReturnValue({
						ok: true,
						idempotentReplay: false,
					}),
				},
			);

			expect(result).toMatchObject({ complete: true, outcome: "completed" });
			expect(removeCleanWorktree).toHaveBeenCalledOnce();
			expect(markIssueDone).toHaveBeenCalledOnce();
		},
	);

	it.each(["blocked", "conflict"] as const)(
		"prefers the typed %s lifecycle cause over a generic conflict",
		async (outcome) => {
			const removeCleanWorktree = vi.fn();
			const markIssueDone = vi.fn();
			const result = await runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{
					store,
					projects: PROJECTS,
					issueCloseout: vi.fn().mockResolvedValue({
						outcome,
						cause: "phase_shutdown_unacked",
					}),
					removeCleanWorktree,
					markIssueDone,
				},
			);

			expect(result).toMatchObject({
				complete: false,
				outcome: "partial",
				reason: "issue_closeout_incomplete:cause=phase_shutdown_unacked",
				cause: { token: "phase_shutdown_unacked" },
			});
			expect(removeCleanWorktree).not.toHaveBeenCalled();
			expect(markIssueDone).not.toHaveBeenCalled();
		},
	);

	it("runs shipped-husk escalation before cleanup and preserves its bounded cause", async () => {
		const landOperation = seedLandOperationClaim(store);
		const forceHusks = vi.fn(async () => {
			callOrder.push("husk:force");
			return {
				cleared: [],
				cause: "node_process_residual" as const,
				affectedExecutionIds: ["implement-1"],
			};
		});

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				forceShippedHusks: forceHusks,
				issueCloseout: vi.fn().mockResolvedValue({ outcome: "completed" }),
			},
		);

		expect(forceHusks).toHaveBeenCalledOnce();
		expect(callOrder.indexOf("husk:force")).toBeLessThan(
			callOrder.indexOf("tmux:lookup"),
		);
		expect(result).toMatchObject({
			complete: false,
			outcome: "partial",
			reason: "issue_closeout_incomplete:cause=node_process_residual",
			cause: {
				token: "node_process_residual",
				executionIds: ["implement-1"],
			},
		});
	});

	it("does not invent a husk failure when optional escalation bookkeeping throws", async () => {
		const landOperation = seedLandOperationClaim(store);
		const archiveFn = vi.fn();
		const markIssueDone = vi.fn();
		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				forceShippedHusks: vi.fn().mockRejectedValue(new Error("ps failed")),
				issueCloseout: vi.fn().mockResolvedValue({ outcome: "completed" }),
				archiveFn,
				markIssueDone,
			},
		);

		expect(result).not.toMatchObject({
			reason: "issue_closeout_incomplete:cause=node_process_unverifiable",
		});
	});

	it("does not send the terminal message, archive, or mark Linear Done until worktree cleanup succeeds", async () => {
		const landOperation = seedLandOperationClaim(store);
		const archiveFn = vi.fn();
		const markIssueDone = vi.fn().mockResolvedValue({ done: true });
		const fetchForThread = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "ready-message" }), { status: 200 }),
		);

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue(undefined),
				markIssueDone,
				recordLinearDoneDisposition: vi.fn().mockReturnValue({
					ok: true,
					idempotentReplay: false,
				}),
				archiveFn,
				fetchImpl: fetchForThread as unknown as typeof fetch,
			},
		);

		expect(result).toMatchObject({
			complete: false,
			outcome: "partial",
			reason: "issue_closeout_incomplete:cause=worktree_branch_mismatch",
			cause: { token: "worktree_branch_mismatch" },
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(markIssueDone).not.toHaveBeenCalled();
		expect(
			store
				.listLandOperationSteps(landOperation.operationId)
				.some((step) => step.step === "terminal_notified"),
		).toBe(false);
	});

	it("settles a terminal receipt before archive and leaves archive as the final thread write", async () => {
		const landOperation = seedLandOperationClaim(store);
		const order: string[] = [];
		const postedBodies: string[] = [];
		let archived = false;
		const frontier = snowflakeAt(Date.now() - 2 * 60 * 60_000);
		const fetchForThread = vi.fn(async (url: string, init: RequestInit) => {
			if (init.method === "POST") {
				const body = JSON.parse(init.body as string) as { content: string };
				postedBodies.push(body.content);
				order.push(
					body.content.includes("已合入 PR #1832")
						? "terminal"
						: "ready-to-close",
				);
				return new Response(JSON.stringify({ id: `message-${order.length}` }), {
					status: 200,
				});
			}
			if (url.includes("/messages?")) {
				return new Response(JSON.stringify([{ id: frontier }]), {
					status: 200,
				});
			}
			return new Response(
				JSON.stringify({
					name: "thread",
					thread_metadata: { archived },
				}),
				{ status: 200 },
			);
		});
		const archiveFn = vi.fn(async () => {
			order.push("archive");
			archived = true;
			return {
				archived: true,
				attempts: 1,
				status: 200,
				reason: "ok" as const,
			};
		});
		const markIssueDone = vi.fn(async () => {
			order.push("linear-done");
			return { done: true };
		});

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone,
				recordLinearDoneDisposition: vi.fn().mockReturnValue({
					ok: true,
					idempotentReplay: false,
				}),
				archiveFn,
				fetchImpl: fetchForThread as unknown as typeof fetch,
			},
		);

		expect(result).toMatchObject({ complete: true, outcome: "completed" });
		expect(order).toEqual([
			"ready-to-close",
			"terminal",
			"archive",
			"linear-done",
		]);
		expect(postedBodies.some((body) => body.includes("清理完成"))).toBe(true);
		expect(
			store
				.listLandOperationSteps(landOperation.operationId)
				.filter((step) => step.step === "terminal_notified"),
		).toHaveLength(1);
	});

	it("keeps the thread open and Linear untouched when the terminal message fails", async () => {
		const landOperation = seedLandOperationClaim(store);
		const archiveFn = vi.fn();
		const markIssueDone = vi.fn().mockResolvedValue({ done: true });
		let posts = 0;
		const fetchForThread = vi.fn(async () => {
			posts += 1;
			return posts === 1
				? new Response(JSON.stringify({ id: "ready-message" }), { status: 200 })
				: new Response("refused", { status: 403 });
		});

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
				landOperation,
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone,
				recordLinearDoneDisposition: vi.fn().mockReturnValue({
					ok: true,
					idempotentReplay: false,
				}),
				archiveFn,
				fetchImpl: fetchForThread as unknown as typeof fetch,
			},
		);

		expect(result).toMatchObject({
			complete: false,
			outcome: "partial",
			reason: "land_terminal_notification_incomplete",
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(markIssueDone).not.toHaveBeenCalled();
	});

	it.each(["accepted", "deduped"] as const)(
		"settles a quiet-window deferral only after targeted enqueue is %s",
		async (admission) => {
			const landOperation = seedLandOperationClaim(store);
			const enqueueTerminalArchive = vi.fn(() => admission);
			const fetchForThread = vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					return new Response(JSON.stringify({ id: "message" }), {
						status: 200,
					});
				}
				if (String(url).includes("/messages?")) {
					return new Response(
						JSON.stringify([{ id: snowflakeAt(Date.now()) }]),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						name: "thread",
						thread_metadata: { archived: false },
					}),
					{ status: 200 },
				);
			});

			const result = await runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					issueIdentifier: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
					landOperation,
				},
				{
					store,
					projects: PROJECTS,
					removeCleanWorktree: vi.fn().mockResolvedValue({
						removed: true,
						bindingVerified: true,
					}),
					markIssueDone: vi.fn().mockResolvedValue({ done: true }),
					recordLinearDoneDisposition: vi.fn().mockReturnValue({
						ok: true,
						idempotentReplay: false,
					}),
					enqueueTerminalArchive,
					fetchImpl: fetchForThread as unknown as typeof fetch,
				},
			);

			expect(result).toMatchObject({ complete: true, outcome: "completed" });
			expect(enqueueTerminalArchive).toHaveBeenCalledOnce();
			expect(enqueueTerminalArchive).toHaveBeenCalledWith("FLY-102");
		},
	);

	it.each([
		["refused", vi.fn(() => "refused" as const)],
		["missing", undefined],
	] as const)(
		"keeps land partial when a quiet-window deferral is %s from the targeted queue",
		async (_case, enqueueTerminalArchive) => {
			const landOperation = seedLandOperationClaim(store);
			const fetchForThread = vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					return new Response(JSON.stringify({ id: "message" }), {
						status: 200,
					});
				}
				if (String(url).includes("/messages?")) {
					return new Response(
						JSON.stringify([{ id: snowflakeAt(Date.now()) }]),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						name: "thread",
						thread_metadata: { archived: false },
					}),
					{ status: 200 },
				);
			});

			const result = await runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					issueIdentifier: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
					landOperation,
				},
				{
					store,
					projects: PROJECTS,
					removeCleanWorktree: vi.fn().mockResolvedValue({
						removed: true,
						bindingVerified: true,
					}),
					markIssueDone: vi.fn().mockResolvedValue({ done: true }),
					recordLinearDoneDisposition: vi.fn().mockReturnValue({
						ok: true,
						idempotentReplay: false,
					}),
					enqueueTerminalArchive,
					fetchImpl: fetchForThread as unknown as typeof fetch,
				},
			);

			expect(result).toMatchObject({
				complete: false,
				outcome: "partial",
				reason: "land_archive_deferred_unqueued",
				details: { threadArchived: false },
			});
		},
	);

	it("maps a thrown pre-arbitration read to retryable partial for resumable land", async () => {
		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				preArbitrate: vi.fn().mockRejectedValue(new Error("linear timeout")),
			},
		);

		expect(result).toMatchObject({
			complete: false,
			outcome: "partial",
			reason: "arbitration_failed:linear timeout",
		});
		expect(mockKillTmuxSession).not.toHaveBeenCalled();
	});

	it("keeps retryable and degraded arbitration byte-compatible for legacy callers", async () => {
		await runPostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				preArbitrate: vi.fn().mockResolvedValue({
					ok: true,
					degraded: "linear_unreachable",
				}),
			},
		);

		expect(mockKillTmuxSession).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_type === "post_ship_finalization_claim"),
		).toBe(false);
	});

	it("audits degraded arbitration and continues local cleanup for resumable land", async () => {
		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				preArbitrate: vi.fn().mockResolvedValue({
					ok: true,
					degraded: "linear_unreachable",
				}),
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone: vi.fn().mockResolvedValue({ done: true }),
				recordLinearDoneDisposition: vi.fn().mockReturnValue({
					ok: true,
					idempotentReplay: false,
				}),
			},
		);

		expect(result).toMatchObject({ complete: true, outcome: "completed" });
		expect(mockKillTmuxSession).toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter(
					(event) => event.event_type === "post_ship_arbitration_degraded",
				),
		).toHaveLength(1);
	});

	it("completes local cleanup and defers Linear Done when Linear stays unreachable", async () => {
		const recordLinearDoneDisposition = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});
		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone: vi.fn().mockResolvedValue({
					done: false,
					reason: "linear offline",
				}),
				recordLinearDoneDisposition,
			},
		);

		expect(result).toMatchObject({
			complete: true,
			outcome: "completed",
			details: {
				worktreeRemoved: true,
				threadArchived: true,
				issueDone: false,
				linearDoneDisposition: "deferred",
			},
		});
		expect(recordLinearDoneDisposition).toHaveBeenCalledWith({
			disposition: "deferred",
			reason: "linear offline",
		});
	});

	it("normalizes an oversized Linear failure before recording deferred disposition", async () => {
		const oversizedReason = `linear_api_failed:${"x".repeat(600)}`;
		const recordLinearDoneDisposition = vi
			.fn()
			.mockImplementation((input: { disposition: string; reason: string }) =>
				input.reason.length <= 500
					? { ok: true, idempotentReplay: false }
					: { ok: false, reason: "invalid_land_linear_done_disposition" },
			);

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				markIssueDone: vi.fn().mockResolvedValue({
					done: false,
					reason: oversizedReason,
				}),
				recordLinearDoneDisposition,
			},
		);

		expect(result).toMatchObject({
			complete: true,
			outcome: "completed",
			details: { linearDoneDisposition: "deferred" },
		});
		expect(recordLinearDoneDisposition).toHaveBeenCalledWith({
			disposition: "deferred",
			reason: oversizedReason.slice(0, 200),
		});
	});

	it("reconciles Linear disposition before replaying an already-completed finalization", async () => {
		seedCompletedFinalization(store);
		const markIssueDone = vi.fn().mockResolvedValue({
			done: true,
			reason: "already_completed",
		});
		const recordLinearDoneDisposition = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				issueIdentifier: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				markIssueDone,
				recordLinearDoneDisposition,
			},
		);

		expect(result).toMatchObject({ complete: true, outcome: "completed" });
		expect(markIssueDone).toHaveBeenCalledOnce();
		expect(recordLinearDoneDisposition).toHaveBeenCalledWith({
			disposition: "done",
			reason: "already_completed",
		});
	});

	it("bounds a never-settling resumable Linear finalizer and releases the lifecycle mutex", async () => {
		vi.useFakeTimers();
		try {
			seedCompletedFinalization(store);
			let capturedSignal: AbortSignal | undefined;
			let mutexReleased = false;
			const markIssueDone = vi.fn(
				async (
					_issueId: string,
					_identifier?: string,
					signal?: AbortSignal,
				) => {
					capturedSignal = signal;
					return new Promise<{ done: boolean }>(() => undefined);
				},
			);
			const recordLinearDoneDisposition = vi.fn().mockReturnValue({
				ok: true,
				idempotentReplay: false,
			});
			const finalization = runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{
					store,
					projects: PROJECTS,
					withIssueLifecycleMutex: async (_issueId, fn) => {
						try {
							return await fn();
						} finally {
							mutexReleased = true;
						}
					},
					markIssueDone,
					recordLinearDoneDisposition,
				},
			);
			await flushMicrotasks();
			expect(markIssueDone).toHaveBeenCalledOnce();
			expect(mutexReleased).toBe(false);

			await vi.advanceTimersByTimeAsync(15_000);
			expect(await finalization).toMatchObject({
				complete: true,
				outcome: "completed",
				details: { linearDoneDisposition: "deferred" },
			});
			expect(capturedSignal?.aborted).toBe(true);
			expect(mutexReleased).toBe(true);
			expect(recordLinearDoneDisposition).toHaveBeenCalledWith({
				disposition: "deferred",
				reason: "mark_issue_done_timeout",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("prevents a late resumable Linear mutation after timeout and a subsequent founder park", async () => {
		vi.useFakeTimers();
		try {
			seedCompletedFinalization(store);
			let releaseRead!: () => void;
			const delayedRead = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			let founderParked = false;
			const updateIssue = vi.fn(() => {
				if (founderParked) throw new Error("late write after founder park");
			});
			const markIssueDone = vi.fn(
				async (
					_issueId: string,
					_identifier?: string,
					signal?: AbortSignal,
				) => {
					await delayedRead;
					if (signal?.aborted) {
						return { done: false, reason: "linear_done_aborted" };
					}
					updateIssue();
					return { done: true };
				},
			);
			const finalization = runResumablePostShipFinalization(
				{
					executionId: "exec-1",
					issueId: "FLY-102",
					projectName: "flywheel",
					sessionStatus: "completed",
				},
				{
					store,
					projects: PROJECTS,
					markIssueDone,
					recordLinearDoneDisposition: vi.fn().mockReturnValue({
						ok: true,
						idempotentReplay: false,
					}),
				},
			);
			await flushMicrotasks();
			await vi.advanceTimersByTimeAsync(15_000);
			await finalization;

			founderParked = true;
			releaseRead();
			await flushMicrotasks();
			expect(updateIssue).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles Linear as operator-refused when the optional finalizer is unavailable", async () => {
		const recordLinearDoneDisposition = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});

		const result = await runResumablePostShipFinalization(
			{
				executionId: "exec-1",
				issueId: "FLY-102",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: PROJECTS,
				removeCleanWorktree: vi.fn().mockResolvedValue({
					removed: true,
					bindingVerified: true,
				}),
				recordLinearDoneDisposition,
			},
		);

		expect(result).toMatchObject({
			complete: true,
			outcome: "completed",
			details: { linearDoneDisposition: "canceled_refused" },
		});
		expect(recordLinearDoneDisposition).toHaveBeenCalledWith({
			disposition: "canceled_refused",
			reason: "linear_finalizer_unavailable",
		});
	});
});
