import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isPostApproveShipComplete,
	runPostShipFinalization,
	setWorkflowShadowFinalizationHook,
} from "../bridge/post-ship-finalization.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// ── Mocks ────────────────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxSession = vi.fn();

const mockKillCmuxLinkedSession = vi.fn(async () => ({ killed: true }));

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxSession(...args),
	killCmuxLinkedSession: (...args: unknown[]) =>
		mockKillCmuxLinkedSession(...args),
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
}));

// Capture ordering of Discord-side calls via a shared spy list.
const callOrder: string[] = [];

let fetchImpl: ReturnType<typeof vi.fn>;

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

// ── Orchestrator ordering + dual-path tests ──────────────────

describe("runPostShipFinalization", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		seedSession(store);
		seedThread(store);
		callOrder.length = 0;
		mockGetTmuxTarget.mockReset();
		mockKillTmuxSession.mockReset();
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
				} else if (method === "PATCH") {
					callOrder.push("discord:archive");
				} else if (method === "DELETE") {
					callOrder.push("discord:remove-user");
				}
				return new Response("{}", { status: 200 });
			});
		vi.stubGlobal("fetch", fetchImpl);
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

	it("FLY-1232 T9: the central late-bound hook fires for a claim winner whose deps did NOT thread workflowShadow (Codex R1 #5)", async () => {
		// event-route.ts / merge-ship-gate.ts are in-process claim contenders that
		// build PostShipDeps without the workflowShadow field — if one of them wins
		// the atomic claim, T9 must still run.
		const onShipFinalized = vi.fn();
		setWorkflowShadowFinalizationHook({ onShipFinalized });
		try {
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
				{ store, projects: PROJECTS }, // no workflowShadow dep
			);
		} finally {
			setWorkflowShadowFinalizationHook(undefined);
		}
		expect(onShipFinalized).toHaveBeenCalledTimes(1);
		expect(onShipFinalized).toHaveBeenCalledWith({
			projectName: "flywheel",
			issueId: "FLY-102",
		});
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
			} else if (method === "DELETE") {
				callOrder.push("discord:remove-user");
			}
			return new Response("{}", { status: 200 });
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
			return new Response("{}", { status: 200 });
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
		expect(markIssueDone).toHaveBeenCalledWith("FLY-102", "FLY-102");
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
});
