import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isPostApproveShipComplete,
	runPostShipFinalization,
} from "../bridge/post-ship-finalization.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// ── Mocks ────────────────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxSession = vi.fn();

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxSession(...args),
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
	it("returns true when existingStatus === 'approved_to_ship'", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: undefined,
				landingStatus: undefined,
			}),
		).toBe(true);
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

	it("returns false for route=needs_review", () => {
		expect(
			isPostApproveShipComplete({
				existingStatus: "running",
				route: "needs_review",
				landingStatus: undefined,
			}),
		).toBe(false);
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
});
