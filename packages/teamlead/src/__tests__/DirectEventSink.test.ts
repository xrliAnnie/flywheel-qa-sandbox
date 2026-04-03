/**
 * FLY-24: Tests for DirectEventSink Forum Post creation.
 *
 * Verifies that DirectEventSink.emitStarted() calls ForumPostCreator.ensureForumPost()
 * when no existing thread is found and the lead has a forumChannel configured.
 */

import type { EventEnvelope } from "flywheel-edge-worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventFilter } from "../bridge/EventFilter.js";
import type { ForumPostCreator } from "../bridge/ForumPostCreator.js";
import type { ForumTagUpdater } from "../bridge/ForumTagUpdater.js";
import type { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "forum-ch-1",
				chatChannel: "chat-ch-1",
				match: { labels: ["Product"] },
				botToken: "bot-token-test",
			},
		],
	},
];

const testProjectsNoForum: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "cos-lead",
				chatChannel: "chat-ch-1",
				match: { labels: [] },
				// No forumChannel — PM lead
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		discordBotToken: "global-bot-token",
		...overrides,
	};
}

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
	return {
		executionId: "exec-1",
		issueId: "issue-1",
		projectName: "geoforge3d",
		issueIdentifier: "GEO-100",
		issueTitle: "Test issue",
		...overrides,
	};
}

function createMockForumPostCreator(): ForumPostCreator {
	return {
		ensureForumPost: vi.fn().mockResolvedValue({
			created: true,
			threadId: "thread-new-123",
		}),
	} as unknown as ForumPostCreator;
}

describe("DirectEventSink — Forum Post creation (FLY-24)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("calls ForumPostCreator.ensureForumPost() on session_started when no thread exists", async () => {
		const mockCreator = createMockForumPostCreator();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined, // eventFilter
			undefined, // forumTagUpdater
			undefined, // registry
			mockCreator,
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		expect(mockCreator.ensureForumPost).toHaveBeenCalledOnce();
		expect(mockCreator.ensureForumPost).toHaveBeenCalledWith(
			expect.objectContaining({
				forumChannelId: "forum-ch-1",
				issueId: "issue-1",
				issueIdentifier: "GEO-100",
				issueTitle: "Test issue",
				executionId: "exec-1",
				status: "running",
			}),
		);
	});

	it("skips ForumPostCreator when lead has no forumChannel", async () => {
		const mockCreator = createMockForumPostCreator();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjectsNoForum,
			undefined,
			undefined,
			undefined,
			mockCreator,
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		expect(mockCreator.ensureForumPost).not.toHaveBeenCalled();
	});

	it("skips ForumPostCreator when thread already inherited", async () => {
		// Pre-seed a thread mapping so inheritance finds it
		store.upsertThread("existing-thread-id", "forum-ch-1", "issue-1");

		const mockCreator = createMockForumPostCreator();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			mockCreator,
		);

		// Mock validateThreadExists to return true (thread is valid)
		vi.mock("../bridge/thread-validator.js", () => ({
			validateThreadExists: vi.fn().mockResolvedValue(true),
		}));

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		// Should NOT call ensureForumPost since thread was inherited
		expect(mockCreator.ensureForumPost).not.toHaveBeenCalled();
	});

	it("does not call ForumPostCreator when none is provided", async () => {
		// No forumPostCreator passed — should work without error
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			// no forumPostCreator
		);

		// Should not throw
		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		// Session should still be created
		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
	});

	it("passes per-lead bot token and statusTagMap to ForumPostCreator", async () => {
		const projectsWithTokenAndMap: ProjectEntry[] = [
			{
				projectName: "geoforge3d",
				projectRoot: "/tmp/geoforge3d",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "forum-ch-1",
						chatChannel: "chat-ch-1",
						match: { labels: [] },
						botToken: "per-lead-bot-token",
						statusTagMap: { running: ["tag-running-custom"] },
					},
				],
			},
		];

		const mockCreator = createMockForumPostCreator();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			projectsWithTokenAndMap,
			undefined,
			undefined,
			undefined,
			mockCreator,
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		expect(mockCreator.ensureForumPost).toHaveBeenCalledWith(
			expect.objectContaining({
				discordBotToken: "per-lead-bot-token",
				statusTagMap: { running: ["tag-running-custom"] },
			}),
		);
	});

	it("catches ForumPostCreator errors without failing emitStarted", async () => {
		const mockCreator = {
			ensureForumPost: vi.fn().mockRejectedValue(new Error("Discord 500")),
		} as unknown as ForumPostCreator;

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			mockCreator,
		);

		// Should not throw
		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		// Session should still be created
		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
	});
});

describe("DirectEventSink — Forum Tag Update on emitCompleted (FLY-24 Bug 2)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	function createMockRuntime(): import("../bridge/lead-runtime.js").LeadRuntime {
		return {
			type: "claude-discord",
			deliver: vi.fn().mockResolvedValue({ delivered: true }),
			sendBootstrap: vi.fn().mockResolvedValue(undefined),
			health: vi.fn().mockResolvedValue({
				status: "healthy",
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			}),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
	}

	it("calls ForumTagUpdater.updateTag() on emitCompleted with correct threadId and status", async () => {
		// Setup: pre-create session with thread_id (simulating ensureForumPost already ran)
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertThread("thread-123", "forum-ch-1", "issue-1");
		store.setSessionThreadId("exec-1", "thread-123");

		const mockTagUpdater: ForumTagUpdater = {
			updateTag: vi.fn().mockResolvedValue("succeeded"),
		} as unknown as ForumTagUpdater;

		const mockFilter: EventFilter = new (
			await import("../bridge/EventFilter.js")
		).EventFilter();

		const mockRuntime = createMockRuntime();
		const registry: RuntimeRegistry = new (
			await import("../bridge/runtime-registry.js")
		).RuntimeRegistry();
		registry.register(testProjects[0].leads[0], mockRuntime);

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			mockFilter,
			mockTagUpdater,
			registry,
			undefined, // no forumPostCreator needed for this test
		);

		await sink.emitCompleted(
			makeEnvelope(),
			{
				decision: { route: "needs_review", reasoning: "test" },
				evidence: {},
			} as import("flywheel-edge-worker/dist/Blueprint.js").BlueprintResult,
		);
		await sink.flush();

		// ForumTagUpdater.updateTag() MUST have been called
		expect(mockTagUpdater.updateTag).toHaveBeenCalledOnce();
		expect(mockTagUpdater.updateTag).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: "thread-123",
				status: "awaiting_review",
				eventType: "session_completed",
			}),
		);
	});

	it("calls updateTag with per-lead botToken and statusTagMap", async () => {
		const projectsWithConfig: ProjectEntry[] = [
			{
				projectName: "geoforge3d",
				projectRoot: "/tmp/geoforge3d",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "forum-ch-1",
						chatChannel: "chat-ch-1",
						match: { labels: ["Product"] },
						botToken: "per-lead-token",
						statusTagMap: { awaiting_review: ["tag-ar-1"] },
					},
				],
			},
		];

		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertThread("thread-456", "forum-ch-1", "issue-1");
		store.setSessionThreadId("exec-1", "thread-456");

		const mockTagUpdater: ForumTagUpdater = {
			updateTag: vi.fn().mockResolvedValue("succeeded"),
		} as unknown as ForumTagUpdater;

		const mockFilter: EventFilter = new (
			await import("../bridge/EventFilter.js")
		).EventFilter();

		const mockRuntime = createMockRuntime();
		const registry: RuntimeRegistry = new (
			await import("../bridge/runtime-registry.js")
		).RuntimeRegistry();
		registry.register(projectsWithConfig[0].leads[0], mockRuntime);

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			projectsWithConfig,
			mockFilter,
			mockTagUpdater,
			registry,
		);

		await sink.emitCompleted(
			makeEnvelope(),
			{
				decision: { route: "needs_review", reasoning: "test" },
				evidence: {},
			} as import("flywheel-edge-worker/dist/Blueprint.js").BlueprintResult,
		);
		await sink.flush();

		expect(mockTagUpdater.updateTag).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: "thread-456",
				discordBotToken: "per-lead-token",
				statusTagMap: { awaiting_review: ["tag-ar-1"] },
			}),
		);
	});

	it("does NOT call updateTag when registry is not provided (legacy path)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		store.upsertThread("thread-789", "forum-ch-1", "issue-1");
		store.setSessionThreadId("exec-1", "thread-789");

		const mockTagUpdater: ForumTagUpdater = {
			updateTag: vi.fn().mockResolvedValue("succeeded"),
		} as unknown as ForumTagUpdater;

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined, // no eventFilter
			mockTagUpdater,
			undefined, // no registry → legacy path
		);

		await sink.emitCompleted(
			makeEnvelope(),
			{
				decision: { route: "needs_review", reasoning: "test" },
				evidence: {},
			} as import("flywheel-edge-worker/dist/Blueprint.js").BlueprintResult,
		);
		await sink.flush();

		// Legacy path: no registry → pushNotification returns early → no tag update
		expect(mockTagUpdater.updateTag).not.toHaveBeenCalled();
	});

	it("does NOT call updateTag when eventFilter is not provided", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertThread("thread-aaa", "forum-ch-1", "issue-1");
		store.setSessionThreadId("exec-1", "thread-aaa");

		const mockTagUpdater: ForumTagUpdater = {
			updateTag: vi.fn().mockResolvedValue("succeeded"),
		} as unknown as ForumTagUpdater;

		const mockRuntime = createMockRuntime();
		const registry: RuntimeRegistry = new (
			await import("../bridge/runtime-registry.js")
		).RuntimeRegistry();
		registry.register(testProjects[0].leads[0], mockRuntime);

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined, // no eventFilter → else branch in doDeliver (no tag update)
			mockTagUpdater,
			registry,
		);

		await sink.emitCompleted(
			makeEnvelope(),
			{
				decision: { route: "needs_review", reasoning: "test" },
				evidence: {},
			} as import("flywheel-edge-worker/dist/Blueprint.js").BlueprintResult,
		);
		await sink.flush();

		// No eventFilter → doDeliver enters else branch → no tag update
		expect(mockTagUpdater.updateTag).not.toHaveBeenCalled();
	});

	it("calls updateTag on emitFailed with status 'failed'", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertThread("thread-fail", "forum-ch-1", "issue-1");
		store.setSessionThreadId("exec-1", "thread-fail");

		const mockTagUpdater: ForumTagUpdater = {
			updateTag: vi.fn().mockResolvedValue("succeeded"),
		} as unknown as ForumTagUpdater;

		const mockFilter: EventFilter = new (
			await import("../bridge/EventFilter.js")
		).EventFilter();

		const mockRuntime = createMockRuntime();
		const registry: RuntimeRegistry = new (
			await import("../bridge/runtime-registry.js")
		).RuntimeRegistry();
		registry.register(testProjects[0].leads[0], mockRuntime);

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			mockFilter,
			mockTagUpdater,
			registry,
		);

		await sink.emitFailed(makeEnvelope(), "Something went wrong");
		await sink.flush();

		expect(mockTagUpdater.updateTag).toHaveBeenCalledOnce();
		expect(mockTagUpdater.updateTag).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: "thread-fail",
				status: "failed",
				eventType: "session_failed",
			}),
		);
	});
});
