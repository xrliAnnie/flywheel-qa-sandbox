/**
 * FLY-927 (Task 2.3): Hub-side ticket lifecycle — seed at open, status
 * transitions on attempt outcomes, quiet RESOLVED on recovery, root 🎫
 * edit-in-place (best-effort degrade).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChannelHub, type DiscordOps } from "../AlertChannelHub.js";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";
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
		discord.messageContent = "⚠️ **Lead pane frozen** (tadashi / pane_hash_stuck)\nb";
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
