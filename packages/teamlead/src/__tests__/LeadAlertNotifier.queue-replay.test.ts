import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChannelHub } from "../bridge/AlertChannelHub.js";
import { AutoRepairBot } from "../bridge/AutoRepairBot.js";
import { attachDeliveredAlertLifecycles } from "../bridge/drained-alert-routing.js";
import { type AlertPayload, LeadAlertNotifier } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chat",
				match: { labels: ["Flywheel"] },
				botTokenEnv: "FLY2075_TEST_BOT_TOKEN",
				botToken: "test-token",
			},
		],
	},
] as unknown as ProjectEntry[];

describe("FLY-2075 legacy alert queue replay", () => {
	let queueDir: string;
	let store: StateStore;
	let savedSenderEnv: string | undefined;
	let savedToken: string | undefined;

	beforeEach(async () => {
		queueDir = mkdtempSync(join(tmpdir(), "fly2075-replay-"));
		store = await StateStore.create(":memory:");
		savedSenderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		savedToken = process.env.FLY2075_TEST_BOT_TOKEN;
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		process.env.FLY2075_TEST_BOT_TOKEN = "test-token";
	});

	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		if (savedSenderEnv === undefined)
			delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		else process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = savedSenderEnv;
		if (savedToken === undefined) delete process.env.FLY2075_TEST_BOT_TOKEN;
		else process.env.FLY2075_TEST_BOT_TOKEN = savedToken;
	});

	it("ignores serialized ESCALATED status across root POST, thread, and ledger", async () => {
		const payload: AlertPayload = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventId: "fly2075-legacy-queue",
			eventType: "review_advisory_pass",
			title: "Legacy queued advisory",
			body: "old payload shape",
			severity: "warning",
			ticket: {
				ownerUserId: null,
				ownerLabel: "claude bot",
				status: "ESCALATED",
				firstSeenMs: Date.now(),
				ownerRef: "infra_bot:claude",
			} as any,
		};
		writeFileSync(
			join(queueDir, "20260826T120000Z-fly2075-legacy.json"),
			JSON.stringify({
				...payload,
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
			}),
		);

		const rootPosts: string[] = [];
		const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
			rootPosts.push(String(init?.body));
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ id: "root-replayed" }),
			};
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects,
			fetchFn: fetchFn as unknown as typeof fetch,
			queueDir,
			unifiedAlert: {
				channelId: "1518793447165661254",
				repairBotTokenEnv: "FLY2075_TEST_BOT_TOKEN",
			},
			ticketsEnabled: () => true,
		});
		const threadPosts: Array<{
			content: string;
			mentionUserId?: string;
		}> = [];
		const hub = new AlertChannelHub({
			store,
			notifier,
			autoRepairBot: new AutoRepairBot({}),
			discord: {
				async createThreadFromMessage() {
					return "thread-replayed";
				},
				async postToThread(_threadId, content, opts) {
					threadPosts.push({ content, mentionUserId: opts?.mentionUserId });
				},
				async archiveThread() {},
			},
		});

		const drained = await notifier.drainQueue();
		await attachDeliveredAlertLifecycles(drained.delivered, hub);

		const rootBody = JSON.parse(rootPosts[0]!) as { content: string };
		expect(rootBody.content).toContain("状态 NEW");
		expect(rootBody.content).not.toContain("ESCALATED");
		const row = store.getActiveAlertThread(
			"flywheel|flywheel-eng-lead|review_advisory_pass|",
		);
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.repair_status).toBeNull();
		expect(
			threadPosts.every((post) => !post.content.includes("ESCALATED")),
		).toBe(true);
		expect(threadPosts.every((post) => post.mentionUserId === undefined)).toBe(
			true,
		);
	});
});
