/** FLY-2075: Hub opens tickets without automatic founder escalation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChannelHub } from "../bridge/AlertChannelHub.js";
import type { AutoRepairBot } from "../bridge/AutoRepairBot.js";
import type {
	AlertPayload,
	AlertResult,
	AlertTicketContext,
} from "../LeadAlertNotifier.js";
import { StateStore } from "../StateStore.js";

type PostTuple = [string, string, { mentionUserId?: string } | undefined];

function makeDiscord() {
	const posts: PostTuple[] = [];
	let n = 0;
	return {
		posts,
		async createThreadFromMessage() {
			return `thread-${++n}`;
		},
		async postToThread(
			threadId: string,
			content: string,
			opts?: { mentionUserId?: string },
		) {
			posts.push([threadId, content, opts]);
		},
		async archiveThread() {},
	};
}

function makeBot() {
	const attempt = vi.fn(async () => ({
		outcome: "needs_human" as const,
		action: "none",
		detail:
			"a runner is blocked waiting on the Lead to answer its question, and the Lead has not responded after several reminders — the Lead needs a human poke (the runner is fine; nothing to auto-repair).",
	}));
	return {
		bot: {
			canAttempt: () => false,
			attempt,
		} as unknown as AutoRepairBot,
		attempt,
	};
}

const SENT: AlertResult = Object.freeze({
	sent: true,
	channelId: "UNI",
	messageId: "root-1",
});

function ticket(): AlertTicketContext {
	return {
		ownerUserId: null,
		ownerLabel: "claude bot",
		firstSeenMs: Date.parse("2026-07-09T21:00:00Z"),
		ownerRef: "infra_bot:claude",
	};
}

describe("AlertChannelHub — FLY-2075 never auto-escalates", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("zombie_session_backlog stays NEW with no founder post", async () => {
		const discord = makeDiscord();
		const { bot, attempt } = makeBot();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			autoRepairBot: bot,
		});
		const payload: AlertPayload = {
			leadId: "machine",
			projectName: "machine",
			eventId: "evt-z1",
			eventType: "zombie_session_backlog",
			title: "跨 Lead 僵尸 session 积压",
			body: "3 zombies: a, b, c",
			severity: "warning",
			ticket: ticket(),
		};

		await hub.handle(payload);

		expect(attempt).toHaveBeenCalledTimes(1);
		expect(discord.posts.some(([, c]) => c.includes("🙋"))).toBe(false);
		expect(discord.posts.every(([, c]) => !c.includes("<@"))).toBe(true);
		const row = store.getActiveAlertThread(
			"machine|machine|zombie_session_backlog|",
		);
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.repair_status).toBeNull();
	});

	it("runner_lead_pending_unhandled has no automatic founder post", async () => {
		const discord = makeDiscord();
		const { bot, attempt } = makeBot();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			autoRepairBot: bot,
		});
		const payload: AlertPayload = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventId: "evt-lp1",
			eventType: "runner_lead_pending_unhandled",
			title: "Lead pending unhandled",
			body: "b",
			severity: "warning",
			// ISSUE_PROGRESS kind — never 🎫-enriched (no ticket context).
		};

		await hub.handle(payload);

		expect(discord.posts.some(([, c]) => c.includes("🙋"))).toBe(false);
		expect(attempt).toHaveBeenCalledTimes(1);
		const row = store.getActiveAlertThread(
			"flywheel|flywheel-eng-lead|runner_lead_pending_unhandled|",
		);
		expect(row?.repair_status).toBeNull();
		// No ticket context → the ticket state machine is untouched (NULL).
		expect(row?.ticket_status).toBeNull();
	});

	it("zombie without an auto-repair bot still opens NEW without paging", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			// NO autoRepairBot — FLYWHEEL_AUTO_REPAIR off.
		});
		await hub.handle({
			leadId: "machine",
			projectName: "machine",
			eventId: "evt-z-nobot",
			eventType: "zombie_session_backlog",
			title: "跨 Lead 僵尸 session 积压",
			body: "3 zombies",
			severity: "warning",
			ticket: ticket(),
		});
		expect(discord.posts.some(([, c]) => c.includes("🙋"))).toBe(false);
		const row = store.getActiveAlertThread(
			"machine|machine|zombie_session_backlog|",
		);
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.repair_status).toBeNull();
	});

	it("an auto-contract kind still goes through the ARC attempt path (unchanged)", async () => {
		const discord = makeDiscord();
		const { bot, attempt } = makeBot();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			autoRepairBot: bot,
		});
		await hub.handle({
			leadId: "tadashi",
			projectName: "flywheel",
			eventId: "evt-p1",
			eventType: "pane_hash_stuck",
			title: "T",
			body: "B",
			severity: "warning",
		});
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});
