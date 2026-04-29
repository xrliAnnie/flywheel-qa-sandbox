import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AlertPayload, LeadAlertNotifier } from "../LeadAlertNotifier.js";
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

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly83-queue-"));
	});

	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
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

	it("returns skipped=no-channel and queues when no alert route is configured", async () => {
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});

		const result = await notifier.alert(buildPayload({ leadId: "ops-lead" }));

		expect(result.skipped).toBe("no-channel");
		expect(fetchFn).not.toHaveBeenCalled();

		const queued = readdirSync(queueDir);
		expect(queued.length).toBe(1);
		const written = JSON.parse(
			readFileSync(join(queueDir, queued[0]!), "utf-8"),
		);
		expect(written.leadId).toBe("ops-lead");
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

	it("skips alert for unknown lead and does not throw", async () => {
		const fetchFn = vi.fn();
		const notifier = new LeadAlertNotifier({
			store,
			projects: testProjects,
			fetchFn,
			queueDir,
		});

		const result = await notifier.alert(
			buildPayload({ leadId: "unknown-lead" }),
		);
		expect(result.skipped).toBe("unknown-lead");
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
