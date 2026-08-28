import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALERT_EVENT_TYPES,
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
				botTokenEnv: "TEST_COS_BOT_TOKEN",
				botToken: "resolved-bot-token",
				alertChannel: "1487340532610109520",
				alertBotTokenEnv: "TEST_COS_BOT_TOKEN",
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

// FLY-1081 (Codex code R1 HIGH): a configured dev machine exports the
// PRODUCTION FLYWHEEL_ALERT_SENDER_TOKEN_ENV. If a unified-path test inherits
// it, the send chain collapses to the real production sender identity and a
// failing assertion prints the REAL Authorization header into test logs.
// Neutralize it for EVERY test in this file (outer hooks run first/last, so
// suites that set it explicitly inside their own beforeEach/tests still work
// and the original value is restored at the end of each test).
let fileSavedSenderEnv: string | undefined;
beforeEach(() => {
	fileSavedSenderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
	delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
});
afterEach(() => {
	if (fileSavedSenderEnv === undefined) {
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
	} else {
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = fileSavedSenderEnv;
	}
});

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
		expect(store.getAlertDeliveryReceipt(payload.eventId)).toMatchObject({
			outcome: "sent",
		});
	});

	it("FLY-2076 direct alert-system OFF records without poisoning the later ON delivery", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		let enabled = false;
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
			deliveryEnabled: () => enabled,
		});
		const payload = buildPayload({ eventId: "alert-system-off-direct" });

		await expect(notifier.alert(payload)).resolves.toEqual({
			skipped: "disabled",
		});
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(queueDir)).toEqual([]);
		expect(readdirSync(deadLetterDir)).toEqual([]);
		const suppression = store
			.listUndeliveredLeadEvents()
			.find((row) => row.payload === JSON.stringify(payload));
		expect(suppression).toMatchObject({
			lead_id: payload.leadId,
			event_type: payload.eventType,
			payload: JSON.stringify(payload),
		});
		expect(suppression?.event_id).not.toBe(payload.eventId);

		enabled = true;
		await expect(notifier.alert(payload)).resolves.toEqual({ sent: true });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("FLY-2051: direct non-switch payloads cannot opt out of alert framing", async () => {
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
		});
		const payload = buildPayload({
			eventType: "quota_no_target",
			deliveryStyle: "plain",
		});

		const result = await notifier.alert(payload);

		expect(result).toMatchObject({ deadLettered: true });
		expect(fetchFn).not.toHaveBeenCalled();
		const deadLetter = JSON.parse(
			readFileSync(
				join(deadLetterDir, readdirSync(deadLetterDir)[0]!),
				"utf-8",
			),
		);
		expect(deadLetter.reason).toBe("invalid-delivery-style");
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

	it("replays after the caller's ambiguous-attempt fence without treating durable claims as delivery", async () => {
		const eventId = "dead_letter_alert:runner_unroutable:runner-a:40";
		const payload = buildPayload({
			eventId,
			eventType: "mailbox_dead_letter",
		});
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const claimsReader = vi.fn(async () => new Set([eventId]));
		const claimsClaimer = vi.fn(async () => false);
		store.tryClaimLeadEvent(
			payload.leadId,
			payload.eventId,
			payload.eventType,
			JSON.stringify(payload),
		);
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			claimsReader,
			claimsClaimer,
		});

		const result = await notifier.alert(payload, {
			replayAfterAmbiguousAttempt: true,
		});

		expect(result).toEqual({ sent: true });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(claimsReader).not.toHaveBeenCalled();
		expect(claimsClaimer).not.toHaveBeenCalled();
		expect(store.getAlertDeliveryReceipt(eventId)).toMatchObject({
			outcome: "sent",
		});
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

	it("FLY-2076 alert-system OFF pauses queue drain without posting or consuming backlog", async () => {
		const fetchFn = vi.fn();
		const queued = {
			...buildPayload({ eventId: "alert-system-off-queued" }),
			queuedAt: new Date().toISOString(),
			queueReason: "discord-500",
		};
		writeFileSync(
			join(queueDir, "2026-08-27T20-00-00-000Z-cos-lead-pane_hash_stuck.json"),
			JSON.stringify(queued),
			"utf-8",
		);
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir,
			deliveryEnabled: () => false,
		});

		await expect(notifier.drainQueue()).resolves.toEqual({
			sent: 0,
			remaining: 1,
			deadLettered: 0,
			staleSuppressed: 0,
			delivered: [],
		});
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(queueDir)).toHaveLength(1);
		expect(readdirSync(deadLetterDir)).toEqual([]);
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

describe("LeadAlertNotifier — FLY-368 rework: owner-attributed send chain", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly368rw-queue-"));
		// Set the fleet bot tokens this suite asserts attribution against.
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"PETER_BOT_TOKEN",
			"CASS_BOT_TOKEN",
		]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.PETER_BOT_TOKEN = "peter-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	// testProjects: cos-lead=TEST_COS_BOT_TOKEN, product-lead=PETER_BOT_TOKEN,
	// ops-lead=(no botTokenEnv). Cass token env for repair/fallback = CASS_BOT_TOKEN.
	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	it("posts the root alert via the STUCK lead's OWN bot (correct attribution)", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "root-1" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result.sent).toBe(true);
		expect(result.channelId).toBe("OPS-CHAN");
		expect(result.messageId).toBe("root-1");
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/v10/channels/OPS-CHAN/messages");
		// own bot = SIMBA (cos-lead), NOT a fixed unified token
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot simba-tok",
		);
		const body = JSON.parse(init.body as string);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("a lead with no own bot (ops-lead) falls back to Cass", async () => {
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
			unifiedAlert: unified,
		});
		const result = await notifier.alert(
			buildPayload({ leadId: "ops-lead", eventType: "runner_stuck_unhandled" }),
		);
		expect(result.sent).toBe(true);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot cass-tok",
		);
	});

	it("403 on the stuck lead's bot (no channel perms) falls through to the next chain bot", async () => {
		const fetchFn = vi
			.fn()
			// cos-lead's own bot (SIMBA) → 403; next chain bot (Cass) → 200
			.mockResolvedValueOnce({
				ok: false,
				status: 403,
				statusText: "Forbidden",
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ id: "m-2" }),
			});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result.sent).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [, init2] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect((init2.headers as Record<string, string>).Authorization).toBe(
			"Bot cass-tok",
		);
	});

	it("a transient (429) on the first chain bot does NOT burn the chain — queues", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result).toEqual({ queued: true });
		// stopped at the first (transient) candidate — did not try the rest
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("byte-compat: with NO unified config the result is exactly { sent: true }", async () => {
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
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result).toEqual({ sent: true });
	});

	it("findUnreachableAlertLeads: unified + a resolvable fleet bot → nothing unreachable", () => {
		expect(
			findUnreachableAlertLeads(testProjects, {
				channelId: "OPS-CHAN",
				repairBotTokenEnv: "CASS_BOT_TOKEN",
			}),
		).toEqual([]);
	});

	it("findUnreachableAlertLeads: unified + NO fleet bot resolves → one fleet-wide entry", () => {
		// unset every fleet token so the whole chain resolves nothing
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"PETER_BOT_TOKEN",
			"CASS_BOT_TOKEN",
		]) {
			delete process.env[k];
		}
		const out = findUnreachableAlertLeads(testProjects, {
			channelId: "OPS-CHAN",
			repairBotTokenEnv: "CASS_BOT_TOKEN",
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.leadId).toBe("*");
	});

	it("a non-fallthrough permanent status (400) on the owner bot STOPS — does NOT try Cass — and dead-letters", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly368rw-dl-"));
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result.deadLettered).toBe(true);
		// 400 is malformed for EVERY bot → only the owner bot was tried, not Cass/alpha.
		expect(fetchFn).toHaveBeenCalledTimes(1);
		rmSync(dlDir, { recursive: true, force: true });
	});

	it("drainQueue: a 400 also stops at the first candidate and dead-letters (same helper)", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly368rw-dl2-"));
		// First send: transient 5xx → queues.
		const fetchTransient = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: fetchTransient,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
		});
		const queued = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(queued).toEqual({ queued: true });

		// Drain with a 400 → stop at first candidate, dead-letter (not the whole fleet).
		const fetch400 = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			text: async () => "",
		});
		// swap the fetch impl for the drain
		(notifier as unknown as { fetchFn: typeof fetch400 }).fetchFn = fetch400;
		const drained = await notifier.drainQueue();
		expect(drained.deadLettered).toBe(1);
		expect(fetch400).toHaveBeenCalledTimes(1);
		rmSync(dlDir, { recursive: true, force: true });
	});
});

describe("LeadAlertNotifier — FLY-927 Task 1.2: 🎫 ticket schema header", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly927-tickets-"));
		for (const k of ["TEST_COS_BOT_TOKEN", "CASS_BOT_TOKEN"]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	function okFetch() {
		return vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "root-1" }),
		});
	}

	function makeNotifier(
		fetchFn: ReturnType<typeof okFetch>,
		opts?: { tickets?: boolean; legacy?: boolean },
	) {
		return new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			...(opts?.legacy ? {} : { unifiedAlert: unified }),
			ticketsEnabled: () => opts?.tickets ?? false,
		});
	}

	it("SENTINEL: unified mode with tickets OFF keeps the exact two-line format", async () => {
		const fetchFn = okFetch();
		await makeNotifier(fetchFn, { tickets: false }).alert(
			buildPayload({ leadId: "cos-lead", title: "T", body: "B" }),
		);
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(body.content).toBe(
			"🤖[自动] ⚠️ **T** (cos-lead / pane_hash_stuck)\nB",
		);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("SENTINEL: legacy (per-lead) path NEVER renders 🎫 even with tickets on", async () => {
		const fetchFn = okFetch();
		await makeNotifier(fetchFn, { tickets: true, legacy: true }).alert(
			buildPayload({ leadId: "cos-lead", title: "T", body: "B" }),
		);
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(body.content).toBe(
			"🤖[自动] ⚠️ **T** (cos-lead / pane_hash_stuck)\nB",
		);
		expect(body.allowed_mentions).toBeUndefined();
	});

	it("tickets ON, no ticket context → 🎫 line with owner — and 状态 NEW", async () => {
		const fetchFn = okFetch();
		await makeNotifier(fetchFn, { tickets: true }).alert(
			buildPayload({ leadId: "cos-lead", title: "T", body: "B" }),
		);
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		const lines = (body.content as string).split("\n");
		expect(lines[0]).toBe("🤖[自动] ⚠️ **T** (cos-lead / pane_hash_stuck)");
		expect(lines[1]).toMatch(
			/^🎫 geoforge3d · 首见 \d{2}:\d{2} · owner — · 状态 NEW$/,
		);
		expect(lines[2]).toBe("B");
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	] as const)(
		"FLY-1182: informational %s direct POST has no 🎫 header",
		async (eventType) => {
			const fetchFn = okFetch();
			await makeNotifier(fetchFn, { tickets: true }).alert(
				buildPayload({
					eventType: eventType as AlertPayload["eventType"],
					title: "Account switched",
					body: "shopping → school",
				}),
			);
			const body = JSON.parse(
				(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
			);
			expect(body.content).toBe(
				`🤖[自动] ⚠️ **Account switched** (cos-lead / ${eventType})\nshopping → school`,
			);
		},
	);

	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	] as const)(
		"FLY-1182: informational %s queue replay has no 🎫 header",
		async (eventType) => {
			writeFileSync(
				join(queueDir, `20260714T120000Z-${eventType}.json`),
				JSON.stringify({
					...buildPayload({
						eventType: eventType as AlertPayload["eventType"],
						title: "Account switched",
						body: "shopping → school",
					}),
					queuedAt: new Date().toISOString(),
					queueReason: "discord-503",
				}),
			);
			const fetchFn = okFetch();
			const result = await makeNotifier(fetchFn, {
				tickets: true,
			}).drainQueue();
			const body = JSON.parse(
				(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
			);
			expect(body.content).not.toContain("🎫");
			expect(result.delivered[0]?.payload.eventType).toBe(eventType);
		},
	);

	it("tickets ON + owner snowflake → <@id> in 🎫 line AND allowed_mentions.users", async () => {
		const fetchFn = okFetch();
		await makeNotifier(fetchFn, { tickets: true }).alert(
			buildPayload({
				leadId: "cos-lead",
				title: "T",
				body: "B",
				ticket: {
					ownerUserId: "123456789012345678",
					ownerLabel: "claude bot",
					firstSeenMs: new Date(2026, 6, 7, 9, 5).getTime(),
				},
			}),
		);
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect((body.content as string).split("\n")[1]).toBe(
			"🎫 geoforge3d · 首见 09:05 · owner <@123456789012345678> · 状态 NEW",
		);
		expect(body.allowed_mentions).toEqual({ users: ["123456789012345678"] });
	});

	it("malformed owner id degrades to the label + parse:[] (never a rejected mentions body)", async () => {
		const fetchFn = okFetch();
		await makeNotifier(fetchFn, { tickets: true }).alert(
			buildPayload({
				leadId: "cos-lead",
				ticket: {
					ownerUserId: "not-a-snowflake",
					ownerLabel: "codex bot",
					status: "ACK",
					firstSeenMs: new Date(2026, 6, 7, 9, 5).getTime(),
				} as any,
			}),
		);
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(body.content).toContain("owner codex bot · 状态 NEW");
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});
});

describe("LeadAlertNotifier — FLY-927 Task 1.3: single sender identity (D2)", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly927-sender-"));
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"CASS_BOT_TOKEN",
			"INFRA_SENDER_TOKEN",
			"FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
		]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	function okFetch() {
		return vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "root-1" }),
		});
	}

	it("sender env set → root posts with THAT token, own-bot chain never tried", async () => {
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "INFRA_SENDER_TOKEN";
		process.env.INFRA_SENDER_TOKEN = "infra-tok";
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result.sent).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(
			(
				(fetchFn.mock.calls[0] as [string, RequestInit])[1].headers as Record<
					string,
					string
				>
			).Authorization,
		).toBe("Bot infra-tok");
	});

	it("sender env set but UNRESOLVABLE → dead-letter, NO silent own-bot fallback", async () => {
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "INFRA_SENDER_TOKEN";
		delete process.env.INFRA_SENDER_TOKEN;
		const fetchFn = okFetch();
		const dlDir = mkdtempSync(join(tmpdir(), "fly927-sender-dl-"));
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
		});
		const result = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(result.deadLettered).toBe(true);
		expect(fetchFn).not.toHaveBeenCalled(); // own bot (simba) never consulted
		expect(readdirSync(dlDir).length).toBe(1);
		rmSync(dlDir, { recursive: true, force: true });
	});

	it("SENTINEL: sender env unset → legacy own-bot attribution unchanged", async () => {
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
		});
		await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(
			(
				(fetchFn.mock.calls[0] as [string, RequestInit])[1].headers as Record<
					string,
					string
				>
			).Authorization,
		).toBe("Bot simba-tok");
	});

	it("drainQueue retries with the sender identity too (same chain logic)", async () => {
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "INFRA_SENDER_TOKEN";
		process.env.INFRA_SENDER_TOKEN = "infra-tok";
		// First send: transient 503 → queued.
		const fetch503 = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			text: async () => "",
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: fetch503,
			queueDir,
			unifiedAlert: unified,
		});
		const queued = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(queued).toEqual({ queued: true });
		// Drain succeeds with the sender token.
		const fetchOk = okFetch();
		(notifier as unknown as { fetchFn: typeof fetchOk }).fetchFn = fetchOk;
		const drained = await notifier.drainQueue();
		expect(drained.sent).toBe(1);
		expect(
			(
				(fetchOk.mock.calls[0] as [string, RequestInit])[1].headers as Record<
					string,
					string
				>
			).Authorization,
		).toBe("Bot infra-tok");
	});
});

describe("LeadAlertNotifier — FLY-927 Task 1.4: unified-channel rate cap (T1)", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly927-rate-"));
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"CASS_BOT_TOKEN",
			"FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
		]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	/** Deterministic limiter stub: a scripted sequence of tryAcquire answers. */
	function scriptedLimiter(answers: boolean[]) {
		let i = 0;
		const overflow = new Map<string, number>();
		return {
			calls: () => i,
			overflowMap: overflow,
			tryAcquire: () => answers[Math.min(i++, answers.length - 1)]!,
			noteOverflow: (kind: string) =>
				overflow.set(kind, (overflow.get(kind) ?? 0) + 1),
			peekOverflow: () => (overflow.size > 0 ? new Map(overflow) : null),
			clearOverflow: () => overflow.clear(),
		};
	}

	function okFetch() {
		return vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "m-1" }),
		});
	}

	it("over-limit alert is queued ONCE + counted; under-limit posts normally", async () => {
		const limiter = scriptedLimiter([true, false]);
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			rateLimiter: limiter,
		});
		const first = await notifier.alert(buildPayload({ leadId: "cos-lead" }));
		expect(first.sent).toBe(true);
		const second = await notifier.alert(
			buildPayload({ leadId: "cos-lead", eventType: "rate_limit" }),
		);
		expect(second).toEqual({ queued: true });
		expect(fetchFn).toHaveBeenCalledTimes(1); // the refused alert never POSTed
		expect(readdirSync(queueDir).length).toBe(1);
		expect(limiter.overflowMap.get("rate_limit")).toBe(1);
	});

	it("drain posts ONE aggregate summary first, then delivers the queue; overflow clears", async () => {
		const limiter = scriptedLimiter([true, true, true]);
		limiter.noteOverflow("rate_limit");
		limiter.noteOverflow("rate_limit");
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			rateLimiter: limiter,
		});
		// Seed one queued alert (as if rate-limited earlier).
		const withLimiterOff = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
				statusText: "x",
				text: async () => "",
			}),
			queueDir,
			unifiedAlert: unified,
		});
		await withLimiterOff.alert(buildPayload({ leadId: "cos-lead" }));
		expect(readdirSync(queueDir).length).toBe(1);

		const result = await notifier.drainQueue();
		expect(result.sent).toBe(1);
		expect(result.remaining).toBe(0);
		// First POST = the summary, second = the queued alert.
		const firstBody = JSON.parse(
			(fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(firstBody.content).toContain("🎫 速率攒批:2 条告警已入队");
		expect(firstBody.content).toContain("rate_limit×2");
		expect(limiter.peekOverflow()).toBeNull(); // cleared after the summary posted
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("summary itself refused → counts kept, no summary POST (no recursion)", async () => {
		const limiter = scriptedLimiter([false]);
		limiter.noteOverflow("usage_limit");
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			rateLimiter: limiter,
		});
		await notifier.drainQueue();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(limiter.peekOverflow()).toEqual(new Map([["usage_limit", 1]]));
	});

	it("drain STOPS mid-round when the bucket empties; queue files stay untouched", async () => {
		// Seed two queued alerts.
		const seed = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
				statusText: "x",
				text: async () => "",
			}),
			queueDir,
			unifiedAlert: unified,
		});
		await seed.alert(buildPayload({ leadId: "cos-lead" }));
		// distinct eventType → distinct queue filename even within the same ms
		await seed.alert(
			buildPayload({ leadId: "cos-lead", eventType: "rate_limit" }),
		);
		expect(readdirSync(queueDir).length).toBe(2);

		// One token only (no overflow pending → no summary): first file sends,
		// second is refused → drain stops, file remains.
		const limiter = scriptedLimiter([true, false]);
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			rateLimiter: limiter,
		});
		const result = await notifier.drainQueue();
		expect(result.sent).toBe(1);
		expect(result.remaining).toBe(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});

describe("LeadAlertNotifier — FLY-927 Codex R1 fixes", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly927-r1-"));
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"CASS_BOT_TOKEN",
			"INFRA_SENDER_TOKEN",
			"FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
		]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	it("HIGH fix: unified drain returns the delivered roots (payload + channel + messageId) for Hub attach", async () => {
		// Seed a queued alert (transient 503 on first send).
		const seed = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
				statusText: "x",
				text: async () => "",
			}),
			queueDir,
			unifiedAlert: unified,
		});
		await seed.alert(buildPayload({ leadId: "cos-lead" }));

		const fetchOk = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "drained-root-1" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: fetchOk,
			queueDir,
			unifiedAlert: unified,
		});
		const result = await notifier.drainQueue();
		expect(result.sent).toBe(1);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0]).toMatchObject({
			channelId: "OPS-CHAN",
			messageId: "drained-root-1",
		});
		expect(result.delivered[0]!.payload.eventType).toBe("pane_hash_stuck");
		// queue-bookkeeping fields stripped from the Hub-bound payload
		expect(
			(result.delivered[0]!.payload as Record<string, unknown>).queueReason,
		).toBeUndefined();
	});

	it("FLY-2051: unified drain replays a queued switch alert to its validated delivery channel", async () => {
		const routedChannel = "7".repeat(18);
		writeFileSync(
			join(queueDir, "20260825T120000Z-system-account_switched-route.json"),
			JSON.stringify({
				leadId: "system",
				projectName: "flywheel",
				eventId: "route-account-switched",
				eventType: "account_switched",
				title: "Claude account switched",
				body: "shopping->school; from5h=91; from7d=74; to5h=12; to7d=8",
				severity: "info",
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
				deliveryChannelId: routedChannel,
				deliveryStyle: "plain",
			}),
		);
		const fetchOk = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "routed-root-1" }),
		});
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: fetchOk,
			queueDir,
			unifiedAlert: unified,
		});

		const result = await notifier.drainQueue();

		expect(result.sent).toBe(1);
		expect(fetchOk).toHaveBeenCalledTimes(1);
		expect(fetchOk.mock.calls[0]![0]).toBe(
			`https://discord.com/api/v10/channels/${routedChannel}/messages`,
		);
		const posted = JSON.parse(
			(fetchOk.mock.calls[0]![1] as RequestInit).body as string,
		);
		expect(posted.content).toBe(
			"🤖[自动] shopping->school; from5h=91; from7d=74; to5h=12; to7d=8",
		);
		expect(posted.content).not.toContain("Claude account switched");
		// An ordinary notification must never be handed to AlertChannelHub, which
		// would attach the alert-box/thread lifecycle after a queued replay.
		expect(result.delivered).toEqual([]);
	});

	it("FLY-2051: unified drain dead-letters an invalid delivery style without POSTing", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly2051-invalid-style-"));
		writeFileSync(
			join(queueDir, "20260825T120000Z-system-account_switched-bad-style.json"),
			JSON.stringify({
				leadId: "system",
				projectName: "flywheel",
				eventId: "bad-style-account-switched",
				eventType: "account_switched",
				title: "Claude account switched",
				body: "shopping->school",
				severity: "info",
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
				deliveryChannelId: "7".repeat(18),
				deliveryStyle: "alert-box",
			}),
		);
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
		});

		const result = await notifier.drainQueue();

		expect(result.sent).toBe(0);
		expect(result.deadLettered).toBe(1);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(dlDir)[0]).toMatch(/^invalid-delivery-style-/);
		rmSync(dlDir, { recursive: true, force: true });
	});

	it("FLY-2051: unified drain dead-letters an invalid delivery channel without POSTing", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly2051-invalid-route-"));
		writeFileSync(
			join(queueDir, "20260825T120000Z-system-account_switched-bad-route.json"),
			JSON.stringify({
				leadId: "system",
				projectName: "flywheel",
				eventId: "bad-route-account-switched",
				eventType: "account_switched",
				title: "Claude account switched",
				body: "shopping->school",
				severity: "info",
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
				deliveryChannelId: "not-a-snowflake",
			}),
		);
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
		});

		const result = await notifier.drainQueue();

		expect(result.sent).toBe(0);
		expect(result.deadLettered).toBe(1);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(queueDir)).toEqual([]);
		expect(readdirSync(dlDir)[0]).toMatch(/^invalid-delivery-channel-/);
		rmSync(dlDir, { recursive: true, force: true });
	});

	it("HIGH fix: legacy (non-unified) drain returns an empty delivered list", async () => {
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: vi.fn(),
			queueDir,
		});
		const result = await notifier.drainQueue();
		expect(result.delivered).toEqual([]);
	});

	it("MEDIUM fix: sender env set + resolvable → startup check passes even with an EMPTY repair chain", () => {
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "INFRA_SENDER_TOKEN";
		process.env.INFRA_SENDER_TOKEN = "infra-tok";
		delete process.env.CASS_BOT_TOKEN;
		delete process.env.TEST_COS_BOT_TOKEN;
		expect(
			findUnreachableAlertLeads([], {
				channelId: "OPS-CHAN",
				repairBotTokenEnv: "CASS_BOT_TOKEN",
				senderTokenEnv: "INFRA_SENDER_TOKEN",
			}),
		).toEqual([]);
	});

	it("MEDIUM fix: sender env set but UNRESOLVABLE → loud boot-time unreachable (even though the repair chain resolves)", () => {
		delete process.env.INFRA_SENDER_TOKEN;
		const out = findUnreachableAlertLeads(testProjects, {
			channelId: "OPS-CHAN",
			repairBotTokenEnv: "CASS_BOT_TOKEN",
			senderTokenEnv: "INFRA_SENDER_TOKEN",
		});
		expect(out).toHaveLength(1);
		expect(out[0]!.reason).toContain("INFRA_SENDER_TOKEN");
		expect(out[0]!.reason).toContain("single-sender");
	});

	it("SENTINEL: no sender env → the existing repair-chain check unchanged", () => {
		const out = findUnreachableAlertLeads(testProjects, {
			channelId: "OPS-CHAN",
			repairBotTokenEnv: "CASS_BOT_TOKEN",
		});
		expect(out).toEqual([]); // CASS_BOT_TOKEN resolves in beforeEach
	});
});

describe("LeadAlertNotifier — FLY-1081: deploy kinds + mentionUserId + drain unified-first", () => {
	let store: StateStore;
	let queueDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly1081-queue-"));
		for (const k of [
			"TEST_COS_BOT_TOKEN",
			"CASS_BOT_TOKEN",
			"FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
		]) {
			saved[k] = process.env[k];
		}
		process.env.TEST_COS_BOT_TOKEN = "simba-tok";
		process.env.CASS_BOT_TOKEN = "cass-tok";
		// Hermetic against a dev shell that carries the production sender env.
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const unified = {
		channelId: "OPS-CHAN",
		repairBotTokenEnv: "CASS_BOT_TOKEN",
	};

	function okFetch() {
		return vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "root-1" }),
		});
	}

	it("ALERT_EVENT_TYPES carries the two shell deploy kinds", () => {
		expect(ALERT_EVENT_TYPES).toContain("deploy_failed");
		expect(ALERT_EVENT_TYPES).toContain("deploy_degraded");
	});

	it("mentionUserId → content prefixed <@id> + allowed_mentions.users (unified, tickets off)", async () => {
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			ticketsEnabled: () => false,
		});
		const result = await notifier.alert(
			buildPayload({
				leadId: "cos-lead",
				title: "T",
				body: "B",
				mentionUserId: "222333444555666777",
			}),
		);
		expect(result.sent).toBe(true);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.content).toBe(
			"🤖[自动] <@222333444555666777> ⚠️ **T** (cos-lead / pane_hash_stuck)\nB",
		);
		expect(body.allowed_mentions).toEqual({ users: ["222333444555666777"] });
	});

	it("mentionUserId merges + dedupes with the 🎫 owner whitelist", async () => {
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			ticketsEnabled: () => true,
		});
		await notifier.alert(
			buildPayload({
				leadId: "cos-lead",
				mentionUserId: "222333444555666777",
				ticket: {
					ownerUserId: "123456789012345678",
					ownerLabel: "claude bot",
					firstSeenMs: Date.now(),
				},
			}),
		);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.allowed_mentions).toEqual({
			users: ["123456789012345678", "222333444555666777"],
		});
		expect(
			(body.content as string).startsWith("🤖[自动] <@222333444555666777> "),
		).toBe(true);
		// same id in both roles → deduped to one entry
		const fetchFn2 = okFetch();
		const notifier2 = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn: fetchFn2,
			queueDir,
			unifiedAlert: unified,
			ticketsEnabled: () => true,
		});
		await notifier2.alert(
			buildPayload({
				leadId: "cos-lead",
				eventId: "evt-dedupe",
				mentionUserId: "123456789012345678",
				ticket: {
					ownerUserId: "123456789012345678",
					ownerLabel: "claude bot",
					firstSeenMs: Date.now(),
				},
			}),
		);
		const [, init2] = fetchFn2.mock.calls[0] as [string, RequestInit];
		const body2 = JSON.parse(init2.body as string);
		expect(body2.allowed_mentions).toEqual({ users: ["123456789012345678"] });
	});

	it("invalid mentionUserId degrades to full suppression (byte-compat body)", async () => {
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			unifiedAlert: unified,
			ticketsEnabled: () => false,
		});
		await notifier.alert(
			buildPayload({
				leadId: "cos-lead",
				title: "T",
				body: "B",
				mentionUserId: "not-a-snowflake",
			}),
		);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.content).toBe(
			"🤖[自动] ⚠️ **T** (cos-lead / pane_hash_stuck)\nB",
		);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("drain unified-first: a shell system-identity record (NO projects.json lead) re-posts with its mention instead of unknown-lead dead-letter", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly1081-dl-"));
		// Hand-written record in the exact lead-alert.sh write_record shape —
		// projectName=flywheel / leadId=deploy has NO entry in testProjects.
		writeFileSync(
			join(queueDir, "20260709T120000Z-deploy-deploy_failed-abc123def456.json"),
			JSON.stringify({
				leadId: "deploy",
				projectName: "flywheel",
				eventId: "abc123def456abc123def456abc123def456abc1",
				eventType: "deploy_failed",
				title: "Flywheel deploy failed",
				body: "deploy body",
				severity: "severe",
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
				mentionUserId: "222333444555666777",
			}),
		);
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
			unifiedAlert: unified,
			ticketsEnabled: () => false,
		});
		const result = await notifier.drainQueue();
		expect(result.sent).toBe(1);
		expect(result.deadLettered).toBe(0);
		expect(result.remaining).toBe(0);
		expect(readdirSync(queueDir).filter((f) => f.endsWith(".json"))).toEqual(
			[],
		);
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(
			(body.content as string).startsWith("🤖[自动] <@222333444555666777> "),
		).toBe(true);
		expect(body.allowed_mentions).toEqual({ users: ["222333444555666777"] });
		rmSync(dlDir, { recursive: true, force: true });
	});

	it("SENTINEL: legacy (non-unified) drain still dead-letters an unknown lead", async () => {
		const dlDir = mkdtempSync(join(tmpdir(), "fly1081-dl2-"));
		writeFileSync(
			join(queueDir, "20260709T120000Z-deploy-deploy_failed-abc123def456.json"),
			JSON.stringify({
				leadId: "deploy",
				projectName: "flywheel",
				eventId: "abc123def456abc123def456abc123def456abc1",
				eventType: "deploy_failed",
				title: "T",
				body: "B",
				severity: "severe",
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
			}),
		);
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
			deadLetterDir: dlDir,
		});
		const result = await notifier.drainQueue();
		expect(result.sent).toBe(0);
		expect(result.deadLettered).toBe(1);
		expect(fetchFn).not.toHaveBeenCalled();
		rmSync(dlDir, { recursive: true, force: true });
	});
});
