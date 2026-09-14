import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { watchIssueThreadBotSends } from "../bot-send-rearchive.js";
import { postChatMessage } from "../chat-thread-utils.js";
import { postDiscordMessageWithFile } from "../discord-post-file.js";
import { postDiscordMessageToChannel } from "../discord-utils.js";
import { postThreadMessage } from "../disposition-receipt.js";
import { startDoneThreadReconcileScheduler } from "../done-thread-reconcile.js";
import { postFounderReviewThreadReply } from "../founder-reply-deliverer.js";
import { emitIssueThreadInfraNotification } from "../founder-thread-notifier.js";
import { emitRunnerReadyToCloseNotification } from "../runner-ready-to-close-notifier.js";
import {
	isRetryableOutcome,
	runTargetedArchiveCheck,
} from "../terminal-thread-archive.js";

describe("FLY-2554 Bridge bot-send rearchive", () => {
	it.each([
		"relay",
		"infra",
		"chat",
		"disposition",
		"founder-reply",
		"file",
		"ready",
	] as const)(
		"successful %s send reaches the exact-thread targeted pass",
		async (sender) => {
			const store = await StateStore.create(":memory:");
			store.upsertChatThread("thread-2554", "parent", "FLY-2554", "lead");
			store.markChatThreadArchived("thread-2554");
			vi.useFakeTimers();
			const runTargeted = vi.fn(async () => ({ done: true }));
			const scheduler = startDoneThreadReconcileScheduler({
				runOnce: async () => {},
				runTargeted,
				bootDelayMs: 1_000_000,
				tickMs: 1000,
				resolveConfig: () => ({
					enabled: true,
					dryRun: false,
					intervalMin: 360,
					maxArchivesPerRun: 10,
					maxCandidatesPerRun: 100,
					runDeadlineMs: 1000,
				}),
			});
			const unwatch = watchIssueThreadBotSends({
				store,
				projects: [],
				enqueue: scheduler.enqueueThread,
			});
			try {
				const fetchImpl = vi.fn(
					async () => new Response(JSON.stringify({ id: "message-1" })),
				) as typeof fetch;
				if (sender === "relay") {
					const result = await postDiscordMessageToChannel(
						"thread-2554",
						"✅ 已合入",
						"test-token",
						{ origin: "lead_authored" },
						fetchImpl,
					);
					expect(result.ok).toBe(true);
				} else if (sender === "chat") {
					const result = await postChatMessage(
						{
							channelId: "thread-2554",
							content: "🔨 实现",
							botToken: "test-token",
						},
						{ fetchImpl },
					);
					expect(result.posted).toBe(true);
				} else if (sender === "disposition") {
					await postThreadMessage("test-token", "thread-2554", "receipt", {
						fetchImpl,
					});
				} else if (sender === "founder-reply") {
					expect(
						await postFounderReviewThreadReply(
							"thread-2554",
							"test-token",
							"reply",
							fetchImpl,
						),
					).toBe(true);
				} else if (sender === "file") {
					expect(
						(
							await postDiscordMessageWithFile(
								"thread-2554",
								"report",
								{ filename: "report.png", data: Buffer.from("test") },
								"test-token",
								fetchImpl,
							)
						).ok,
					).toBe(true);
				} else if (sender === "ready") {
					await emitRunnerReadyToCloseNotification(
						{
							executionId: "exec",
							issueId: "FLY-2554",
							projectName: "flywheel",
							sessionStatus: "completed",
							tmuxClosed: true,
							thread: store.getChatThreadByIssue("FLY-2554", "parent"),
							botToken: "test-token",
						},
						{ store, fetchImpl },
					);
				} else {
					const result = await emitIssueThreadInfraNotification(
						{
							executionId: "exec",
							issueId: "FLY-2554",
							projectName: "flywheel",
							kind: "patrol",
							content: "巡检提醒",
							thread: { thread_id: "thread-2554" },
							botToken: "test-token",
							onUndeliverable: () => {},
						},
						{ store, fetchImpl },
					);
					expect(result.kind).toBe("posted");
				}
				await vi.advanceTimersByTimeAsync(1000);
				expect(runTargeted.mock.calls).toEqual([["FLY-2554", "thread-2554"]]);
			} finally {
				unwatch();
				await scheduler.stop();
				vi.useRealTimers();
				store.close();
			}
		},
	);
	it("a bot relay on a shipped reopened thread reaches the real archive sink on the next tick", async () => {
		const store = await StateStore.create(":memory:");
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now - 30_000);
		store.upsertChatThread("thread-live", "parent", "FLY-2554", "lead");
		const op = store.ensureLandOperation({
			issueId: "FLY-2554",
			projectName: "flywheel",
			prNumber: 2554,
			approvedHead: "a".repeat(40),
			now: new Date().toISOString(),
		});
		const claim = store.claimLandOperation({
			operationId: op.operation_id,
			ownerId: "worker",
			now: new Date().toISOString(),
			leaseExpiresAt: new Date(now + 60_000).toISOString(),
		});
		if (!claim) throw new Error("claim missing");
		for (const step of ["merge_confirmed", "terminal_notified"]) {
			expect(
				store.recordLandOperationStep({
					operationId: op.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step,
					receipt: { threadId: "thread-live" },
					now: new Date().toISOString(),
				}).ok,
			).toBe(true);
		}
		vi.setSystemTime(now - 10_000);
		store.markChatThreadArchived("thread-live");
		vi.setSystemTime(now);
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/fw",
				leads: [
					{ agentId: "lead", chatChannel: "parent", botToken: "test-token" },
				],
			},
		] as ProjectEntry[];
		let archived = false;
		const messageId = ((BigInt(now) - 1420070400000n) << 22n).toString();
		const fetchImpl = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "POST")
					return new Response(JSON.stringify({ id: messageId }));
				if (init?.method === "PATCH") {
					archived = true;
					return new Response(
						JSON.stringify({
							id: "thread-live",
							thread_metadata: { archived: true },
						}),
					);
				}
				if (String(url).includes("/messages?"))
					return new Response(
						JSON.stringify([{ id: messageId, author: { bot: true } }]),
					);
				return new Response(
					JSON.stringify({ name: "thread", thread_metadata: { archived } }),
				);
			},
		) as typeof fetch;
		const scheduler = startDoneThreadReconcileScheduler({
			runOnce: async () => {},
			bootDelayMs: 1_000_000,
			tickMs: 1000,
			resolveConfig: () => ({
				enabled: true,
				dryRun: false,
				intervalMin: 360,
				maxArchivesPerRun: 10,
				maxCandidatesPerRun: 100,
				runDeadlineMs: 1000,
			}),
			runTargeted: async (issueId, threadId) => {
				const outcome = await runTargetedArchiveCheck(issueId, {
					store,
					projects,
					threadId,
					dryRun: false,
					linearApiKey: "test",
					lookupIssue: async () => ({
						id: "uuid-2554",
						identifier: "FLY-2554",
						stateType: "completed",
					}),
					lookupTarget: () => ({ kind: "gone" }),
					fetchImpl,
				});
				return { done: !isRetryableOutcome(outcome), note: outcome.kind };
			},
		});
		const stop = watchIssueThreadBotSends({
			store,
			projects,
			enqueue: scheduler.enqueueThread,
		});
		try {
			expect(
				(
					await postDiscordMessageToChannel(
						"thread-live",
						"已合入",
						"test-token",
						{ origin: "lead_authored" },
						fetchImpl,
					)
				).ok,
			).toBe(true);
			expect(archived).toBe(false);
			await vi.advanceTimersByTimeAsync(1000);
			expect(archived).toBe(true);
			expect(store.getChatThreadCompensationPending("thread-live")).toBeNull();
			await vi.advanceTimersByTimeAsync(2000);
			expect(
				vi
					.mocked(fetchImpl)
					.mock.calls.filter(([, init]) => init?.method === "PATCH"),
			).toHaveLength(1);
		} finally {
			stop();
			await scheduler.stop();
			vi.useRealTimers();
			store.close();
		}
	});

	it("ignores failed sends, ordinary channels, active issues, and unsubscribed sends", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertChatThread("archived", "parent", "FLY-done", "lead");
		store.markChatThreadArchived("archived");
		store.upsertChatThread("active", "parent", "FLY-active", "lead");
		const enqueue = vi.fn(() => "accepted" as const);
		const unwatch = watchIssueThreadBotSends({ store, projects: [], enqueue });
		const ok = vi.fn(
			async () => new Response(JSON.stringify({ id: "message" })),
		) as typeof fetch;
		try {
			await postDiscordMessageToChannel(
				"archived",
				"test",
				"token",
				{ origin: "automation" },
				vi.fn(
					async () => new Response("denied", { status: 403 }),
				) as typeof fetch,
			);
			await postDiscordMessageToChannel(
				"ordinary-channel",
				"test",
				"token",
				{ origin: "automation" },
				ok,
			);
			await postDiscordMessageToChannel(
				"active",
				"test",
				"token",
				{ origin: "automation" },
				ok,
			);
			expect(enqueue).not.toHaveBeenCalled();
			unwatch();
			await postDiscordMessageToChannel(
				"archived",
				"test",
				"token",
				{ origin: "automation" },
				ok,
			);
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			unwatch();
			store.close();
		}
	});

	it("a failing admission observer cannot turn a successful post into a failed send", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertChatThread("archived", "parent", "FLY-done", "lead");
		store.markChatThreadArchived("archived");
		const unwatch = watchIssueThreadBotSends({
			store,
			projects: [],
			enqueue: () => {
				throw new Error("queue unavailable");
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await postDiscordMessageToChannel(
				"archived",
				"test",
				"token",
				{ origin: "automation" },
				vi.fn(
					async () => new Response(JSON.stringify({ id: "message" })),
				) as typeof fetch,
			);
			expect(result.ok).toBe(true);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			unwatch();
			warn.mockRestore();
			store.close();
		}
	});
});
