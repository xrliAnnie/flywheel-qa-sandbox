import { describe, expect, it } from "vitest";
import { bodyFor, titleFor } from "../bridge/alert-kind-copy.js";
import { DISCORD_PERMISSIONS as P } from "../bridge/channel-permissions.js";
import { KIND_CONTRACTS } from "../bridge/kind-contract.js";
import {
	ownerRegistryFromEnv,
	resolveTicketOwner,
} from "../bridge/ticket-owner-map.js";
import {
	assertVoiceHealthSendPermissions,
	resolveVoiceHealthAlertRoute,
} from "../bridge/voice-health-alert-route.js";
import {
	ALERT_EVENT_TYPES,
	INFORMATIONAL_KINDS,
} from "../LeadAlertNotifier.js";

const PRIMARY_CHANNEL = "100000000000000001";

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
					chatChannel: "100000000000000002",
					match: { labels: ["Engineering"] },
					summaryRole: "none" as const,
				},
			],
		},
	];
}

describe("voice health alert contract", () => {
	it("uses the engineering primary route without project fan-out", () => {
		const route = resolveVoiceHealthAlertRoute(projects());
		expect(route).toMatchObject({
			routeKey: "primary",
			deliveryProject: "flywheel",
			leadId: "infra-lead",
			channelId: PRIMARY_CHANNEL,
			tokenEnv: "INFRA_TOKEN",
		});
		expect(route.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(route).not.toHaveProperty("copy");
	});

	it("fails closed unless the selected sender can view and post", () => {
		const allowed = P.VIEW_CHANNEL | P.SEND_MESSAGES;
		expect(() => assertVoiceHealthSendPermissions(allowed)).not.toThrow();
		expect(() => assertVoiceHealthSendPermissions(P.VIEW_CHANNEL)).toThrow(
			/SEND_MESSAGES/,
		);
		expect(() => assertVoiceHealthSendPermissions(P.SEND_MESSAGES)).toThrow(
			/VIEW_CHANNEL/,
		);
	});

	it("keeps voice failures informational, owning-lead routed, and closed-copy", () => {
		expect(ALERT_EVENT_TYPES).toContain("voice_daemon_unhealthy");
		expect(INFORMATIONAL_KINDS.has("voice_daemon_unhealthy")).toBe(true);
		expect(KIND_CONTRACTS.voice_daemon_unhealthy).toEqual({
			owner: "owning_lead",
			arc: "none_escalate",
		});
		const registry = ownerRegistryFromEnv({} as NodeJS.ProcessEnv);
		expect(
			resolveTicketOwner(
				"voice_daemon_unhealthy",
				"unknown",
				registry,
				"infra-lead",
			),
		).toEqual({ kind: "lead", leadId: "infra-lead" });
		expect(titleFor("voice_daemon_unhealthy")).toBe("Voice daemon unhealthy");
		expect(bodyFor("voice_daemon_unhealthy", "secret raw failure")).toContain(
			"voice health source",
		);
		expect(
			bodyFor("voice_daemon_unhealthy", "secret raw failure"),
		).not.toContain("secret raw failure");
	});
});
