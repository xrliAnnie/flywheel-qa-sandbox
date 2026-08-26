/**
 * FLY-1082 (Tasks 1.3/1.4/1.5): fleet-kind ticket enrichment through the
 * routed sink — owner cross from metadata.infraBotDown and fleet payloads
 * (projectName "machine", no session) enriching without a projects.json match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { buildInfraAlertRouting } from "../infra-alert-wiring.js";

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chan-eng",
				match: { labels: ["Flywheel"] },
				botToken: "eng-bot-token",
			},
		],
	},
] as unknown as ProjectEntry[];

function fleetPayload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "machine",
		projectName: "machine",
		eventId: `e-${Math.random().toString(36).slice(2)}`,
		eventType: "swap_pressure_high",
		title: "T",
		body: "B",
		severity: "warning",
		...over,
	};
}

describe("FLY-1082 fleet ticket enrichment (routed sink)", () => {
	let store: StateStore;
	let ticketSink: { alert: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		ticketSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ sent: true })),
		};
		process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = "111111111111111111";
		process.env.FLYWHEEL_INFRA_BOT_USER_ID = "222222222222222222";
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID;
		delete process.env.FLYWHEEL_INFRA_BOT_USER_ID;
	});

	function makeSink() {
		return buildInfraAlertRouting({
			store,
			projects,
			rawSink: { alert: vi.fn() },
			ticketSink,
			routingEnabled: () => true,
			ticketsEnabled: () => true,
			logger: () => {},
		});
	}

	function enriched(): AlertPayload {
		return ticketSink.alert.mock.calls.at(-1)![0] as AlertPayload;
	}

	it("infra_bot_down: dead CLAUDE bot → CODEX bot owns (explicit metadata field)", async () => {
		await makeSink().alert(
			fleetPayload({
				eventType: "infra_bot_down",
				metadata: {
					infraBotDown: { provider: "claude", jobLabel: "w5.claude-infra" },
				},
			}),
		);
		expect(enriched().ticket).toMatchObject({
			ownerRef: "infra_bot:codex",
			ownerUserId: "222222222222222222",
		});
	});

	it("infra_bot_down: dead CODEX bot → CLAUDE bot owns", async () => {
		await makeSink().alert(
			fleetPayload({
				eventType: "infra_bot_down",
				metadata: {
					infraBotDown: { provider: "codex", jobLabel: "w4.codex-infra" },
				},
			}),
		);
		expect(enriched().ticket).toMatchObject({
			ownerRef: "infra_bot:claude",
			ownerUserId: "111111111111111111",
		});
	});

	it("infra_bot_down: owner env unset degrades to no ping (label only)", async () => {
		delete process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID;
		await makeSink().alert(
			fleetPayload({
				eventType: "infra_bot_down",
				metadata: { infraBotDown: { provider: "codex" } },
			}),
		);
		expect(enriched().ticket).toMatchObject({
			ownerRef: "infra_bot:claude",
			ownerUserId: null,
			ownerLabel: "claude bot",
		});
	});

	it("zombie_session_backlog carries an owner but no input status", async () => {
		await makeSink().alert(
			fleetPayload({ eventType: "zombie_session_backlog" }),
		);
		expect(enriched().ticket?.ownerRef).toBe("infra_bot:claude");
		expect(enriched().ticket).not.toHaveProperty("status");
	});

	it("the other fleet kinds carry the claude owner without an input status", async () => {
		for (const eventType of [
			"swap_pressure_high",
			"tmux_server_lost",
			"bridge_abnormal_exit",
		] as const) {
			await makeSink().alert(fleetPayload({ eventType }));
			expect(enriched().ticket, eventType).toMatchObject({
				ownerRef: "infra_bot:claude",
			});
			expect(enriched().ticket, eventType).not.toHaveProperty("status");
		}
	});
});
