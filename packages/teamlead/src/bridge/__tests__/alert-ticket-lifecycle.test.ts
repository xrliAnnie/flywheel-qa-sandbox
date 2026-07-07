/**
 * FLY-927 (Task 2.3): Hub-side ticket lifecycle — seed at open, status
 * transitions on attempt outcomes, quiet RESOLVED on recovery, root 🎫
 * edit-in-place (best-effort degrade).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";
import { AlertChannelHub, type DiscordOps } from "../AlertChannelHub.js";
import type { AutoRepairBot } from "../AutoRepairBot.js";

const CK = "flywheel|tadashi|pane_hash_stuck|";
const ROOT_CONTENT = [
	"⚠️ **Lead pane frozen** (tadashi / pane_hash_stuck)",
	"🎫 flywheel · 首见 09:05 · owner <@111111111111111111> · 状态 NEW",
	"b",
].join("\n");

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "tadashi",
		projectName: "flywheel",
		eventId: "evt-1",
		eventType: "pane_hash_stuck",
		title: "Lead pane frozen",
		body: "b",
		severity: "warning",
		ticket: {
			ownerUserId: "111111111111111111",
			ownerLabel: "claude bot",
			status: "NEW",
			firstSeenMs: Date.UTC(2026, 6, 7, 9, 5),
			ownerRef: "infra_bot:claude",
		},
		...over,
	};
}

type EditTuple = [string, string, string];

function makeDiscord(): DiscordOps & {
	edits: EditTuple[];
	messageContent: string | null;
} {
	let n = 0;
	const self = {
		edits: [] as EditTuple[],
		messageContent: ROOT_CONTENT as string | null,
		async createThreadFromMessage() {
			return `thread-${++n}`;
		},
		async postToThread() {},
		async archiveThread() {},
		async getMessage() {
			return self.messageContent;
		},
		async editMessage(c: string, m: string, content: string) {
			self.edits.push([c, m, content]);
			return true;
		},
	};
	return self;
}

const SENT: AlertResult = Object.freeze({
	sent: true,
	channelId: "UNI",
	messageId: "root-1",
});

function stubBot(outcome: "attempted" | "needs_human"): AutoRepairBot {
	return {
		canAttempt: () => outcome === "attempted",
		attempt: vi.fn(async () => ({
			outcome,
			action: outcome === "attempted" ? "runner_nudge" : "none",
			detail: outcome === "attempted" ? "🔧 已 nudge。" : "no safe repair",
		})),
	} as unknown as AutoRepairBot;
}

describe("FLY-927 Hub ticket lifecycle", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("open seeds ticket columns from the enriched payload", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		const row = store.getActiveAlertThread(CK);
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.owner_ref).toBe("infra_bot:claude");
		expect(row?.first_seen_at).toBe("2026-07-07 09:05:00");
	});

	it("legacy payload (no ticket) keeps NULL ticket columns (byte-compat)", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload({ ticket: undefined }));
		const row = store.getActiveAlertThread(CK);
		expect(row?.ticket_status).toBeNull();
		expect(discord.edits).toHaveLength(0);
	});

	it("attempted repair → REPAIRING + one attempt + root 🎫 edited in place", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("attempted"),
		});
		await hub.handle(payload());
		const row = store.getActiveAlertThread(CK);
		expect(row?.ticket_status).toBe("REPAIRING");
		expect(row?.attempt_count).toBe(1);
		expect(discord.edits).toHaveLength(1);
		const [, , edited] = discord.edits[0]!;
		expect(edited).toContain("· 状态 REPAIRING");
		expect(edited).toContain("(tadashi / pane_hash_stuck)"); // first line intact
	});

	it("needs_human → ESCALATED + root edited", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("needs_human"),
		});
		await hub.handle(payload());
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("ESCALATED");
		expect(discord.edits[0]![2]).toContain("· 状态 ESCALATED");
	});

	it("resolve flips a ticket row to RESOLVED (quiet) + edits the root", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		await hub.resolve(CK);
		expect(discord.edits.some(([, , c]) => c.includes("· 状态 RESOLVED"))).toBe(
			true,
		);
		expect(store.getActiveAlertThread(CK)).toBeUndefined(); // resolved
	});

	it("edit degrade: root message unreadable → no edit, lifecycle still advances", async () => {
		const discord = makeDiscord();
		discord.messageContent = null; // GET fails
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("attempted"),
		});
		await hub.handle(payload());
		expect(discord.edits).toHaveLength(0);
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("REPAIRING");
	});

	it("edit degrade: legacy root without a 🎫 line is never rewritten", async () => {
		const discord = makeDiscord();
		discord.messageContent =
			"⚠️ **Lead pane frozen** (tadashi / pane_hash_stuck)\nb";
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("attempted"),
		});
		await hub.handle(payload());
		expect(discord.edits).toHaveLength(0);
	});

	it("DiscordOps WITHOUT edit methods (older impls) degrade silently", async () => {
		const discord = makeDiscord();
		const bare: DiscordOps = {
			createThreadFromMessage: discord.createThreadFromMessage,
			postToThread: discord.postToThread,
			archiveThread: discord.archiveThread,
		};
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord: bare,
			autoRepairBot: stubBot("attempted"),
		});
		await hub.handle(payload());
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("REPAIRING");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// FLY-927 (Task 2.4): reconcile-driven T2 escalation — two landing spots.
// ─────────────────────────────────────────────────────────────────────────
describe("FLY-927 Hub T2 escalation (reconcile pass)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function openAgedTicket(over: Record<string, unknown> = {}) {
		store.openAlertThread({
			correlationKey: CK,
			eventId: "evt-1",
			threadId: "t-1",
			rootMessageId: "root-1",
			channelId: "UNI",
			leadId: "tadashi",
			projectName: "flywheel",
			eventType: "pane_hash_stuck",
			ticketStatus: "REPAIRING",
			ownerRef: "infra_bot:claude",
			firstSeenAt: "2020-01-01 00:00:00", // ancient → past every window
			...over,
		});
	}

	function makeHub(
		discord: DiscordOps,
		escalate?: (row: unknown) => Promise<boolean>,
	) {
		return new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			// capturePane absent → lead recovery pass skipped → ticket pass runs
			escalateToIssueThread: escalate as never,
		});
	}

	it("expired REPAIRING ticket without an issue binding → needs_human @founder in the alert thread + ESCALATED", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_t: string, content: string) => {
			posts.push(content);
		};
		const hub = makeHub(discord);
		openAgedTicket();
		await hub.reconcile();
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("ESCALATED");
		expect(posts.some((p) => p.includes("修不掉(T2"))).toBe(true);
		expect(
			discord.edits.some(([, , c]) => c.includes("· 状态 ESCALATED")),
		).toBe(true);
	});

	it("issue-BOUND expired ticket → escalates via the issue-thread leg (no @founder in the alert thread)", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_t: string, content: string) => {
			posts.push(content);
		};
		const escalate = vi.fn(async () => true);
		const hub = makeHub(discord, escalate);
		openAgedTicket({ sessionKey: "exec-9" });
		await hub.reconcile();
		expect(escalate).toHaveBeenCalledTimes(1);
		expect(posts.some((p) => p.includes("已升级 founder"))).toBe(true);
		expect(posts.some((p) => p.includes("🙋"))).toBe(false);
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("ESCALATED");
	});

	it("REPAIRING under budget → one MORE gated attempt (bump), no escalation", async () => {
		const discord = makeDiscord();
		const bot = stubBot("attempted");
		const recent = new Date(Date.now() - 30_000)
			.toISOString()
			.replace("T", " ")
			.slice(0, 19);
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: bot,
		});
		openAgedTicket({ firstSeenAt: recent });
		store.bumpTicketAttempt(CK); // first attempt already consumed
		await hub.reconcile();
		const row = store.getActiveAlertThread(CK);
		expect(row?.attempt_count).toBe(2);
		expect(row?.ticket_status).toBe("REPAIRING");
		expect(bot.attempt).toHaveBeenCalledTimes(1);
	});

	it("legacy rows (NULL ticket_status) are untouched by the T2 pass", async () => {
		const discord = makeDiscord();
		const hub = makeHub(discord);
		store.openAlertThread({
			correlationKey: CK,
			eventId: "evt-1",
			threadId: "t-1",
			channelId: "UNI",
			leadId: "tadashi",
			projectName: "flywheel",
			eventType: "pane_hash_stuck",
		});
		await hub.reconcile();
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBeNull();
		expect(discord.edits).toHaveLength(0);
	});
});

describe("FLY-927 Codex R1 HIGH: drained root attaches thread + lifecycle", () => {
	it("attachThreadForDelivered opens the thread + seeds the ticket like the live path", async () => {
		const store = await StateStore.create(":memory:");
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.attachThreadForDelivered(payload(), "UNI", "drained-root-1");
		const row = store.getActiveAlertThread(CK);
		expect(row?.thread_id).toBe("thread-1");
		expect(row?.root_message_id).toBe("drained-root-1");
		expect(row?.ticket_status).toBe("NEW");
	});

	it("threading failure degrades silently (root-only), never throws", async () => {
		const store = await StateStore.create(":memory:");
		const discord = makeDiscord();
		discord.createThreadFromMessage = async () => null;
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.attachThreadForDelivered(payload(), "UNI", "drained-root-1");
		expect(store.getActiveAlertThread(CK)).toBeUndefined();
	});
});
