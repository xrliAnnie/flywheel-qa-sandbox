import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_PERMISSIONS as P } from "../bridge/channel-permissions.js";
import {
	assertShuttleSendPermissions,
	resolveShuttleAlertRoutes,
} from "../bridge/shuttle-alert-route.js";
import { LeadAlertNotifier } from "../LeadAlertNotifier.js";
import { StateStore } from "../StateStore.js";

const PRIMARY_CHANNEL = "100000000000000001";
const COPY_CHANNEL = "100000000000000002";

function projects() {
	return [
		{
			projectName: "flywheel",
			projectRoot: "/fixture/flywheel",
			shuttlePrimaryEngineeringLeadId: "infra-lead",
			leads: [
				{
					agentId: "infra-lead",
					chatChannel: PRIMARY_CHANNEL,
					botTokenEnv: "INFRA_TOKEN",
					botUserId: "200000000000000001",
					match: { labels: ["Engineering"] },
					summaryRole: "aggregator" as const,
				},
			],
		},
		{
			projectName: "alpha",
			projectRoot: "/fixture/alpha",
			shuttleEngineeringLeadId: "alpha-lead",
			leads: [
				{
					agentId: "alpha-lead",
					chatChannel: COPY_CHANNEL,
					botTokenEnv: "ALPHA_TOKEN",
					botUserId: "200000000000000002",
					match: { labels: ["Engineering"] },
					summaryRole: "none" as const,
				},
			],
		},
		{
			projectName: "beta",
			projectRoot: "/fixture/beta",
			leads: [
				{
					agentId: "beta-lead",
					chatChannel: "100000000000000003",
					match: { labels: ["Engineering"] },
					summaryRole: "none" as const,
				},
			],
		},
	];
}

describe("shuttle alert routing", () => {
	it("routes every origin through one configurable primary and only explicit copies", () => {
		const alpha = resolveShuttleAlertRoutes(projects(), "alpha");
		const beta = resolveShuttleAlertRoutes(projects(), "beta");

		expect(alpha.primary).toMatchObject({
			deliveryProject: "flywheel",
			leadId: "infra-lead",
			channelId: PRIMARY_CHANNEL,
		});
		expect(alpha.copy).toMatchObject({
			deliveryProject: "alpha",
			leadId: "alpha-lead",
			channelId: COPY_CHANNEL,
		});
		expect(beta.primary.channelId).toBe(PRIMARY_CHANNEL);
		expect(beta.copy).toBeUndefined();
		expect(alpha.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("deduplicates a copy that resolves to the primary channel", () => {
		const input = projects();
		input[1].leads[0].chatChannel = PRIMARY_CHANNEL;
		expect(resolveShuttleAlertRoutes(input, "alpha").copy).toBeUndefined();
	});

	it("fails closed for ambiguous primary identity or invalid explicit copies", () => {
		const ambiguous = projects();
		ambiguous[1].shuttlePrimaryEngineeringLeadId = "alpha-lead";
		expect(() => resolveShuttleAlertRoutes(ambiguous, "beta")).toThrow(
			/one primary/,
		);

		const invalidCopy = projects();
		invalidCopy[1].shuttleEngineeringLeadId = "missing";
		expect(() => resolveShuttleAlertRoutes(invalidCopy, "alpha")).toThrow(
			/explicit copy/,
		);
	});

	it("requires the sender to view and send before delivery", () => {
		const ok = P.VIEW_CHANNEL | P.SEND_MESSAGES;
		expect(() => assertShuttleSendPermissions(ok)).not.toThrow();
		expect(() => assertShuttleSendPermissions(P.VIEW_CHANNEL)).toThrow(
			/SEND_MESSAGES/,
		);
		expect(() => assertShuttleSendPermissions(P.SEND_MESSAGES)).toThrow(
			/VIEW_CHANNEL/,
		);
	});

	it("writes the eventual legacy queue delivery receipt back to the source ledger", async () => {
		const queueDir = mkdtempSync(join(tmpdir(), "fly2669-shuttle-queue-"));
		const store = await StateStore.create(":memory:");
		const recorder = vi.fn();
		const previousToken = process.env.INFRA_TOKEN;
		process.env.INFRA_TOKEN = "fixture-token";
		try {
			writeFileSync(
				join(queueDir, "20260917T194200Z-shuttle.json"),
				JSON.stringify({
					leadId: "infra-lead",
					projectName: "flywheel",
					eventId: "shuttle-event",
					eventType: "shuttle_unit_unhealthy",
					title: "Shuttle failed",
					body: "Raya prestop failed",
					severity: "warning",
					queuedAt: new Date().toISOString(),
					queueReason: "discord-503",
					deliveryChannelId: PRIMARY_CHANNEL,
					shuttleBatchId: "a".repeat(64),
					shuttleBindingDigest: "b".repeat(64),
				}),
			);
			const notifier = new LeadAlertNotifier({
				store,
				projects: projects(),
				queueDir,
				shuttleDeliveryRecorder: recorder,
				fetchFn: vi.fn().mockResolvedValue({
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ id: "300000000000000001" }),
				}),
			});

			await expect(notifier.drainQueue()).resolves.toMatchObject({ sent: 1 });
			expect(recorder).toHaveBeenCalledWith({
				batchId: "a".repeat(64),
				state: "sent",
				channelId: PRIMARY_CHANNEL,
				messageId: "300000000000000001",
				bindingDigest: "b".repeat(64),
			});
		} finally {
			if (previousToken === undefined) delete process.env.INFRA_TOKEN;
			else process.env.INFRA_TOKEN = previousToken;
			store.close();
			rmSync(queueDir, { recursive: true, force: true });
		}
	});
});
