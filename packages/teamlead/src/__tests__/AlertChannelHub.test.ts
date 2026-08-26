/**
 * FLY-368: AlertChannelHub — per-error threading, degradation, recovery resolve,
 * and the restart-safe reconcile pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AlertChannelHub,
	correlationKeyFor,
	createDiscordOps,
	type DiscordOps,
} from "../bridge/AlertChannelHub.js";
import { makeChannelArchiveDefaultProvider } from "../bridge/roundtable/channel-archive-default.js";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { StateStore } from "../StateStore.js";

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "tadashi",
		projectName: "flywheel",
		eventId: "evt-1",
		eventType: "pane_hash_stuck",
		title: "Lead pane frozen",
		body: "b",
		severity: "warning",
		...over,
	};
}

// FLY-368 v1.58.0 (Codex LOW-3): posts capture the 3rd arg (opts) too — the mention
// safety contract now lives partly there (needs_human → { mentionUserId }; ack /
// attempted / resolved → none).
type PostTuple = [string, string, { mentionUserId?: string } | undefined];

function makeDiscord(_opts: { postOk?: boolean } = {}): DiscordOps & {
	created: string[];
	createdArchiveMinutes: Array<number | undefined>;
	posts: PostTuple[];
	archived: string[];
} {
	const created: string[] = [];
	const createdArchiveMinutes: Array<number | undefined> = [];
	const posts: PostTuple[] = [];
	const archived: string[] = [];
	let n = 0;
	return {
		created,
		createdArchiveMinutes,
		posts,
		archived,
		async createThreadFromMessage(_c, _m, name, archiveMinutes) {
			const id = `thread-${++n}`;
			created.push(name);
			createdArchiveMinutes.push(archiveMinutes);
			return id;
		},
		async postToThread(threadId, content, opts) {
			posts.push([threadId, content, opts]);
		},
		async archiveThread(threadId) {
			archived.push(threadId);
		},
	};
}

const SENT: AlertResult = Object.freeze({
	sent: true,
	channelId: "UNI",
	messageId: "root-1",
});

describe("AlertChannelHub (FLY-368)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("first alert opens a thread + posts ack (no bot)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });

		await hub.handle(payload());

		expect(discord.created).toHaveLength(1);
		expect(discord.posts[0]![1]).toContain("收到");
		const row = store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|");
		expect(row?.thread_id).toBe("thread-1");
	});

	it("FLY-802: passes the parent channel's archive default into thread creation", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			archiveDefaultProvider: async () => 60,
		});

		await hub.handle(payload());

		expect(discord.createdArchiveMinutes).toEqual([60]);
	});

	it.each([
		["null", async () => null],
		[
			"rejection",
			async () => {
				throw new Error("lookup failed");
			},
		],
	] as const)(
		"FLY-802: %s provider falls back to 1440 without degrading to root-only",
		async (_case, archiveDefaultProvider) => {
			const discord = makeDiscord();
			const logs: string[] = [];
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				archiveDefaultProvider,
				logger: (message) => logs.push(message),
			});

			await hub.handle(payload());

			expect(discord.createdArchiveMinutes).toEqual([1440]);
			expect(
				store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|")
					?.thread_id,
			).toBe("thread-1");
			if (_case === "rejection") {
				expect(
					logs.some((message) => message.includes("archive default")),
				).toBe(true);
			}
		},
	);

	it("FLY-802: one Hub reuses a cached parent lookup across consecutive alert threads", async () => {
		const discord = makeDiscord();
		const channelReads: string[] = [];
		const archiveDefaultProvider = makeChannelArchiveDefaultProvider({
			channelId: "UNI",
			botToken: "token",
			fetchImpl: vi.fn(async (url: string) => {
				channelReads.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({ default_auto_archive_duration: 60 }),
				} as Response;
			}) as typeof fetch,
		});
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			archiveDefaultProvider,
		});

		await hub.handle(payload({ eventId: "evt-1" }));
		await hub.handle(payload({ eventId: "evt-2" }));

		expect(channelReads).toHaveLength(1);
		expect(discord.createdArchiveMinutes).toEqual([60, 60]);
	});

	it("same event_id duplicate does NOT open a second thread", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		await hub.handle(payload()); // same eventId, same SENT result
		expect(discord.created).toHaveLength(1);
	});

	it("a DIFFERENT event_id under the same correlation key resolves the stale thread and opens a new one", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload({ eventId: "evt-1" }));
		await hub.handle(payload({ eventId: "evt-2" }));
		expect(discord.created).toHaveLength(2);
		expect(discord.archived).toContain("thread-1"); // stale archived
		const row = store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|");
		expect(row?.event_id).toBe("evt-2");
		expect(row?.thread_id).toBe("thread-2");
		// FLY-368 v1.58.0 (Codex LOW-4): the stale-replacement post is NOT a recovery
		// — it must never claim the broke→fixed timeline ("已恢复"/"修好"/"Cass 自动修复").
		const stalePost = discord.posts.find(([, c]) =>
			c.includes("取代为新 incident"),
		);
		expect(stalePost).toBeDefined();
		expect(stalePost![1]).not.toContain("已恢复");
		expect(stalePost![1]).not.toContain("修好");
		expect(stalePost![1]).not.toContain("Cass 自动修复");
	});

	it("queued result degrades to root-only (no thread)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ queued: true })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		expect(discord.created).toHaveLength(0);
	});

	it("duplicate (no active thread) degrades to root-only", async () => {
		const discord = makeDiscord();
		const notifier = {
			alert: vi.fn(async () => ({ skipped: "duplicate" as const })),
		};
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		expect(discord.created).toHaveLength(0);
	});

	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	] as const)(
		"informational %s direct delivery stays root-only",
		async (eventType) => {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({ store, notifier, discord });
			await hub.handle(payload({ eventType }));
			expect(discord.created).toHaveLength(0);
		},
	);

	it("runs the auto-repair bot and records its outcome when present", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const bot = {
			canAttempt: vi.fn(() => true),
			attempt: vi.fn(async () => ({
				outcome: "attempted" as const,
				action: "lead_resume_enter",
				detail: "🔧 attempted",
			})),
		};
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			autoRepairBot: bot as never,
		});
		await hub.handle(payload());
		expect(bot.attempt).toHaveBeenCalledTimes(1);
		expect(discord.posts.some(([, c]) => c === "🔧 attempted")).toBe(true);
		// "attempted" (a key was sent) — NOT "fixed". The ✅ resolve comes later from
		// the reconcile/onRecovery path, never from the bot (Codex code R1 MEDIUM-2).
		expect(
			store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|")
				?.repair_status,
		).toBe("attempted");
	});

	// ── FLY-368 v1.58.0: AUTO_REPAIR=ON wording + behavior rework ──

	function repairBot(outcome: "attempted" | "needs_human", canAttempt = true) {
		return {
			canAttempt: vi.fn(() => canAttempt),
			attempt: vi.fn(async () => ({
				outcome,
				action: outcome === "attempted" ? "lead_resume_enter" : "none",
				detail:
					outcome === "attempted"
						? "🔧 已对 resume 菜单发送 Enter 解卡。"
						: "API rate limit 触顶，账户类不自动修。",
			})),
		} as never;
	}

	it("ack says '正在尝试自动修复' only for a repairable kind", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			autoRepairBot: repairBot("attempted", true),
		});
		await hub.handle(payload({ eventType: "pane_hash_stuck" }));
		const ack = discord.posts[0]![1];
		expect(ack).toContain("收到");
		expect(ack).toContain("正在尝试自动修复");
	});

	it("ack does NOT claim '正在尝试' for a non-repairable kind", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			autoRepairBot: repairBot("needs_human", false),
		});
		await hub.handle(payload({ eventType: "rate_limit", eventId: "rl" }));
		const ack = discord.posts[0]![1];
		expect(ack).toContain("收到");
		expect(ack).not.toContain("正在尝试");
	});

	it("needs_human never @-pings the founder even when the env id is set", async () => {
		const prev = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
		process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = "1138241636057481306";
		try {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				autoRepairBot: repairBot("needs_human", false),
			});
			await hub.handle(payload({ eventType: "rate_limit", eventId: "rl" }));
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
			expect(
				discord.posts.every(([, c]) => !c.includes("<@1138241636057481306>")),
			).toBe(true);
			expect(
				discord.posts.every(([, , opts]) => opts?.mentionUserId === undefined),
			).toBe(true);
		} finally {
			if (prev === undefined)
				delete process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
			else process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = prev;
		}
	});

	it("needs_human stays silent when founder id is unset or invalid", async () => {
		const prev = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
		process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = "not-a-snowflake";
		try {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				autoRepairBot: repairBot("needs_human", false),
			});
			await hub.handle(payload({ eventType: "rate_limit", eventId: "rl" }));
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
			expect(discord.posts.every(([, c]) => !c.includes("<@"))).toBe(true);
		} finally {
			if (prev === undefined)
				delete process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
			else process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = prev;
		}
	});

	it("attempted result line NEVER pings (no mentionUserId)", async () => {
		const prev = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
		process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = "1138241636057481306";
		try {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				autoRepairBot: repairBot("attempted", true),
			});
			await hub.handle(payload({ eventType: "pane_hash_stuck" }));
			for (const [, , opts] of discord.posts) {
				expect(opts?.mentionUserId).toBeUndefined();
			}
		} finally {
			if (prev === undefined)
				delete process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID;
			else process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = prev;
		}
	});

	// FLY-871 R2/W6: the account_switch enqueue IS the Codex Infra Bot's
	// ASSIGNMENT — @-mention the infra bot so the FLY-267 mention-gate wakes it.
	function accountSwitchBot() {
		return {
			canAttempt: vi.fn(() => true),
			attempt: vi.fn(async () => ({
				outcome: "attempted" as const,
				action: "account_switch",
				detail: "🔧 已排队账号切换，等待 Infra Bot 认领。",
			})),
		} as never;
	}

	it("W6: account_switch assignment @-pings the infra bot when the env id is set", async () => {
		const prev = process.env.FLYWHEEL_INFRA_BOT_USER_ID;
		process.env.FLYWHEEL_INFRA_BOT_USER_ID = "1200000000000000009";
		try {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				autoRepairBot: accountSwitchBot(),
			});
			await hub.handle(payload({ eventType: "usage_limit", eventId: "cap" }));
			const assign = discord.posts.find(([, c]) => c.includes("认领"));
			expect(assign).toBeDefined();
			expect(assign![2]).toEqual({ mentionUserId: "1200000000000000009" });
		} finally {
			if (prev === undefined) delete process.env.FLYWHEEL_INFRA_BOT_USER_ID;
			else process.env.FLYWHEEL_INFRA_BOT_USER_ID = prev;
		}
	});

	it("W6 byte-compat: no infra-bot env ⇒ the account_switch post never pings", async () => {
		const prev = process.env.FLYWHEEL_INFRA_BOT_USER_ID;
		delete process.env.FLYWHEEL_INFRA_BOT_USER_ID;
		try {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				autoRepairBot: accountSwitchBot(),
			});
			await hub.handle(payload({ eventType: "usage_limit", eventId: "cap" }));
			for (const [, , opts] of discord.posts) {
				expect(opts?.mentionUserId).toBeUndefined();
			}
		} finally {
			if (prev !== undefined) process.env.FLYWHEEL_INFRA_BOT_USER_ID = prev;
		}
	});

	it("OFF path (no bot) ack is honest — no '等待人工'", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		const ack = discord.posts[0]![1];
		expect(ack).toContain("收到");
		expect(ack).toContain("自动修复未启用");
		expect(ack).not.toContain("等待人工");
	});

	it("resolve attributes 'Cass 自动修复' + broke→fixed timeline when Cass acted", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			autoRepairBot: repairBot("attempted", true),
		});
		await hub.handle(payload({ eventType: "pane_hash_stuck" }));
		await hub.resolve("flywheel|tadashi|pane_hash_stuck|");
		const resolved = discord.posts.find(([, c]) => c.includes("已恢复"));
		expect(resolved).toBeDefined();
		expect(resolved![1]).toContain("报警");
		expect(resolved![1]).toContain("Cass 自动修复");
		expect(resolved![1]).toMatch(/\d\d:\d\d/);
	});

	it("resolve does NOT credit Cass on self-heal (no bot / no attempt)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		await hub.resolve("flywheel|tadashi|pane_hash_stuck|");
		const resolved = discord.posts.find(([, c]) => c.includes("已恢复"));
		expect(resolved).toBeDefined();
		expect(resolved![1]).not.toContain("Cass 自动修复");
	});

	it("resolve posts recovered + archives + marks resolved", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		await hub.resolve("flywheel|tadashi|pane_hash_stuck|");
		expect(discord.posts.some(([, c]) => c.includes("已恢复"))).toBe(true);
		expect(discord.archived).toContain("thread-1");
		expect(
			store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|"),
		).toBeUndefined();
	});

	it("reconcile resolves a Lead alert when the pane no longer shows the kind (restart-safe)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		// Round 1: open a rate_limit thread.
		const hub1 = new AlertChannelHub({ store, notifier, discord });
		await hub1.handle(payload({ eventType: "rate_limit", eventId: "evt-rl" }));
		const ck = "flywheel|tadashi|rate_limit|";
		expect(store.getActiveAlertThread(ck)).toBeDefined();

		// Simulate a Bridge restart: a FRESH Hub (empty in-memory state) reconciles
		// from the durable alert_threads row. Pane is now healthy → resolve.
		const hub2 = new AlertChannelHub({
			store,
			notifier,
			discord,
			capturePane: async () => "all good now, idle\n",
		});
		await hub2.reconcile();
		expect(store.getActiveAlertThread(ck)).toBeUndefined();
	});

	it("legacy runner-stuck rows stay inert during reconcile", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const captureRunner = vi.fn(async () => "runner moved");
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			captureRunner,
		});
		const ck = "flywheel|tadashi|runner_stuck_unhandled|exec-7";
		store.openAlertThread({
			correlationKey: ck,
			eventId: "evt-rs",
			episodeSignature: "aaaaaaaaaaaaaaaa",
			threadId: "thread-rs",
			channelId: "UNI",
			leadId: "tadashi",
			projectName: "flywheel",
			eventType: "runner_stuck_unhandled",
			sessionKey: "exec-7",
		});

		await hub.reconcile();

		expect(store.getActiveAlertThread(ck)?.ticket_status).toBeNull();
		expect(captureRunner).not.toHaveBeenCalled();
		expect(discord.posts).toHaveLength(0);
	});

	it("ticketed legacy runner-stuck rows stay NEW without automatic escalation", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
		const captureRunner = vi.fn(async () => "runner moved");
		const previousBotId = process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID;
		process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = "111111111111111111";
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			captureRunner,
		});
		const ck = "flywheel|tadashi|runner_stuck_unhandled|exec-8";
		store.openAlertThread({
			correlationKey: ck,
			eventId: "evt-rs2",
			threadId: "thread-rs2",
			channelId: "UNI",
			leadId: "tadashi",
			projectName: "flywheel",
			eventType: "runner_stuck_unhandled",
			sessionKey: "exec-8",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
			firstSeenAt: "2020-01-01 00:00:00",
		});
		try {
			await hub.reconcile();
		} finally {
			if (previousBotId === undefined) {
				delete process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID;
			} else {
				process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = previousBotId;
			}
		}

		expect(store.getActiveAlertThread(ck)?.ticket_status).toBe("NEW");
		expect(captureRunner).not.toHaveBeenCalled();
		expect(discord.posts).toHaveLength(0);
	});

	// ── FLY-929 A5: Claude account-cap needs_human → owner-bot assignment ──
	//
	// When self-heal + P-identity + the infra bot id are ALL present, a
	// usage_limit alert carrying CLAUDE accountLimit metadata routes its
	// needs_human may post a pure assignment to the OWNER BOT. Any env missing
	// or any other kind stays NEW without an automatic founder escalation.
	describe("FLY-929 A5 account-cap owner routing", () => {
		const A5_ENV = {
			FLYWHEEL_ACCOUNT_SELF_HEAL: "1",
			CLAUDE_INFRA_BOT_TOKEN: "infra-token",
			FLYWHEEL_NOTIFY_CHANNEL: "1521630422918758472",
			FLYWHEEL_INFRA_BOT_USER_ID: "152321932456152283",
			FLYWHEEL_FOUNDER_DISCORD_USER_ID: "113824163605748130",
		} as const;
		let saved: Record<string, string | undefined>;
		beforeEach(() => {
			saved = {};
			for (const k of Object.keys(A5_ENV)) {
				saved[k] = process.env[k];
			}
		});
		afterEach(() => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});
		function setEnv(omit: string[] = []) {
			for (const [k, v] of Object.entries(A5_ENV)) {
				if (omit.includes(k)) delete process.env[k];
				else process.env[k] = v;
			}
		}
		function capPayload(
			provider: "claude" | "codex" = "claude",
			over: Partial<AlertPayload> = {},
		): AlertPayload {
			return payload({
				eventType: "usage_limit",
				eventId: `cap-${provider}`,
				metadata: {
					accountLimit: {
						provider,
						scope: "5h",
						resetAt: "2026-07-08T02:00:00Z",
						observedAccount: "personal",
						observedGeneration: 1,
					},
				},
				...over,
			});
		}
		async function run(p: AlertPayload) {
			const discord = makeDiscord();
			const notifier = { alert: vi.fn(async () => ({ ...SENT })) };
			const hub = new AlertChannelHub({
				store,
				notifier,
				discord,
				// not-attemptable shape: bot present but canAttempt=false → needs_human
				autoRepairBot: repairBot("needs_human", false),
			});
			await hub.handle(p);
			return discord;
		}

		it("all envs present + claude cap → owner-bot assignment mention, NO founder escalation", async () => {
			setEnv();
			const discord = await run(capPayload("claude"));
			const assignment = discord.posts.find(([, c]) => c.includes("请认领"));
			expect(assignment).toBeDefined();
			expect(assignment![1]).toContain(
				`<@${A5_ENV.FLYWHEEL_INFRA_BOT_USER_ID}>`,
			);
			expect(assignment![1]).not.toContain("T2");
			expect(assignment![2]).toEqual({
				mentionUserId: A5_ENV.FLYWHEEL_INFRA_BOT_USER_ID,
			});
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		it("P-identity incomplete (no notify channel) → no automatic post", async () => {
			setEnv(["FLYWHEEL_NOTIFY_CHANNEL"]);
			const discord = await run(capPayload("claude"));
			expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL no longer gates A5 owner routing
		// (resolveAccountCapOwnerId drops that conjunct). Rewritten to cover the
		// other half of P-identity absence not exercised below ("no notify
		// channel" already covers a missing channel) — a missing infra bot
		// token → no owner assignment and no automatic founder post.
		it("P-identity incomplete (no infra bot token) → no automatic post", async () => {
			setEnv(["CLAUDE_INFRA_BOT_TOKEN"]);
			const discord = await run(capPayload("claude"));
			expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		it("missing infra bot user id → no automatic post", async () => {
			setEnv(["FLYWHEEL_INFRA_BOT_USER_ID"]);
			const discord = await run(capPayload("claude"));
			expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		it("usage_limit without accountLimit metadata → no automatic post", async () => {
			setEnv();
			const discord = await run(
				payload({ eventType: "usage_limit", eventId: "no-meta" }),
			);
			expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		it("codex-provider accountLimit → no automatic post (Claude caps only)", async () => {
			setEnv();
			const discord = await run(capPayload("codex"));
			expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
			expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
		});

		it("other needs_human kinds stay NEW without an automatic post", async () => {
			setEnv();
			for (const eventType of ["rate_limit", "login_expired"] as const) {
				const discord = await run(
					payload({ eventType, eventId: `neg-${eventType}` }),
				);
				expect(discord.posts.some(([, c]) => c.includes("请认领"))).toBe(false);
				expect(discord.posts.some(([, c]) => c.includes("修不了"))).toBe(false);
			}
		});
	});
});

describe("createDiscordOps (FLY-368 rework: repair chain + allowed_mentions)", () => {
	it("posts thread messages with allowed_mentions {parse:[]}", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id: "t" }),
		})) as never;
		const ops = createDiscordOps(() => ["cass-tok"], fetchFn);
		await ops.postToThread("thread-1", "@everyone hi");
		const [url, init] = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		expect(url).toContain("/channels/thread-1/messages");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot cass-tok",
		);
		const body = JSON.parse(init.body as string);
		expect(body.content).toMatch(/^🤖\[自动\] /);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("posts with allowed_mentions {users:[id]} when mentionUserId is given (FLY-368 v1.58.0)", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id: "t" }),
		})) as never;
		const ops = createDiscordOps(() => ["cass-tok"], fetchFn);
		await ops.postToThread("thread-1", "<@123> needs you", {
			mentionUserId: "123",
		});
		const [, init] = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		const body = JSON.parse(init.body as string);
		expect(body.content).toMatch(/^🤖\[自动\] /);
		expect(body.allowed_mentions).toEqual({ users: ["123"] });
	});

	it("falls through 401/403/404 to the next repair-chain bot", async () => {
		const fetchFn = vi
			.fn()
			// first bot (Cass) → 403 no perms; second bot → 200
			.mockResolvedValueOnce({ ok: false, status: 403 })
			.mockResolvedValueOnce({ ok: true, status: 200 }) as never;
		const ops = createDiscordOps(() => ["cass-tok", "alpha-tok"], fetchFn);
		await ops.postToThread("thread-1", "hi");
		const calls = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls;
		expect(calls).toHaveLength(2);
		expect((calls[1]![1].headers as Record<string, string>).Authorization).toBe(
			"Bot alpha-tok",
		);
	});

	it("createThreadFromMessage tries first usable bot, returns its thread id", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id: "new-thread" }),
		})) as never;
		const ops = createDiscordOps(() => ["cass-tok"], fetchFn);
		expect(await ops.createThreadFromMessage("ch", "msg", "name")).toBe(
			"new-thread",
		);
		const [, init] = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		expect(JSON.parse(String(init.body)).auto_archive_duration).toBe(1440);
	});

	it("FLY-802: createThreadFromMessage accepts a resolved archive duration", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id: "new-thread" }),
		})) as never;
		const ops = createDiscordOps(() => ["cass-tok"], fetchFn);

		await ops.createThreadFromMessage("ch", "msg", "name", 60);

		const [, init] = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		expect(JSON.parse(String(init.body)).auto_archive_duration).toBe(60);
	});
});

// FLY-1929: the voucher guard deliberately ships ONE kind (host_voucher_incident)
// carrying two sources (occupancy pressure + kernel-panic recurrence), because
// neither has an executable remediation and a second kind would make
// KIND_CONTRACTS claim an ARC difference that does not exist.
//
// This test pins the CONSEQUENCE of that choice so it is a recorded decision
// rather than a surprise: queued warn/severe/panic events share one correlation
// key, so the newest voucher event replaces the previous voucher ticket thread.
// Root-channel alerts stay distinct because their event ids differ (severity and
// source are encoded in the signature + body).
describe("FLY-1929 single-kind correlation consequence", () => {
	it("queued voucher events share one correlation key (latest replaces the prior thread)", () => {
		const base = {
			projectName: "flywheel",
			leadId: "system",
			eventType: "host_voucher_incident",
		};
		const warnKey = correlationKeyFor(base);
		const severeKey = correlationKeyFor(base);
		const panicKey = correlationKeyFor(base);

		// Shell-emitted queue records carry no sessionKey, so all three collapse.
		expect(warnKey).toBe(severeKey);
		expect(severeKey).toBe(panicKey);
		expect(warnKey).toBe("flywheel|system|host_voucher_incident|");

		// A different kind must NOT collide with it.
		expect(
			correlationKeyFor({ ...base, eventType: "swap_pressure_high" }),
		).not.toBe(warnKey);
	});
});
