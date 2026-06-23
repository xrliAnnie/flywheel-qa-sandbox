import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AlertPayload,
	findUnreachableAlertLeads,
	LeadAlertNotifier,
} from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geo",
		generalChannel: "core-channel-id",
		leads: [
			{
				agentId: "cos-lead",
				forumChannel: "forum-1",
				chatChannel: "chat-1",
				match: { labels: ["cos"] },
				botTokenEnv: "SIMBA_BOT_TOKEN",
				botToken: "resolved-bot-token",
				alertChannel: "1487340532610109520",
				alertBotTokenEnv: "SIMBA_BOT_TOKEN",
				alertFallbackToCore: true,
			},
			{
				agentId: "product-lead",
				forumChannel: "forum-2",
				chatChannel: "chat-2",
				match: { labels: ["Product"] },
				botTokenEnv: "PETER_BOT_TOKEN",
				botToken: "peter-token",
				alertFallbackToCore: true,
			},
			{
				agentId: "ops-lead",
				forumChannel: "forum-3",
				chatChannel: "chat-3",
				match: { labels: ["Ops"] },
			},
		],
	},
];

function buildPayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "cos-lead",
		projectName: "geoforge3d",
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		eventType: "pane_hash_stuck",
		title: "Lead silent pane",
		body: "Lead pane has not changed for 3 cycles",
		severity: "warning",
		...overrides,
	};
}

describe("LeadAlertNotifier", () => {
	let store: StateStore;
	let queueDir: string;
	let deadLetterDir: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly83-queue-"));
		deadLetterDir = mkdtempSync(join(tmpdir(), "fly182-dl-"));
	});

	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		rmSync(deadLetterDir, { recursive: true, force: true });
	});

	it("POSTs to alertChannel with resolved bot token and claims dedup row", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});
		const payload = buildPayload();

		const result = await notifier.alert(payload);

		expect(result).toEqual({ sent: true });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://discord.com/api/v10/channels/1487340532610109520/messages",
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot resolved-bot-token",
		);
		expect(typeof init.body).toBe("string");
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("Lead silent pane");
	});

	it("returns skipped=duplicate and does not POST on second call with same eventId", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});
		const payload = buildPayload({ eventId: "evt-fixed" });

		await notifier.alert(payload);
		const second = await notifier.alert(payload);

		expect(second).toEqual({ skipped: "duplicate" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("returns skipped=duplicate when shell already claimed via claims.db reader", async () => {
		const fetchFn = vi.fn();
		const payload = buildPayload({ eventId: "evt-shell-claimed" });
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			claimsReader: async () => new Set([payload.eventId]),
		});

		const result = await notifier.alert(payload);

		expect(result).toEqual({ skipped: "duplicate" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("Fix 2: atomic claimsClaimer wins → proceeds; loses → returns duplicate without POST", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		// Simulate a single shared row: first call wins, every later call loses.
		let claimed = false;
		const claimsClaimer = vi.fn(async () => {
			if (claimed) return false;
			claimed = true;
			return true;
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			claimsClaimer,
		});

		const a = await notifier.alert(buildPayload({ eventId: "evt-race-1" }));
		const b = await notifier.alert(buildPayload({ eventId: "evt-race-2" }));

		// First call: claimer returned true, Discord POST happened.
		expect(a).toEqual({ sent: true });
		// Second call: claimer returned false → skipped, no POST.
		expect(b).toEqual({ skipped: "duplicate" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(claimsClaimer).toHaveBeenCalledTimes(2);
	});

	it("Fix 2: claimsClaimer null (infra failure) falls through to Bridge-side dedup", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const claimsClaimer = vi.fn(async () => null); // sqlite3 broken
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			claimsClaimer,
		});

		const a = await notifier.alert(buildPayload({ eventId: "evt-fallback" }));
		const b = await notifier.alert(buildPayload({ eventId: "evt-fallback" }));

		// First call: posts (Bridge dedup is empty).
		expect(a).toEqual({ sent: true });
		// Second call: same eventId already in lead_events → Bridge dedup catches it.
		expect(b).toEqual({ skipped: "duplicate" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("falls back to project generalChannel when lead has alertFallbackToCore and no alertChannel", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});

		await notifier.alert(buildPayload({ leadId: "product-lead" }));

		const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://discord.com/api/v10/channels/core-channel-id/messages",
		);
	});

	it("FLY-182: no-channel is a PERMANENT failure → dead-letter + meta-alert, NOT queue", async () => {
		const fetchFn = vi.fn();
		const metaAlert = { notify: vi.fn().mockResolvedValue(undefined) };
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
			metaAlert,
		});

		const result = await notifier.alert(buildPayload({ leadId: "ops-lead" }));

		expect(result.skipped).toBe("no-channel");
		expect(result.deadLettered).toBe(true);
		expect(fetchFn).not.toHaveBeenCalled();
		// NOT queued (the 1667-backlog root cause) — dead-lettered instead.
		expect(readdirSync(queueDir).length).toBe(0);
		const dl = readdirSync(deadLetterDir);
		expect(dl.length).toBe(1);
		expect(
			JSON.parse(readFileSync(join(deadLetterDir, dl[0]!), "utf-8")).leadId,
		).toBe("ops-lead");
		// Meta-alert fired so the silent gap surfaces.
		expect(metaAlert.notify).toHaveBeenCalledTimes(1);
		expect(metaAlert.notify.mock.calls[0]![0].reason).toBe(
			"alert_dead_lettered",
		);
	});

	it("FLY-182: permanent Discord 4xx (e.g. 403) → dead-letter, not queue", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			text: async () => "missing access",
		});
		const metaAlert = { notify: vi.fn().mockResolvedValue(undefined) };
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
			metaAlert,
		});

		const result = await notifier.alert(buildPayload());
		expect(result.deadLettered).toBe(true);
		expect(readdirSync(queueDir).length).toBe(0);
		expect(readdirSync(deadLetterDir).length).toBe(1);
	});

	it("FLY-182: transient 429 stays queued (retryable)", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			text: async () => "rate limited",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
		});
		const result = await notifier.alert(buildPayload());
		expect(result.queued).toBe(true);
		expect(readdirSync(queueDir).length).toBe(1);
		expect(readdirSync(deadLetterDir).length).toBe(0);
	});

	it("FLY-182: drainQueue dead-letters legacy permanent (no-channel) files regardless of current config", async () => {
		// Simulate the production backlog: a queue file recorded as no-channel.
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
		});
		// Hand-write a legacy queue file (queueReason=no-channel) for a lead that
		// CAN now resolve a channel (cos-lead) — must still be dead-lettered.
		const legacy = {
			...buildPayload({ leadId: "cos-lead" }),
			queuedAt: new Date().toISOString(),
			queueReason: "no-channel",
		};
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(queueDir, "2026-05-04T00-00-00-000Z-cos-lead-pane_hash_stuck.json"),
			JSON.stringify(legacy),
			"utf-8",
		);

		const drained = await notifier.drainQueue();
		expect(drained.deadLettered).toBe(1);
		expect(drained.sent).toBe(0);
		expect(fetchFn).not.toHaveBeenCalled(); // never POSTed to core
		expect(readdirSync(queueDir).length).toBe(0);
		expect(readdirSync(deadLetterDir).length).toBe(1);
	});

	it("FLY-182: drainQueue dead-letters malformed files instead of skipping forever", async () => {
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: vi.fn(),
			queueDir,
			deadLetterDir,
		});
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(queueDir, "2026-01-01T00-00-00-000Z-x-y.json"),
			"{not json",
			"utf-8",
		);
		const drained = await notifier.drainQueue();
		expect(drained.deadLettered).toBe(1);
		expect(readdirSync(queueDir).length).toBe(0);
		expect(readdirSync(deadLetterDir).length).toBe(1);
	});

	it("queues to disk on Discord 5xx so a later drain can retry", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			text: async () => "discord is down",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});

		const result = await notifier.alert(buildPayload());

		expect(result.queued).toBe(true);
		expect(result.sent).toBeFalsy();
		const queued = readdirSync(queueDir);
		expect(queued.length).toBe(1);
		expect(queued[0]).toMatch(/cos-lead/);
	});

	it("drains queued files on drainQueue() and removes on success", async () => {
		const payload = buildPayload({ eventId: "drain-evt" });
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "err",
				text: async () => "fail",
			})
			.mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
			});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});

		await notifier.alert(payload);
		expect(readdirSync(queueDir).length).toBe(1);

		const drained = await notifier.drainQueue();
		expect(drained.sent).toBe(1);
		expect(drained.remaining).toBe(0);
		expect(readdirSync(queueDir).length).toBe(0);
	});

	it("sends severe follow-up DM when alertDmUserId is configured", async () => {
		const projects: ProjectEntry[] = [
			{
				...testProjects[0]!,
				leads: [
					{
						...testProjects[0]!.leads[0]!,
						alertDmUserId: "annie-user-id",
					},
				],
			},
		];
		const dmChannelCreate = { id: "dm-channel-123" };
		const fetchFn = vi.fn().mockImplementation(async (url: string) => {
			if (url.endsWith("/users/@me/channels")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => dmChannelCreate,
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({}),
			};
		});

		const notifier = new LeadAlertNotifier({
			store,
			projects,
			fetchFn,
			queueDir,
		});

		await notifier.alert(buildPayload({ severity: "severe" }));

		const urls = (fetchFn.mock.calls as Array<[string, RequestInit]>).map(
			([u]) => u,
		);
		expect(urls).toContain(
			"https://discord.com/api/v10/channels/1487340532610109520/messages",
		);
		expect(urls).toContain("https://discord.com/api/v10/users/@me/channels");
		expect(urls).toContain(
			"https://discord.com/api/v10/channels/dm-channel-123/messages",
		);
	});

	it("FLY-182: unknown lead dead-letters (audit) + does not throw or POST", async () => {
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
		});

		const result = await notifier.alert(
			buildPayload({ leadId: "unknown-lead" }),
		);
		expect(result.skipped).toBe("unknown-lead");
		expect(result.deadLettered).toBe(true);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(queueDir).length).toBe(0);
		expect(readdirSync(deadLetterDir).length).toBe(1);
	});
});

describe("findUnreachableAlertLeads (FLY-182 §4.1 startup validation)", () => {
	it("flags leads with no channel route and no token source", () => {
		const unreachable = findUnreachableAlertLeads(testProjects);
		// ops-lead has neither alertChannel nor fallback-to-core → unreachable.
		expect(unreachable.map((u) => u.leadId)).toContain("ops-lead");
		// cos-lead (alertChannel) + product-lead (fallback+generalChannel) reachable.
		expect(unreachable.map((u) => u.leadId)).not.toContain("cos-lead");
		expect(unreachable.map((u) => u.leadId)).not.toContain("product-lead");
	});

	it("flags a lead whose token env var is configured but not resolvable at runtime", () => {
		const prev = process.env.FLY182_MISSING_TOKEN;
		delete process.env.FLY182_MISSING_TOKEN;
		const proj: ProjectEntry[] = [
			{
				projectName: "p",
				projectRoot: "/tmp/p",
				generalChannel: "core",
				leads: [
					{
						agentId: "l1",
						forumChannel: "f",
						chatChannel: "c",
						match: { labels: [] },
						alertChannel: "chan",
						alertBotTokenEnv: "FLY182_MISSING_TOKEN", // not set in env
					},
				],
			},
		];
		const unreachable = findUnreachableAlertLeads(proj);
		expect(unreachable.map((u) => u.leadId)).toContain("l1");
		if (prev !== undefined) process.env.FLY182_MISSING_TOKEN = prev;
	});

	it("returns empty when every lead has a resolvable channel + token", () => {
		const ok: ProjectEntry[] = [
			{
				projectName: "p",
				projectRoot: "/tmp/p",
				generalChannel: "core",
				leads: [
					{
						agentId: "l1",
						forumChannel: "f",
						chatChannel: "c",
						match: { labels: [] },
						alertChannel: "chan",
						botToken: "tok",
					},
				],
			},
		];
		expect(findUnreachableAlertLeads(ok)).toEqual([]);
	});
});

describe("LeadAlertNotifier — FLY-368 unified alert channel", () => {
	let store: StateStore;
	let queueDir: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly368-queue-"));
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
	});

	it("routes ALL alerts to the unified channel (overriding per-lead alertChannel) and returns channelId+messageId", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "root-msg-123" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: { channelId: "UNIFIED-CHAN", token: "unified-token" },
		});

		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));

		expect(result.sent).toBe(true);
		expect(result.channelId).toBe("UNIFIED-CHAN");
		expect(result.messageId).toBe("root-msg-123");
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		// cos-lead.alertChannel is 1487340532610109520, but unified wins:
		expect(url).toBe(
			"https://discord.com/api/v10/channels/UNIFIED-CHAN/messages",
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot unified-token",
		);
	});

	it("byte-compat: with NO unified config the result is exactly { sent: true } (no channelId/messageId)", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "should-not-be-read" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result).toEqual({ sent: true });
		expect(result).not.toHaveProperty("channelId");
		expect(result).not.toHaveProperty("messageId");
	});

	it("a runner-stuck-unhandled alert routes a runner from a Lead that has no per-lead alertChannel to the unified channel", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "m-1" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: { channelId: "UNIFIED-CHAN", token: "unified-token" },
		});
		// ops-lead has NO alertChannel and NO alertFallbackToCore → today it would
		// dead-letter. Under unified routing it reaches the one channel.
		const result = await notifier.alert(
			buildPayload({
				leadId: "ops-lead",
				eventType: "runner_stuck_unhandled",
				sessionKey: "exec-1",
			}),
		);
		expect(result.sent).toBe(true);
		expect(result.channelId).toBe("UNIFIED-CHAN");
	});

	it("unified root POST suppresses mentions (allowed_mentions {parse:[]})", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "m-1" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: { channelId: "UNIFIED-CHAN", token: "unified-token" },
		});
		await notifier.alert(buildPayload());
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("legacy (no unified) root POST does NOT add allowed_mentions (byte-compat)", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});
		await notifier.alert(buildPayload());
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body).not.toHaveProperty("allowed_mentions");
	});

	it("findUnreachableAlertLeads: unified channel + token → nothing unreachable", () => {
		expect(
			findUnreachableAlertLeads(testProjects, {
				channelId: "UNIFIED-CHAN",
				token: "unified-token",
			}),
		).toEqual([]);
	});

	it("findUnreachableAlertLeads: unified channel + NO unified token → validate per-lead fallback token only", () => {
		const out = findUnreachableAlertLeads(testProjects, {
			channelId: "UNIFIED-CHAN",
			token: null,
		});
		// ops-lead has no token of any kind → unreachable; cos/product have tokens.
		expect(out.map((u) => u.leadId)).toEqual(["ops-lead"]);
	});
});
