/**
 * FLY-368: AlertChannelHub — per-error threading, degradation, recovery resolve,
 * and the restart-safe reconcile pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AlertChannelHub,
	createDiscordOps,
	type DiscordOps,
} from "../bridge/AlertChannelHub.js";
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

function makeDiscord(): DiscordOps & {
	created: string[];
	posts: Array<[string, string]>;
	archived: string[];
} {
	const created: string[] = [];
	const posts: Array<[string, string]> = [];
	const archived: string[] = [];
	let n = 0;
	return {
		created,
		posts,
		archived,
		async createThreadFromMessage(_c, _m, name) {
			const id = `thread-${++n}`;
			created.push(name);
			return id;
		},
		async postToThread(threadId, content) {
			posts.push([threadId, content]);
		},
		async archiveThread(threadId) {
			archived.push(threadId);
		},
	};
}

const SENT: AlertResult = {
	sent: true,
	channelId: "UNI",
	messageId: "root-1",
};

describe("AlertChannelHub (FLY-368)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("first alert opens a thread + posts ack (no bot)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const hub = new AlertChannelHub({ store, notifier, discord });

		await hub.handle(payload());

		expect(discord.created).toHaveLength(1);
		expect(discord.posts[0]![1]).toContain("收到");
		const row = store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|");
		expect(row?.thread_id).toBe("thread-1");
	});

	it("same event_id duplicate does NOT open a second thread", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		await hub.handle(payload()); // same eventId, same SENT result
		expect(discord.created).toHaveLength(1);
	});

	it("a DIFFERENT event_id under the same correlation key resolves the stale thread and opens a new one", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload({ eventId: "evt-1" }));
		await hub.handle(payload({ eventId: "evt-2" }));
		expect(discord.created).toHaveLength(2);
		expect(discord.archived).toContain("thread-1"); // stale archived
		const row = store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|");
		expect(row?.event_id).toBe("evt-2");
		expect(row?.thread_id).toBe("thread-2");
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

	it("runs the auto-repair bot and records its outcome when present", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const bot = {
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

	it("onLeadRecovery posts recovered + archives + marks resolved", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const hub = new AlertChannelHub({ store, notifier, discord });
		await hub.handle(payload());
		await hub.onLeadRecovery("flywheel", "tadashi", "pane_hash_stuck");
		expect(discord.posts.some(([, c]) => c.includes("已恢复"))).toBe(true);
		expect(discord.archived).toContain("thread-1");
		expect(
			store.getActiveAlertThread("flywheel|tadashi|pane_hash_stuck|"),
		).toBeUndefined();
	});

	it("reconcile resolves a Lead alert when the pane no longer shows the kind (restart-safe)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
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

	it("reconcile does NOT resolve a still-frozen pane_hash_stuck on the first pass (two-capture rule)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		const frozen = "frozen pane no markers and no idle hint\n";
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			capturePane: async () => frozen,
		});
		await hub.handle(
			payload({ eventType: "pane_hash_stuck", eventId: "evt-f" }),
		);
		const ck = "flywheel|tadashi|pane_hash_stuck|";
		await hub.reconcile(); // first pass: record hash, do NOT resolve
		expect(store.getActiveAlertThread(ck)).toBeDefined();
	});

	it("reconcile resolves a RUNNER alert when the terminal advanced while session stays running (Codex HIGH-1)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		store.upsertSession({
			execution_id: "exec-7",
			issue_id: "FLY-9",
			project_name: "flywheel",
			status: "running",
		});
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			// runner moved on: live fingerprint differs from the stuck signature.
			captureRunner: async () => "runner is making progress again now\n",
		});
		await hub.handle(
			payload({
				eventType: "runner_stuck_unhandled",
				eventId: "evt-rs",
				sessionKey: "exec-7",
				metadata: {
					runnerStuck: {
						executionId: "exec-7",
						episodeFingerprint: "aaaaaaaaaaaaaaaa",
					},
				},
			}),
		);
		const ck = "flywheel|tadashi|runner_stuck_unhandled|exec-7";
		expect(store.getActiveAlertThread(ck)).toBeDefined();
		await hub.reconcile(); // session still running, but fingerprint changed → resolve
		expect(store.getActiveAlertThread(ck)).toBeUndefined();
		expect(discord.posts.some(([, c]) => c.includes("已恢复"))).toBe(true);
	});

	it("reconcile does NOT resolve a runner alert when capture is unavailable (fail-closed)", async () => {
		const discord = makeDiscord();
		const notifier = { alert: vi.fn(async () => SENT) };
		store.upsertSession({
			execution_id: "exec-8",
			issue_id: "FLY-9",
			project_name: "flywheel",
			status: "running",
		});
		const hub = new AlertChannelHub({
			store,
			notifier,
			discord,
			captureRunner: async () => null, // cannot tell
		});
		await hub.handle(
			payload({
				eventType: "runner_stuck_unhandled",
				eventId: "evt-rs2",
				sessionKey: "exec-8",
				metadata: {
					runnerStuck: {
						executionId: "exec-8",
						episodeFingerprint: "bbbbbbbbbbbbbbbb",
					},
				},
			}),
		);
		const ck = "flywheel|tadashi|runner_stuck_unhandled|exec-8";
		await hub.reconcile();
		expect(store.getActiveAlertThread(ck)).toBeDefined(); // stays active
	});
});

describe("createDiscordOps (FLY-368 allowed_mentions safety)", () => {
	it("posts thread messages with allowed_mentions {parse:[]}", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			json: async () => ({ id: "t" }),
		})) as never;
		const ops = createDiscordOps("tok", fetchFn);
		await ops.postToThread("thread-1", "@everyone hi");
		const [, init] = (
			fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		const body = JSON.parse(init.body as string);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});
});
