/**
 * FLY-927 (Task 1.1/1.5 wiring): integration coverage of the Router glue
 * against a REAL in-memory StateStore — the exact resolution chain plugin.ts
 * installs (sessions → resolveLeadForIssue → chat_threads → issue-thread leg).
 * Sweeps the WHOLE AlertEventType union so a future kind cannot silently
 * bypass the funnel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALERT_EVENT_TYPES,
	type AlertEventType,
	type AlertPayload,
	type AlertResult,
	FLEET_ALERT_PROJECT,
} from "../../LeadAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { AlertChannelHub, correlationKeyFor } from "../AlertChannelHub.js";
import { AutoRepairBot } from "../AutoRepairBot.js";
import { buildInfraAlertRouting } from "../infra-alert-wiring.js";
import { ISSUE_PROGRESS_KINDS } from "../infra-event-router.js";

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chan-eng",
				alertChannel: "alert-eng",
				match: { labels: ["Flywheel"] },
				botToken: "eng-bot-token",
			},
		],
	},
] as unknown as ProjectEntry[];

const EXEC = "exec-927";

function payload(eventType: AlertEventType): AlertPayload {
	return {
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		eventId: `e-${eventType}`,
		eventType,
		title: "T",
		body: "B",
		severity: "warning",
		sessionKey: EXEC,
	};
}

describe("buildInfraAlertRouting (plugin glue, real StateStore)", () => {
	let store: StateStore;
	let rawSink: { alert: ReturnType<typeof vi.fn> };
	let ticketSink: { alert: ReturnType<typeof vi.fn> };
	let fetchImpl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "issue-uuid-927",
			issue_identifier: "FLY-927",
			issue_title: "t",
			issue_labels: JSON.stringify(["Flywheel"]),
			project_name: "flywheel",
			status: "running",
		});
		store.upsertChatThread("thread-927", "chan-eng", "issue-uuid-927");
		rawSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ sent: true })),
		};
		ticketSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ queued: true })),
		};
		fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => ({ id: "m-1" }),
			text: async () => "",
		}));
	});

	function makeSink(routing = true) {
		return buildInfraAlertRouting({
			store,
			projects,
			globalBotToken: "global-token",
			rawSink,
			ticketSink,
			founderUserId: "123456789012345678",
			routingEnabled: () => routing,
			ticketsEnabled: () => false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleepFn: async () => {},
			logger: () => {},
		});
	}

	it("FULL-UNION SWEEP: progress uses its issue thread, escalation uses Hub, everything else uses Claw mailbox", async () => {
		const sink = makeSink(true);
		for (const kind of ALERT_EVENT_TYPES) {
			rawSink.alert.mockClear();
			ticketSink.alert.mockClear();
			fetchImpl.mockClear();
			const result = await sink.alert(payload(kind));
			if (ISSUE_PROGRESS_KINDS.has(kind)) {
				expect(
					fetchImpl,
					`${kind} should deliver to the issue thread`,
				).toHaveBeenCalledTimes(1);
				expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
					"/channels/thread-927/messages",
				);
				expect(rawSink.alert).not.toHaveBeenCalled();
				expect(ticketSink.alert).not.toHaveBeenCalled();
				expect(result).toEqual({ sent: true });
			} else if (kind === "workflow_engine_escalation") {
				expect(
					rawSink.alert,
					`${kind} should hit the escalation Hub sink`,
				).toHaveBeenCalledTimes(1);
				expect(ticketSink.alert).not.toHaveBeenCalled();
				expect(fetchImpl).not.toHaveBeenCalled();
				expect(result).toEqual({ sent: true });
				expect(rawSink.alert).toHaveBeenCalledWith({
					...payload(kind),
					mentionUserId: "123456789012345678",
				});
			} else {
				expect(
					ticketSink.alert,
					`${kind} should hit the Claw mailbox sink`,
				).toHaveBeenCalledTimes(1);
				expect(rawSink.alert).not.toHaveBeenCalled();
				expect(fetchImpl).not.toHaveBeenCalled();
				expect(result).toEqual({ queued: true });
			}
		}
	});

	it("routes an ordinary ticket only to the Claw mailbox", async () => {
		const alert = payload("swap_pressure_high");
		await makeSink(true).alert(alert);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(alert);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("FLY-2076 alert-system OFF records intake but creates no channel post, ticket, or Claw delivery", async () => {
		const alert = payload("swap_pressure_high");
		const sink = buildInfraAlertRouting({
			store,
			projects,
			rawSink,
			ticketSink,
			alertsEnabled: () => false,
			routingEnabled: () => true,
			ticketsEnabled: () => true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger: () => {},
		});

		await expect(sink.alert(alert)).resolves.toEqual({ skipped: "disabled" });
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(ticketSink.alert).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(
			store
				.listUndeliveredLeadEvents()
				.find(
					(row) => row.event_id === `alert-system-suppressed:${alert.eventId}`,
				),
		).toMatchObject({
			lead_id: alert.leadId,
			event_type: alert.eventType,
			payload: JSON.stringify(alert),
		});
	});

	it("SENTINEL (routing OFF): every kind passes straight through to the raw sink", async () => {
		const sink = makeSink(false);
		for (const kind of ALERT_EVENT_TYPES) {
			rawSink.alert.mockClear();
			ticketSink.alert.mockClear();
			await sink.alert(payload(kind));
			expect(rawSink.alert).toHaveBeenCalledTimes(1);
			expect(ticketSink.alert).not.toHaveBeenCalled();
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it("progress kind WITHOUT a bound thread fail-safes to the Claw mailbox", async () => {
		const sink = makeSink(true);
		const p = { ...payload("three_stage_stuck"), sessionKey: "no-such-exec" };
		await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("resolves a workflow issue alert by its dead execution metadata, not the wf run sessionKey", async () => {
		const sink = makeSink(true);
		const p: AlertPayload = {
			...payload("workflow_engine_issue_alert"),
			sessionKey: "wf:run-1385",
			metadata: {
				workflowEngine: {
					runId: "run-1385",
					issueId: "issue-uuid-927",
					nodeId: "implement",
					executionId: EXEC,
					disposition: "dead_execution_activity_after_replacement",
					leadResolution: "resolved",
				},
			},
		};
		await sink.alert(p);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("still resolves the issue thread when the dead execution has no session row", async () => {
		store.close();
		store = await StateStore.create(":memory:");
		store.upsertChatThread("thread-927", "chan-eng", "issue-uuid-927");
		const sink = makeSink(true);
		const p: AlertPayload = {
			...payload("workflow_engine_issue_alert"),
			sessionKey: "wf:run-1385",
			metadata: {
				workflowEngine: {
					runId: "run-1385",
					issueId: "issue-uuid-927",
					nodeId: "implement",
					executionId: "missing-dead-exec",
					disposition: "dead_execution_activity_after_replacement",
					leadResolution: "resolved",
				},
			},
		};
		await sink.alert(p);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("issue-thread delivery failure routes the ORIGINAL alert to the Claw mailbox", async () => {
		fetchImpl.mockImplementation(async () => ({
			ok: false,
			status: 403,
			headers: { get: () => null },
			text: async () => "forbidden",
		}));
		const sink = makeSink(true);
		const p = payload("three_stage_stuck");
		const result = await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(result).toEqual({ queued: true });
	});

	it("thread post uses the owning lead's bot token", async () => {
		const sink = makeSink(true);
		await sink.alert(payload("three_stage_stuck"));
		const init = (
			fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		)[1];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot eng-bot-token",
		);
	});

	it("ordinary fleet and Lead alerts do not require a Hub", async () => {
		const sink = buildInfraAlertRouting({
			store,
			projects,
			rawSink,
			ticketSink,
			routingEnabled: () => true,
			ticketsEnabled: () => false,
			logger: () => {},
		});
		await expect(
			sink.alert({
				...payload("zombie_session_backlog"),
				leadId: "zombie-detector",
				projectName: FLEET_ALERT_PROJECT,
			}),
		).resolves.toEqual({ queued: true });
		await expect(sink.alert(payload("rate_limit"))).resolves.toEqual({
			queued: true,
		});
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(ticketSink.alert).toHaveBeenCalledTimes(2);
	});
});

describe("FLY-927 Task 2.3: owner enrichment (🎫 context before the sink)", () => {
	let store: StateStore;
	let rawSink: { alert: ReturnType<typeof vi.fn> };
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		rawSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ sent: true })),
		};
		for (const k of [
			"FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID",
			"FLYWHEEL_INFRA_BOT_USER_ID",
		]) {
			saved[k] = process.env[k];
		}
		process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = "111111111111111111";
		process.env.FLYWHEEL_INFRA_BOT_USER_ID = "222222222222222222";
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function makeSink(tickets = true) {
		return buildInfraAlertRouting({
			store,
			projects,
			rawSink,
			ticketSink: rawSink,
			routingEnabled: () => true,
			ticketsEnabled: () => tickets,
			logger: () => {},
			now: () => Date.UTC(2026, 6, 7, 9, 5),
		});
	}

	it("ticket kind gets owner context (claude lead default → cross to codex bot for auth kinds)", async () => {
		const sink = makeSink();
		await sink.alert({ ...payload("login_expired"), sessionKey: undefined });
		const enriched = rawSink.alert.mock.calls[0]![0] as AlertPayload;
		// flywheel-eng-lead has no backend → claude default → CROSS to codex bot.
		expect(enriched.ticket).toMatchObject({
			ownerUserId: "222222222222222222",
			ownerLabel: "codex bot",
			ownerRef: "infra_bot:codex",
			firstSeenMs: Date.UTC(2026, 6, 7, 9, 5),
		});
		expect(enriched.ticket).not.toHaveProperty("status");
	});

	it("provider-agnostic kind → claude bot owner", async () => {
		const sink = makeSink();
		await sink.alert({ ...payload("pane_hash_stuck"), sessionKey: undefined });
		const enriched = rawSink.alert.mock.calls[0]![0] as AlertPayload;
		expect(enriched.ticket?.ownerRef).toBe("infra_bot:claude");
		expect(enriched.ticket?.ownerUserId).toBe("111111111111111111");
	});

	it("FLY-2118 sends orphan-pane tickets to the final Claw owner payload", async () => {
		const sink = makeSink();
		await sink.alert({
			...payload("orphan_pane"),
			leadId: "patrol-orphan-sweeper",
			projectName: FLEET_ALERT_PROJECT,
			sessionKey: undefined,
		});
		const enriched = rawSink.alert.mock.calls[0]![0] as AlertPayload;
		expect(enriched.ticket).toMatchObject({
			ownerUserId: "111111111111111111",
			ownerLabel: "claude bot",
			ownerRef: "infra_bot:claude",
		});
	});

	it("unbound progress kinds remain un-enriched", async () => {
		const sink = makeSink();
		await sink.alert({
			...payload("runner_lead_pending_unhandled"),
			sessionKey: undefined,
		});
		const enriched = rawSink.alert.mock.calls[0]![0] as AlertPayload;
		expect(enriched.ticket).toBeUndefined();
	});

	it("tickets disabled → payload passes through un-enriched (byte-compat)", async () => {
		const sink = makeSink(false);
		await sink.alert({ ...payload("rate_limit"), sessionKey: undefined });
		expect(
			(rawSink.alert.mock.calls[0]![0] as AlertPayload).ticket,
		).toBeUndefined();
	});

	it("issue-progress kinds are never 🎫-enriched", async () => {
		const sink = makeSink();
		await sink.alert({
			...payload("three_stage_stuck"),
			sessionKey: "no-such-exec",
		});
		expect(
			(rawSink.alert.mock.calls[0]![0] as AlertPayload).ticket,
		).toBeUndefined();
	});

	it("keeps ordinary alerts in Claw mailbox and sends only a real escalation through the Hub", async () => {
		const threadPosts: Array<{ content: string; mentionUserId?: string }> = [];
		const rootPayloads: AlertPayload[] = [];
		const ticketSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ queued: true })),
		};
		let root = 0;
		const hub = new AlertChannelHub({
			store,
			notifier: {
				alert: async (p) => {
					rootPayloads.push(p);
					return {
						sent: true,
						channelId: "alert-channel",
						messageId: `root-${++root}`,
					};
				},
			},
			autoRepairBot: new AutoRepairBot({}),
			discord: {
				async createThreadFromMessage(_channelId, messageId) {
					return `thread-${messageId}`;
				},
				async postToThread(_threadId, content, opts) {
					threadPosts.push({ content, mentionUserId: opts?.mentionUserId });
				},
				async archiveThread() {},
			},
		});
		const sink = buildInfraAlertRouting({
			store,
			projects,
			rawSink: { alert: (p) => hub.handle(p) },
			ticketSink,
			founderUserId: "999999999999999999",
			routingEnabled: () => true,
			ticketsEnabled: () => true,
			logger: () => {},
			now: () => Date.UTC(2026, 7, 26, 12),
		});

		for (const eventType of [
			"review_advisory_pass",
			"zombie_session_backlog",
			"bridge_abnormal_exit",
		] as const) {
			const p = { ...payload(eventType), sessionKey: undefined };
			expect(await sink.alert(p)).toEqual({ queued: true });
			expect(store.getActiveAlertThread(correlationKeyFor(p))).toBeUndefined();
		}
		expect(ticketSink.alert).toHaveBeenCalledTimes(3);
		expect(rootPayloads).toEqual([]);

		const escalation = {
			...payload("workflow_engine_escalation"),
			eventId: "e-founder-escalation",
			sessionKey: undefined,
		};
		expect(await sink.alert(escalation)).toMatchObject({ sent: true });
		expect(rootPayloads).toEqual([
			expect.objectContaining({
				eventId: "e-founder-escalation",
				mentionUserId: "999999999999999999",
			}),
		]);
		expect(
			store.getActiveAlertThread(correlationKeyFor(escalation))?.ticket_status,
		).toBe("NEW");
		expect(
			threadPosts.every(
				(post) =>
					post.mentionUserId !== "999999999999999999" &&
					!post.content.includes("<@999999999999999999>") &&
					!post.content.includes("ESCALATED"),
			),
		).toBe(true);
	});
});
