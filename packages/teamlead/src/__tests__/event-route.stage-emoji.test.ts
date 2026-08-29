/**
 * FLY-560 Feature A: event-route auto-stamps the stage emoji onto the issue's
 * [FLY-XX] chat thread title when a `stage_changed` event arrives. These tests
 * verify the wiring: the router resolves the issue's lead + existing thread and
 * delegates to ChatThreadCreator.stampStageEmoji. Byte-compat: when no creator
 * is wired (feature flag off / chat threads off), nothing is stamped and the
 * event still processes normally.
 */

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import { createEventRouter } from "../bridge/event-route.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { type Session, StateStore } from "../StateStore.js";

const PROJECT = "fly560-test";
const EXEC_ID = "exec-fly560-1";
const ISSUE_ID = "FLY-560";
const CHAT_CHANNEL = "chan-product";
const THREAD_ID = "thread-fly560";

const projects: ProjectEntry[] = [
	{
		projectName: PROJECT,
		projectRoot: "/tmp/fly560-test",
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

describe("FLY-560: event-route stage-emoji stamping", () => {
	let store: StateStore;
	let stampSpy: ReturnType<typeof vi.fn>;
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
		stampSpy = vi.fn().mockResolvedValue(undefined);
		fakeCreator = {
			stampStageEmoji: stampSpy,
		} as unknown as ChatThreadCreator;
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	function buildApp(
		creator?: ChatThreadCreator,
		reconnectHolder?: {
			current: {
				isReconnecting: (id: string) => boolean;
				isReconnectTitleActive: (id: string) => boolean;
				clearReconnecting: (id: string) => void;
				settleReconnectTitles: (ids: readonly string[]) => Session[];
			} | null;
		},
	) {
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
				creator,
				undefined, // removeCleanWorktree
				undefined, // FLY-560 featureFlags (undefined → emoji-stamp ON, byte-compat)
				reconnectHolder,
			),
		);
		return app;
	}

	async function postStage(
		app: express.Express,
		stage: string,
		eventId: string,
	): Promise<Response> {
		// Use supertest-free direct call via a listening server.
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			return await fetch(`http://127.0.0.1:${port}/events`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					event_id: eventId,
					execution_id: EXEC_ID,
					issue_id: ISSUE_ID,
					project_name: PROJECT,
					event_type: "stage_changed",
					payload: { stage },
				}),
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	it("stamps the stage emoji on the issue thread when a thread exists", async () => {
		store.upsertChatThread(THREAD_ID, CHAT_CHANNEL, ISSUE_ID);
		const res = await postStage(buildApp(fakeCreator), "implement", "evt-1");
		expect(res.ok).toBe(true);

		expect(stampSpy).toHaveBeenCalledTimes(1);
		const [ctx, threadId, stage] = stampSpy.mock.calls[0]!;
		expect(threadId).toBe(THREAD_ID);
		expect(stage).toBe("implement");
		expect(ctx).toMatchObject({
			chatChannelId: CHAT_CHANNEL,
			issueId: ISSUE_ID,
			issueIdentifier: "FLY-560",
			issueTitle: "Discord issue status",
			botToken: "bot-token",
		});
	});

	it("does not stamp when no thread mapping exists yet", async () => {
		// No upsertChatThread — thread not created.
		const res = await postStage(buildApp(fakeCreator), "implement", "evt-2");
		expect(res.ok).toBe(true);
		expect(stampSpy).not.toHaveBeenCalled();
	});

	it("byte-compat: no creator wired → no stamping, event still processes", async () => {
		store.upsertChatThread(THREAD_ID, CHAT_CHANNEL, ISSUE_ID);
		const res = await postStage(buildApp(undefined), "implement", "evt-3");
		expect(res.ok).toBe(true);
		expect(stampSpy).not.toHaveBeenCalled();
		// Stage still persisted.
		expect(store.getSession(EXEC_ID)?.session_stage).toBe("implement");
	});

	it("ignores an invalid stage (no stamp)", async () => {
		store.upsertChatThread(THREAD_ID, CHAT_CHANNEL, ISSUE_ID);
		const res = await postStage(buildApp(fakeCreator), "bogus", "evt-4");
		expect(res.ok).toBe(true);
		expect(stampSpy).not.toHaveBeenCalled();
	});

	it("FLY-623: an ACCEPTED stage_changed clears reconnecting (channel proven live)", async () => {
		const clearReconnecting = vi.fn();
		const holder = {
			current: {
				isReconnecting: () => true,
				isReconnectTitleActive: () => true,
				clearReconnecting,
				settleReconnectTitles: () => [],
			},
		};
		store.upsertChatThread(THREAD_ID, CHAT_CHANNEL, ISSUE_ID);
		const res = await postStage(
			buildApp(fakeCreator, holder),
			"implement",
			"evt-rc-1",
		);
		expect(res.ok).toBe(true);
		expect(clearReconnecting).toHaveBeenCalledWith(EXEC_ID);
	});

	it("FLY-623 (Codex R1 HIGH): an invalid/rejected stage does NOT clear reconnecting", async () => {
		const clearReconnecting = vi.fn();
		const holder = {
			current: {
				isReconnecting: () => true,
				isReconnectTitleActive: () => true,
				clearReconnecting,
				settleReconnectTitles: () => [],
			},
		};
		const res = await postStage(
			buildApp(fakeCreator, holder),
			"bogus",
			"evt-rc-2",
		);
		expect(res.ok).toBe(true);
		// stage rejected before persist → suppression must NOT be cleared
		expect(clearReconnecting).not.toHaveBeenCalled();
	});
});
