/**
 * FLY-1082 (Task 1.5): contract-driven by-design escalation in the Hub.
 *
 * `none_escalate` kinds (kind-contract) bypass the ARC retry loop entirely:
 * the ticket lands ESCALATED at open with the BY-DESIGN copy — never the
 * generic "repair failed" framing (the founder must read "设计上不自动修",
 * not "试修失败"). The legacy hardcoded special case
 * (runner_lead_pending_unhandled) is reproduced byte-for-byte through the
 * same contract path.
 */
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

function ticket(status: string): AlertTicketContext {
	return {
		ownerUserId: null,
		ownerLabel: "claude bot",
		status,
		firstSeenMs: Date.parse("2026-07-09T21:00:00Z"),
		ownerRef: "infra_bot:claude",
	};
}

describe("AlertChannelHub — FLY-1082 contract-driven escalate (Task 1.5)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("zombie_session_backlog: by-design copy, ESCALATED, ARC never invoked", async () => {
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
			ticket: ticket("ESCALATED"),
		};

		await hub.handle(payload);

		// The ARC retry loop is NEVER entered for a (b)-type kind.
		expect(attempt).not.toHaveBeenCalled();
		// The founder-facing line is the BY-DESIGN copy, not "repair failed".
		const escalateLine = discord.posts.find(([, c]) => c.includes("🙋"));
		expect(escalateLine).toBeDefined();
		expect(escalateLine![1]).toContain("设计上不自动收割");
		expect(escalateLine![1]).toContain("FLY-1066");
		expect(escalateLine![1]).not.toContain("试修失败");
		expect(escalateLine![1]).not.toContain("修不了");
		// Ticket lands ESCALATED; repair_status records needs_human.
		const row = store.getActiveAlertThread(
			"machine|machine|zombie_session_backlog|",
		);
		expect(row?.ticket_status).toBe("ESCALATED");
		expect(row?.repair_status).toBe("needs_human");
	});

	it("runner_lead_pending_unhandled: byte-identical legacy line through the contract path", async () => {
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

		// Legacy line, byte-for-byte (the reason is the AutoRepairBot's
		// HUMAN_ONLY_REASON string — sourced from the same map, not duplicated).
		const line = discord.posts.find(([, c]) => c.includes("🙋"));
		expect(line).toBeDefined();
		expect(line![1]).toBe(
			"🙋 Annie 这个 Cass 修不了，需要你：a runner is blocked waiting on the Lead to answer its question, and the Lead has not responded after several reminders — the Lead needs a human poke (the runner is fine; nothing to auto-repair).",
		);
		// Byte-compat also means the bot's attempt() outcome is identical — the
		// bypass simply avoids the no-op dispatch.
		expect(attempt).not.toHaveBeenCalled();
		const row = store.getActiveAlertThread(
			"flywheel|flywheel-eng-lead|runner_lead_pending_unhandled|",
		);
		expect(row?.repair_status).toBe("needs_human");
		// No ticket context → the ticket state machine is untouched (NULL).
		expect(row?.ticket_status).toBeNull();
	});

	it("zombie by-design escalation fires WITHOUT the auto-repair bot too (Codex R1 HIGH-4)", async () => {
		const discord = makeDiscord();
		const escalatedRows: string[] = [];
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			// NO autoRepairBot — FLYWHEEL_AUTO_REPAIR off.
			onTicketEscalated: async (row) => {
				escalatedRows.push(row.event_type);
			},
		});
		await hub.handle({
			leadId: "machine",
			projectName: "machine",
			eventId: "evt-z-nobot",
			eventType: "zombie_session_backlog",
			title: "跨 Lead 僵尸 session 积压",
			body: "3 zombies",
			severity: "warning",
			ticket: ticket("ESCALATED"),
		});
		// Founder-facing by-design line still posts; ticket lands ESCALATED;
		// the runbook-gap counter still fires.
		const line = discord.posts.find(([, c]) => c.includes("🙋"));
		expect(line).toBeDefined();
		expect(line![1]).toContain("设计上不自动收割");
		const row = store.getActiveAlertThread(
			"machine|machine|zombie_session_backlog|",
		);
		expect(row?.ticket_status).toBe("ESCALATED");
		expect(escalatedRows).toEqual(["zombie_session_backlog"]);
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
