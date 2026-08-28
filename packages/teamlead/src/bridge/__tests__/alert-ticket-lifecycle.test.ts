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

function stubBot(
	outcome: "attempted" | "needs_human" | "no_action",
): AutoRepairBot {
	return {
		canAttempt: () => outcome !== "needs_human",
		attempt: vi.fn(async () => ({
			outcome,
			action: outcome === "attempted" ? "safe_repair" : "none",
			detail:
				outcome === "attempted" ? "🔧 已尝试安全修复。" : "no safe repair",
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

	it("thread registration copy names the ticket, not Cass", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_threadId, content) => {
			posts.push(content);
		};
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		expect(posts[0]).toContain("🔧 已登记（Lead pane frozen）");
		expect(posts[0]).not.toContain("Cass");
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

	it("needs_human stays NEW with no repair status, post, or root edit", async () => {
		const discord = makeDiscord();
		const posts: Array<{ content: string; mention?: string }> = [];
		discord.postToThread = async (_threadId, content, opts) => {
			posts.push({ content, mention: opts?.mentionUserId });
		};
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("needs_human"),
		});
		await hub.handle(payload());
		const row = store.getActiveAlertThread(CK);
		expect(row?.ticket_status).toBe("NEW");
		expect(row?.repair_status).toBeNull();
		expect(posts).toHaveLength(1); // ack only
		expect(posts[0]?.mention).toBeUndefined();
		expect(discord.edits).toHaveLength(0);
	});

	it("no_action → MONITORING without founder mention or attempt consumption", async () => {
		const discord = makeDiscord();
		const posts: Array<{ content: string; mention?: string }> = [];
		discord.postToThread = async (_threadId, content, opts) => {
			posts.push({ content, mention: opts?.mentionUserId });
		};
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("no_action"),
		});

		await hub.handle(payload());

		const row = store.getActiveAlertThread(CK);
		expect(row?.repair_status).toBe("no_action");
		expect(row?.ticket_status).toBe("MONITORING");
		expect(row?.attempt_count).toBe(0);
		expect(posts.every((post) => post.mention === undefined)).toBe(true);
		expect(posts.some((post) => post.content.includes("修不了"))).toBe(false);
		expect(discord.edits[0]![2]).toContain("· 状态 MONITORING");
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

	it("legacy resolve keeps its pre-existing unfenced store calls", async () => {
		const discord = makeDiscord();
		const setTicketStatus = vi.spyOn(store, "setTicketStatus");
		const resolveAlertThread = vi.spyOn(store, "resolveAlertThread");
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());

		await expect(hub.resolve(CK)).resolves.toBeUndefined();

		expect(setTicketStatus).toHaveBeenCalledWith(CK, "RESOLVED");
		expect(resolveAlertThread).toHaveBeenCalledWith(CK);
	});

	it("episode-fenced resolve rejects a replacement before any Discord effect", async () => {
		const discord = makeDiscord();
		const getMessage = vi.spyOn(discord, "getMessage");
		const editMessage = vi.spyOn(discord, "editMessage");
		const postToThread = vi.spyOn(discord, "postToThread");
		const archiveThread = vi.spyOn(discord, "archiveThread");
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		store.openAlertThread({
			correlationKey: CK,
			eventId: "evt-2",
			threadId: "thread-2",
			rootMessageId: "root-2",
			channelId: "UNI",
			leadId: "tadashi",
			projectName: "flywheel",
			eventType: "pane_hash_stuck",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		getMessage.mockClear();
		editMessage.mockClear();
		postToThread.mockClear();
		archiveThread.mockClear();

		await expect(hub.resolve(CK, "evt-1")).rejects.toThrow("stale_episode");
		expect(getMessage).not.toHaveBeenCalled();
		expect(editMessage).not.toHaveBeenCalled();
		expect(postToThread).not.toHaveBeenCalled();
		expect(archiveThread).not.toHaveBeenCalled();
		expect(store.getActiveAlertThread(CK)?.event_id).toBe("evt-2");
	});

	it("episode-fenced resolve rejects a replacement created during Discord effects", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		discord.archiveThread = async () => {
			store.openAlertThread({
				correlationKey: CK,
				eventId: "evt-2",
				threadId: "thread-2",
				rootMessageId: "root-2",
				channelId: "UNI",
				leadId: "tadashi",
				projectName: "flywheel",
				eventType: "pane_hash_stuck",
				ticketStatus: "NEW",
				ownerRef: "infra_bot:claude",
			});
		};

		await expect(hub.resolve(CK, "evt-1")).rejects.toThrow("stale_episode");
		expect(store.getActiveAlertThread(CK)).toEqual(
			expect.objectContaining({
				event_id: "evt-2",
				ticket_status: "NEW",
				resolved_at: null,
			}),
		);
	});

	it("episode-fenced resolve is idempotent when ARC resolves the same episode", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		discord.archiveThread = async () => {
			store.setTicketStatus(CK, "RESOLVED", "evt-1");
			store.resolveAlertThread(CK, "evt-1");
		};

		await expect(hub.resolve(CK, "evt-1")).resolves.toBeUndefined();
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				ticket_status: "RESOLVED",
				resolved_at: expect.any(String),
			}),
		);
	});

	it("duty handoff re-renders only the ticket owner and status segments", async () => {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
		});
		await hub.handle(payload());
		store.handoffTicket(CK, "evt-1", "lead:flywheel-eng-lead");
		const row = store.getActiveAlertThread(CK);
		expect(row).toBeDefined();
		await hub.renderTicketLine(row!, "<@222222222222222222>");

		const rendered = discord.edits.at(-1)?.[2];
		expect(rendered).toContain("owner <@222222222222222222>");
		expect(rendered).toContain("· 状态 ESCALATED");
		expect(rendered).toContain("Lead pane frozen");
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
// FLY-2075: reconcile keeps exhausted tickets visible and retries safely.
// ─────────────────────────────────────────────────────────────────────────
describe("FLY-2075 Hub bounded retry (reconcile pass)", () => {
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

	function makeHub(discord: DiscordOps) {
		return new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			// capturePane absent → lead recovery pass skipped → ticket pass runs
		});
	}

	it("expired REPAIRING ticket stays visible without posts or root edits", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_t: string, content: string) => {
			posts.push(content);
		};
		const hub = makeHub(discord);
		openAgedTicket();
		await hub.reconcile();
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("REPAIRING");
		expect(posts).toHaveLength(0);
		expect(discord.edits).toHaveLength(0);
	});

	it("issue binding does not create an automatic escalation side effect", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_t: string, content: string) => {
			posts.push(content);
		};
		const hub = makeHub(discord);
		openAgedTicket({ sessionKey: "exec-9" });
		await hub.reconcile();
		expect(posts).toHaveLength(0);
		expect(store.getActiveAlertThread(CK)?.ticket_status).toBe("REPAIRING");
	});

	it("one production-shaped safety-gate rejection consumes the remaining retry budget", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_threadId, content) => {
			posts.push(content);
		};
		const bot = stubBot("needs_human");
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
		store.bumpTicketAttempt(CK); // enqueue-time attempted repair already ran

		await hub.reconcile();
		await hub.reconcile();
		await hub.reconcile();

		const row = store.getActiveAlertThread(CK);
		expect(row?.attempt_count).toBe(2);
		expect(row?.ticket_status).toBe("REPAIRING");
		expect(row?.repair_status).toBe("n/a");
		expect(posts.filter((post) => post.includes("安全闸拒绝"))).toHaveLength(1);
		expect(posts.every((post) => !post.includes("<@"))).toBe(true);
	});

	it("a refused retry clears stale Cass credit before later recovery", async () => {
		const discord = makeDiscord();
		const posts: string[] = [];
		discord.postToThread = async (_threadId, content) => {
			posts.push(content);
		};
		const recent = new Date(Date.now() - 30_000)
			.toISOString()
			.replace("T", " ")
			.slice(0, 19);
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: async () => ({ ...SENT }) },
			discord,
			autoRepairBot: stubBot("needs_human"),
		});
		openAgedTicket({ firstSeenAt: recent });
		store.setAlertRepairStatus(CK, "attempted");
		store.bumpTicketAttempt(CK);

		await hub.reconcile();
		await hub.resolve(CK);

		const resolved = posts.find((post) => post.includes("已恢复"));
		expect(resolved).toContain("自行恢复");
		expect(resolved).not.toContain("Cass 自动修复");
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

	it("retry no_action → MONITORING without consuming the remaining attempt", async () => {
		const discord = makeDiscord();
		const posts: Array<{ content: string; mention?: string }> = [];
		discord.postToThread = async (_threadId, content, opts) => {
			posts.push({ content, mention: opts?.mentionUserId });
		};
		const bot = stubBot("no_action");
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
		expect(row?.repair_status).toBe("no_action");
		expect(row?.ticket_status).toBe("MONITORING");
		expect(row?.attempt_count).toBe(1);
		expect(posts.every((post) => post.mention === undefined)).toBe(true);
		expect(posts.some((post) => post.content.includes("安全闸拒绝"))).toBe(
			false,
		);
		expect(discord.edits[0]![2]).toContain("· 状态 MONITORING");
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
