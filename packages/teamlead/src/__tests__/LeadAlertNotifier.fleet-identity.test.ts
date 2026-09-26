/**
 * FLY-1082 (Task 1.4): the validated fleet/system alert identity.
 *
 * Fleet-level failures (swap watermark / tmux server loss / bot down / zombie
 * backlog) are MACHINE-scoped — there is no projects.json lead to resolve, so
 * before this change `alert()` dead-lettered them as unknown-lead and the
 * incident stayed silent. The fleet identity (projectName = "machine") is
 * allowed to bypass lead resolution ONLY when it is actually deliverable:
 * unified channel configured AND a sender token resolves (D2 single-sender or
 * the repair chain). Routing identity and display fields are decoupled —
 * leadId is a display-only affected-target summary on this path.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AlertPayload,
	FLEET_ALERT_PROJECT,
	LeadAlertNotifier,
} from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chat-1",
				match: { labels: ["Flywheel"] },
				botTokenEnv: "FLY1082_LEAD_TOKEN", // hermetic — never set on a real box
			},
		],
	},
] as unknown as ProjectEntry[];

function fleetPayload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "tmux-server", // display-only affected-target summary
		projectName: FLEET_ALERT_PROJECT,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		eventType: "tmux_server_lost",
		title: "tmux server lost",
		body: "13 running sessions, server gone",
		severity: "severe",
		...over,
	};
}

describe("LeadAlertNotifier — FLY-1082 fleet identity (Task 1.4)", () => {
	let store: StateStore;
	let queueDir: string;
	let deadLetterDir: string;
	let fetchFn: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly1082-q-"));
		deadLetterDir = mkdtempSync(join(tmpdir(), "fly1082-dl-"));
		fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "msg-1" }),
			text: async () => "",
		});
		process.env.FLY1082_SENDER_TOKEN = "sender-token";
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "FLY1082_SENDER_TOKEN";
	});

	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		rmSync(deadLetterDir, { recursive: true, force: true });
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		delete process.env.FLY1082_SENDER_TOKEN;
		delete process.env.FLY1082_CASS_TOKEN;
		delete process.env.FLY1082_LEAD_TOKEN;
	});

	function makeNotifier(opts: { unified?: boolean } = {}) {
		return new LeadAlertNotifier({
			store,
			projects,
			fetchFn: fetchFn as unknown as typeof fetch,
			queueDir,
			deadLetterDir,
			...(opts.unified === false
				? {}
				: {
						unifiedAlert: {
							channelId: "UNIFIED",
							repairBotTokenEnv: "FLY1082_CASS_TOKEN",
						},
					}),
		});
	}

	it("fleet payload delivers to the unified channel (no projects.json lead) for all 4 Bridge-side fleet kinds", async () => {
		const notifier = makeNotifier();
		for (const eventType of [
			"swap_pressure_high",
			"tmux_server_lost",
			"infra_bot_down",
			"zombie_session_backlog",
		] as const) {
			fetchFn.mockClear();
			const result = await notifier.alert(fleetPayload({ eventType }));
			expect(result.sent, eventType).toBe(true);
			expect(result.channelId, eventType).toBe("UNIFIED");
			expect(result.messageId, eventType).toBe("msg-1");
			const url = fetchFn.mock.calls[0]![0] as string;
			expect(url).toContain("/channels/UNIFIED/messages");
		}
		expect(readdirSync(deadLetterDir)).toHaveLength(0);
	});

	it("fleet identity works via the repair chain when no D2 sender env is set", async () => {
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		process.env.FLY1082_CASS_TOKEN = "cass-token";
		const notifier = makeNotifier();
		const result = await notifier.alert(fleetPayload());
		expect(result.sent).toBe(true);
	});

	it("fleet payload WITHOUT unified mode dead-letters (fail-loud, never mis-routes)", async () => {
		const notifier = makeNotifier({ unified: false });
		const result = await notifier.alert(fleetPayload());
		expect(result.skipped).toBe("unknown-lead");
		expect(result.deadLettered).toBe(true);
	});

	it("fleet payload with NO resolvable sender token dead-letters (deliverability gate)", async () => {
		delete process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		delete process.env.FLY1082_CASS_TOKEN; // repair chain empty too
		const notifier = makeNotifier();
		const result = await notifier.alert(fleetPayload());
		expect(result.skipped).toBe("unknown-lead");
		expect(result.deadLettered).toBe(true);
	});

	it("a NON-fleet unknown lead still dead-letters (byte-compat fail-loud)", async () => {
		const notifier = makeNotifier();
		const result = await notifier.alert(
			fleetPayload({ projectName: "no-such-project" }),
		);
		expect(result.skipped).toBe("unknown-lead");
		expect(result.deadLettered).toBe(true);
	});

	it("a queued fleet payload drains through the send chain (not dead-lettered as unknown-lead)", async () => {
		const notifier = makeNotifier();
		// First send fails transiently → queued.
		fetchFn.mockResolvedValueOnce({
			ok: false,
			status: 500,
			json: async () => ({}),
			text: async () => "boom",
		});
		const first = await notifier.alert(fleetPayload({ eventId: "evt-drain" }));
		expect(first.queued).toBe(true);

		const drained = await notifier.drainQueue();
		expect(drained.sent).toBe(1);
		expect(drained.deadLettered).toBe(0);
		expect(drained.delivered).toHaveLength(1);
		expect(drained.delivered[0]!.channelId).toBe("UNIFIED");
	});
});
