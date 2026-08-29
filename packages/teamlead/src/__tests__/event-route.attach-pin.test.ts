/**
 * FLY-560 Feature C: event-route wires the pinned `tmux attach` rescue command
 * on stage_changed, independently from the Feature A emoji stamp. These tests
 * assert all four flag combinations (emoji × attach) gate cleanly, plus the
 * resolved command passed to ChatThreadCreator.ensureRunnerAttachPin.
 *
 * The CommDB tmux-target read is mocked so no real comm.db is needed; the real
 * buildAttachCommand renders the command we assert on.
 */
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../bridge/tmux-lookup.js")>();
	return {
		...actual,
		getTmuxTargetFromCommDb: vi.fn(() => ({
			tmuxWindow: "runner-flywheel:@46",
			sessionName: "runner-flywheel",
		})),
		resolveCmuxAttachTarget: vi.fn(async () => ({
			kind: "cmux" as const,
			session: "cmux-FLY-560-claude-x",
		})),
		// buildAttachCommand: real (from actual) — renders the asserted command.
	};
});

import type { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import { createEventRouter } from "../bridge/event-route.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const PROJECT = "fly560c-test";
const EXEC_ID = "exec-fly560c-1";
const ISSUE_ID = "FLY-560";
const CHAT_CHANNEL = "chan-product";
const THREAD_ID = "thread-fly560c";

const projects: ProjectEntry[] = [
	{
		projectName: PROJECT,
		projectRoot: "/tmp/fly560c-test",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "core",
				chatChannel: CHAT_CHANNEL,
				botToken: "bot-token",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "core",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("FLY-560 Feature C: event-route attach-pin wiring", () => {
	let store: StateStore;
	let stampSpy: ReturnType<typeof vi.fn>;
	let attachSpy: ReturnType<typeof vi.fn>;
	let headerSpy: ReturnType<typeof vi.fn>;
	let fakeCreator: ChatThreadCreator;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC_ID,
			issue_id: ISSUE_ID,
			issue_identifier: "FLY-560",
			issue_title: "Discord issue status",
			project_name: PROJECT,
			status: "running",
			started_at: new Date().toISOString(),
			issue_labels: JSON.stringify(["Flywheel"]),
		});
		store.upsertChatThread(THREAD_ID, CHAT_CHANNEL, ISSUE_ID);
		stampSpy = vi.fn().mockResolvedValue(undefined);
		attachSpy = vi.fn().mockResolvedValue(undefined);
		headerSpy = vi.fn().mockResolvedValue(undefined);
		fakeCreator = {
			stampStageEmoji: stampSpy,
			ensureRunnerAttachPin: attachSpy,
			ensureRunnerPipelineHeaderPin: headerSpy,
		} as unknown as ChatThreadCreator;
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	function buildApp(featureFlags?: {
		issueStatusEmojiEnabled?: boolean;
		issueAttachPinEnabled?: boolean;
	}) {
		const app = express();
		app.use(express.json());
		app.use(
			"/events",
			createEventRouter(
				store,
				projects,
				makeConfig(),
				undefined,
				undefined,
				undefined,
				undefined,
				fakeCreator,
				undefined,
				featureFlags,
			),
		);
		return app;
	}

	async function postStage(
		app: express.Express,
		eventId: string,
	): Promise<void> {
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/events`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					event_id: eventId,
					execution_id: EXEC_ID,
					issue_id: ISSUE_ID,
					project_name: PROJECT,
					event_type: "stage_changed",
					payload: { stage: "implement" },
				}),
			});
			expect(res.ok).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		// let the fire-and-forget attach IIFE (awaits resolveCmuxAttachTarget) drain
		await new Promise((r) => setTimeout(r, 25));
	}

	it("both on → stamps emoji AND pins attach command (resolved from cmux target)", async () => {
		await postStage(
			buildApp({ issueStatusEmojiEnabled: true, issueAttachPinEnabled: true }),
			"evt-both",
		);
		expect(stampSpy).toHaveBeenCalledTimes(1);
		expect(attachSpy).toHaveBeenCalledTimes(1);
		const [ctx, threadId, command] = attachSpy.mock.calls[0]!;
		expect(threadId).toBe(THREAD_ID);
		expect(command).toBe("env -u TMUX tmux attach -t '=cmux-FLY-560-claude-x'");
		expect(ctx).toMatchObject({
			chatChannelId: CHAT_CHANNEL,
			issueId: ISSUE_ID,
			issueIdentifier: "FLY-560",
			botToken: "bot-token",
		});
	});

	// FLY-892 (Codex code R1 Med): the single-runner "Runner terminal" pin is NOT
	// a system broadcast — even when the project configures an announcer bot, the
	// non-three-stage fallback must post/edit/pin as the LEAD bot (byte-compat),
	// not the announcer. Only the three-stage pipeline header rides the announcer.
	it("announcer configured + non-three-stage → single-runner pin stays on the LEAD bot", async () => {
		const announcerProjects: ProjectEntry[] = [
			{
				...projects[0]!,
				announcerBotToken: "announcer-bot-token",
			} as ProjectEntry,
		];
		const app = express();
		app.use(express.json());
		app.use(
			"/events",
			createEventRouter(
				store,
				announcerProjects,
				makeConfig(),
				undefined,
				undefined,
				undefined,
				undefined,
				fakeCreator,
				undefined,
				{ issueStatusEmojiEnabled: false, issueAttachPinEnabled: true },
			),
		);
		await postStage(app, "evt-announcer-single");
		expect(attachSpy).toHaveBeenCalledTimes(1);
		expect(headerSpy).not.toHaveBeenCalled();
		const [ctx] = attachSpy.mock.calls[0]!;
		expect(ctx.botToken).toBe("bot-token"); // LEAD bot, NOT announcer
	});

	it("emoji on + attach off → stamps only (attach not pinned)", async () => {
		await postStage(
			buildApp({ issueStatusEmojiEnabled: true, issueAttachPinEnabled: false }),
			"evt-emoji",
		);
		expect(stampSpy).toHaveBeenCalledTimes(1);
		expect(attachSpy).not.toHaveBeenCalled();
	});

	it("emoji off + attach on → pins attach only (no emoji)", async () => {
		await postStage(
			buildApp({ issueStatusEmojiEnabled: false, issueAttachPinEnabled: true }),
			"evt-attach",
		);
		expect(stampSpy).not.toHaveBeenCalled();
		expect(attachSpy).toHaveBeenCalledTimes(1);
	});

	it("default flags (none passed) → emoji on, attach off (Feature A byte-compat)", async () => {
		await postStage(buildApp(undefined), "evt-default");
		expect(stampSpy).toHaveBeenCalledTimes(1);
		expect(attachSpy).not.toHaveBeenCalled();
	});

	it("attach on but no thread yet → no attach call (next stage reconciles)", async () => {
		store.markChatThreadMissing(THREAD_ID); // simulate thread not resolvable
		await postStage(
			buildApp({ issueStatusEmojiEnabled: false, issueAttachPinEnabled: true }),
			"evt-nothread",
		);
		expect(attachSpy).not.toHaveBeenCalled();
	});
});
