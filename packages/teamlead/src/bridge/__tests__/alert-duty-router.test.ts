import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createAlertDutyRouter,
	deriveDutyState,
	dutyAuth,
	handoffLetterState,
} from "../alert-duty-router.js";
import { createQueryRouter } from "../tools.js";

function request(
	app: express.Application,
	input: {
		method: "GET" | "POST";
		path: string;
		token?: string;
		body?: Record<string, unknown>;
	},
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((done, reject) => {
		const server = createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("test server has no port"));
				return;
			}
			const data = input.body ? JSON.stringify(input.body) : "";
			const req = require("node:http").request(
				{
					host: "127.0.0.1",
					port: address.port,
					path: input.path,
					method: input.method,
					headers: {
						...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
						...(data
							? {
									"Content-Type": "application/json",
									"Content-Length": Buffer.byteLength(data),
								}
							: {}),
					},
				},
				(res: IncomingMessage) => {
					let raw = "";
					res.on("data", (chunk: Buffer) => {
						raw += chunk;
					});
					res.on("end", () => {
						server.close();
						let body: Record<string, unknown> = {};
						if (raw) {
							try {
								body = JSON.parse(raw) as Record<string, unknown>;
							} catch {
								body = { raw };
							}
						}
						done({
							status: res.statusCode,
							body,
						});
					});
				},
			);
			req.on("error", reject);
			if (data) req.write(data);
			req.end();
		});
	});
}

describe("alert duty router", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.openAlertThread({
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			threadId: "root-1",
			rootMessageId: "root-1",
			channelId: "alerts",
			leadId: "lead-a",
			projectName: "flywheel",
			eventType: "rate_limit",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
	});

	it.each([
		[{ resolved_at: "2026-09-06T00:00:00.000Z" }, "resolved"],
		[{ resolved_at: null, ticket_status: "ESCALATED" }, "handed_off"],
		[
			{ resolved_at: null, ticket_status: "NEW", acked_at: "2026-09-06" },
			"in_duty",
		],
		[{ resolved_at: null, ticket_status: "NEW", acked_at: null }, "unreviewed"],
	] as const)("derives board state %s as %s", (row, expected) => {
		expect(deriveDutyState(row)).toBe(expected);
	});

	it.each([
		[{ kind: "live", state: "QUEUED" }, "QUEUED"],
		[{ kind: "live", state: "ACKED" }, "ACKED"],
		[{ kind: "archived_nonterminal", state: "LEASED" }, "LEASED"],
		[{ kind: "archived_terminal", state: "DEAD" }, "DEAD"],
		[{ kind: "absent_identity" }, "NOT_QUEUED"],
		[{ kind: "torn_identity" }, "UNKNOWN"],
		[{ kind: "unknown_lead" }, "UNKNOWN"],
	] as const)("maps handoff settlement %s to %s", (settlement, expected) => {
		expect(handoffLetterState(settlement)).toBe(expected);
	});

	it("rejects the shared token and lets the duty token ACK one ticket", async () => {
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);

		const denied = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "shared-token",
			body: { action: "ack", messageId: "root-1" },
		});
		expect(denied.status).toBe(403);
		expect(store.getAlertThreadByEventId("evt-1")?.acked_at).toBeNull();

		const accepted = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "ack", messageId: "root-1" },
		});
		expect(accepted.status).toBe(200);
		expect(accepted.body.action).toBe("ack");
		expect(store.getAlertThreadByEventId("evt-1")?.ticket_status).toBe("NEW");
		expect(store.getAlertThreadByEventId("evt-1")?.acked_at).toBeTruthy();
	});

	it("looks up thread and mailbox alerts without requiring them to be unacked", async () => {
		store.stampDutyAck("fw|lead-a|rate_limit|", "evt-1");
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-mailbox",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:evt-mailbox",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);

		const thread = await request(app, {
			method: "GET",
			path: "/duty/alert-tickets/lookup?messageId=root-1",
			token: "duty-token",
		});
		expect(thread).toMatchObject({
			status: 200,
			body: {
				lane: "thread",
				correlationKey: "fw|lead-a|rate_limit|",
				eventId: "evt-1",
				kind: "rate_limit",
				leadId: "lead-a",
				projectName: "flywheel",
				ticketStatus: "NEW",
				ackedAt: expect.any(String),
				ref: expect.stringContaining("root-1"),
			},
		});

		const mailbox = await request(app, {
			method: "GET",
			path: "/duty/alert-tickets/lookup?eventId=evt-mailbox",
			token: "duty-token",
		});
		expect(mailbox).toEqual({
			status: 200,
			body: {
				lane: "mailbox",
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-mailbox",
				kind: "bridge_abnormal_exit",
				leadId: "fleet",
				projectName: "machine",
				ticketStatus: "NEW",
				ackedAt: null,
				resolvedAt: null,
				ownerRef: "infra_bot:claude",
				ref: "alert-ticket lookup --event-id evt-mailbox",
			},
		});
	});

	it("lists a bounded newest-first batch and accepts a durable since cursor", async () => {
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);
		const first = await request(app, {
			method: "GET",
			path: "/duty/alert-tickets/outstanding?limit=1",
			token: "duty-token",
		});
		expect(first.status).toBe(200);
		expect(first.body.tickets).toEqual([
			expect.objectContaining({ event_id: "evt-1", resolved: false }),
		]);
		expect(first.body.cursor).toEqual(expect.any(String));
		expect(first.body.cursor).not.toBe("evt-1");

		store.openAlertThread({
			correlationKey: "fw|lead-b|quota|",
			eventId: "evt-2",
			threadId: "root-2",
			rootMessageId: "root-2",
			channelId: "alerts",
			leadId: "lead-b",
			projectName: "flywheel",
			eventType: "quota",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		const newest = await request(app, {
			method: "GET",
			path: "/duty/alert-tickets/outstanding?limit=1",
			token: "duty-token",
		});
		expect(newest.body.tickets).toEqual([
			expect.objectContaining({ event_id: "evt-2", resolved: false }),
		]);

		const since = await request(app, {
			method: "GET",
			path: `/duty/alert-tickets/outstanding?limit=10&since=${encodeURIComponent(String(first.body.cursor))}`,
			token: "duty-token",
		});
		expect(since.status).toBe(200);
		expect(since.body.tickets).toEqual([
			expect.objectContaining({ event_id: "evt-2" }),
		]);

		for (const path of [
			"/duty/alert-tickets/outstanding?limit=0",
			"/duty/alert-tickets/outstanding?limit=101",
			"/duty/alert-tickets/outstanding?since=missing",
		]) {
			expect(
				(
					await request(app, {
						method: "GET",
						path,
						token: "duty-token",
					})
				).status,
			).toBe(400);
		}
	});

	it("merges outstanding thread and mailbox lanes with delivery metadata", async () => {
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|swap_pressure_high|",
				eventId: "evt-z-mailbox",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:swap_pressure_high:evt-z-mailbox",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "swap_pressure_high",
			},
			{ allowReseed: false },
		);
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);

		const response = await request(app, {
			method: "GET",
			path: "/duty/alert-tickets/outstanding?limit=2",
			token: "duty-token",
		});
		expect(response.status).toBe(200);
		expect(response.body.tickets).toEqual([
			expect.objectContaining({
				lane: "mailbox",
				event_id: "evt-z-mailbox",
				fireCount: 1,
				toAgent: "claude-infra-bot-lead",
			}),
			expect.objectContaining({
				lane: "thread",
				event_id: "evt-1",
				fireCount: null,
				toAgent: null,
			}),
		]);
	});

	it("acknowledges a mailbox-lane alert through the same transition route", async () => {
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-mailbox-ack",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:evt-mailbox-ack",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "ack", eventId: "evt-mailbox-ack" },
		});
		expect(response).toMatchObject({
			status: 200,
			body: { action: "ack", lane: "mailbox", eventId: "evt-mailbox-ack" },
		});
		expect(
			store.getMailboxLedgerByEventId("evt-mailbox-ack")?.acked_at,
		).toEqual(expect.any(String));
	});

	it("hands a ticket to a roster Lead and re-renders its mention", async () => {
		const renderTicketLine = vi.fn(async () => {});
		const enqueueAlertHandoff = vi.fn(() => ({
			queued: true,
			deliveryId: "unused-by-router",
			seq: 42,
		}));
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => ({ renderTicketLine }) as never,
				enqueueAlertHandoff,
			}),
		);
		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-1",
				to: "flywheel-eng-lead",
				reason: "contact_book",
				note: "Inspect the rate limit.",
			},
		});
		expect(response.status).toBe(200);
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				ticket_status: "ESCALATED",
				owner_ref: "lead:flywheel-eng-lead",
				handoff_reason: "contact_book",
				handoff_generation: 1,
				handoff_delivery_id:
					"alert_handoff:thread:fw|lead-a|rate_limit|:evt-1:flywheel-eng-lead:g1",
			}),
		);
		expect(enqueueAlertHandoff).toHaveBeenCalledWith("flywheel-eng-lead", {
			deliveryId:
				"alert_handoff:thread:fw|lead-a|rate_limit|:evt-1:flywheel-eng-lead:g1",
			lane: "thread",
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			kind: "rate_limit",
			reason: "contact_book",
			note: "Inspect the rate limit.",
			ref: expect.stringContaining("root-1"),
		});
		expect(renderTicketLine).toHaveBeenCalledWith(
			expect.objectContaining({ event_id: "evt-1" }),
			"<@222222222222222222>",
		);

		const repeated = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-1",
				to: "flywheel-eng-lead",
				reason: "contact_book",
			},
		});
		expect(repeated.status).toBe(200);
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				handoff_generation: 2,
				handoff_delivery_id:
					"alert_handoff:thread:fw|lead-a|rate_limit|:evt-1:flywheel-eng-lead:g2",
			}),
		);
		expect(enqueueAlertHandoff).toHaveBeenCalledTimes(2);
	});

	it("requires a classified handoff reason before changing the ledger", async () => {
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => undefined,
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-1",
				to: "flywheel-eng-lead",
			},
		});
		expect(response).toEqual({
			status: 400,
			body: { error: "handoff_reason_required" },
		});
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				owner_ref: "infra_bot:claude",
				handoff_generation: 0,
			}),
		);
	});

	it("writes a no-entry receipt before the ledger and handoff letter", async () => {
		const order: string[] = [];
		const writeOwedReceipt = vi.fn(() => {
			order.push("owed");
		});
		const realHandoff = store.handoffLedger.bind(store);
		const handoffLedger = vi
			.spyOn(store, "handoffLedger")
			.mockImplementation((...args) => {
				order.push("ledger");
				return realHandoff(...args);
			});
		const enqueueAlertHandoff = vi.fn((_leadId, input) => {
			order.push("letter");
			return { queued: true, deliveryId: input.deliveryId };
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => undefined,
				writeOwedReceipt,
				enqueueAlertHandoff,
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-1",
				to: "flywheel-eng-lead",
				reason: "no_entry",
			},
		});
		expect(response.status).toBe(200);
		expect(order).toEqual(["owed", "ledger", "letter"]);
		expect(writeOwedReceipt).toHaveBeenCalledWith({
			book: "contact-book",
			lane: "thread",
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			kind: "rate_limit",
		});
		handoffLedger.mockRestore();
	});

	it("does not change the ledger when the owed receipt cannot be written", async () => {
		const enqueueAlertHandoff = vi.fn();
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => undefined,
				writeOwedReceipt: () => {
					throw new Error("disk full");
				},
				enqueueAlertHandoff,
			}),
		);

		expect(
			await request(app, {
				method: "POST",
				path: "/duty/alert-tickets/transition",
				token: "duty-token",
				body: {
					action: "handoff",
					eventId: "evt-1",
					to: "flywheel-eng-lead",
					reason: "no_entry",
				},
			}),
		).toEqual({
			status: 500,
			body: { error: "owed_receipt_write_failed" },
		});
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				owner_ref: "infra_bot:claude",
				handoff_generation: 0,
			}),
		);
		expect(enqueueAlertHandoff).not.toHaveBeenCalled();
	});

	it("keeps a mailbox handoff visible when its letter enqueue throws", async () => {
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-mailbox-handoff",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:evt-mailbox-handoff",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const renderTicketLine = vi.fn();
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => ({ renderTicketLine }) as never,
				enqueueAlertHandoff: () => {
					throw new Error("owner queue unavailable");
				},
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-mailbox-handoff",
				to: "flywheel-eng-lead",
				reason: "contact_book",
			},
		});
		expect(response).toMatchObject({
			status: 200,
			body: {
				lane: "mailbox",
				handoffLetter: {
					queued: false,
					deliveryId:
						"alert_handoff:mailbox:machine|fleet|bridge_abnormal_exit|:evt-mailbox-handoff:flywheel-eng-lead:g1",
					error: "owner queue unavailable",
				},
			},
		});
		expect(store.getMailboxLedgerByEventId("evt-mailbox-handoff")).toEqual(
			expect.objectContaining({
				ticket_status: "ESCALATED",
				handoff_reason: "contact_book",
				handoff_generation: 1,
			}),
		);
		expect(renderTicketLine).not.toHaveBeenCalled();
	});

	it("hands a fleet ticket to Tadashi from the global roster", async () => {
		store.resolveAlertThread("fw|lead-a|rate_limit|", "evt-1");
		store.openAlertThread({
			correlationKey: "machine|fleet|swap_pressure_high|",
			eventId: "evt-fleet",
			threadId: "root-fleet",
			rootMessageId: "root-fleet",
			channelId: "alerts",
			leadId: "fleet",
			projectName: "machine",
			eventType: "swap_pressure_high",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => undefined,
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-fleet",
				to: "flywheel-eng-lead",
				reason: "contact_book",
			},
		});

		expect(response.status).toBe(200);
		expect(store.getAlertThreadByEventId("evt-fleet")?.owner_ref).toBe(
			"lead:flywheel-eng-lead",
		);
	});

	it("rejects a handoff target absent from the global roster", async () => {
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);
		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-1",
				to: "missing-lead",
				reason: "contact_book",
			},
		});
		expect(response.status).toBe(400);
		expect(response.body.error).toBe("handoff target is not in global roster");
		expect(store.getAlertThreadByEventId("evt-1")?.acked_at).toBeNull();
	});

	it("requires the Hub for resolve and passes the exact event fence", async () => {
		const appWithoutHub = express();
		appWithoutHub.use(express.json());
		appWithoutHub.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
				readDraftReceipt: (draftId) => ({
					draftId,
					book: "runbook",
					lane: "thread",
					correlationKey: "fw|lead-a|rate_limit|",
					eventId: "evt-1",
					kind: "rate_limit",
				}),
			}),
		);
		const unavailable = await request(appWithoutHub, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1", draftId: "draft-one" },
		});
		expect(unavailable.status).toBe(503);
		expect(store.getActiveAlertThread("fw|lead-a|rate_limit|")).toBeDefined();

		const resolve = vi.fn(async () => {});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => ({ resolve }) as never,
				readDraftReceipt: (draftId) => ({
					draftId,
					book: "runbook",
					lane: "thread",
					correlationKey: "fw|lead-a|rate_limit|",
					eventId: "evt-1",
					kind: "rate_limit",
				}),
			}),
		);
		const accepted = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1", draftId: "draft-one" },
		});
		expect(accepted.status).toBe(200);
		expect(resolve).toHaveBeenCalledWith("fw|lead-a|rate_limit|", "evt-1");
	});

	it("requires a valid runbook draft id before resolving", async () => {
		const resolve = vi.fn(async () => {});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => ({ resolve }) as never,
			}),
		);

		for (const draftId of [undefined, "../escape", "Upper Case"]) {
			const response = await request(app, {
				method: "POST",
				path: "/duty/alert-tickets/transition",
				token: "duty-token",
				body: {
					action: "resolve",
					eventId: "evt-1",
					...(draftId ? { draftId } : {}),
				},
			});
			expect(response).toEqual({
				status: 400,
				body: { error: "runbook_draft_required" },
			});
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects missing and mismatched runbook receipts before binding", async () => {
		const receipt: {
			current:
				| {
						draftId: string;
						book: "runbook" | "contact-book";
						lane: "thread" | "mailbox";
						correlationKey: string;
						eventId: string;
						kind: string;
				  }
				| undefined;
		} = { current: undefined };
		const resolve = vi.fn(async () => {});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => ({ resolve }) as never,
				readDraftReceipt: () => receipt.current,
			}),
		);

		expect(
			await request(app, {
				method: "POST",
				path: "/duty/alert-tickets/transition",
				token: "duty-token",
				body: { action: "resolve", eventId: "evt-1", draftId: "missing" },
			}),
		).toEqual({
			status: 404,
			body: { error: "draft_receipt_missing" },
		});

		receipt.current = {
			draftId: "mismatch",
			book: "contact-book",
			lane: "thread",
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			kind: "rate_limit",
		};
		expect(
			await request(app, {
				method: "POST",
				path: "/duty/alert-tickets/transition",
				token: "duty-token",
				body: {
					action: "resolve",
					eventId: "evt-1",
					draftId: "mismatch",
				},
			}),
		).toEqual({
			status: 400,
			body: { error: "draft_receipt_mismatch" },
		});
		expect(resolve).not.toHaveBeenCalled();
		expect(store.getAlertThreadByEventId("evt-1")?.resolve_draft_id).toBeNull();
	});

	it("binds a verified thread draft before retryable Hub resolution", async () => {
		const resolve = vi
			.fn()
			.mockRejectedValueOnce(new Error("Discord unavailable"))
			.mockImplementationOnce(async (correlationKey, eventId) => {
				store.resolveAlertThread(correlationKey, eventId);
			});
		const readDraftReceipt = vi.fn((draftId: string) => ({
			draftId,
			book: "runbook" as const,
			lane: "thread" as const,
			correlationKey: "fw|lead-a|rate_limit|",
			eventId: "evt-1",
			kind: "rate_limit",
		}));
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => ({ resolve }) as never,
				readDraftReceipt,
			}),
		);

		const first = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1", draftId: "draft-one" },
		});
		expect(first).toEqual({ status: 500, body: { error: "resolve_failed" } });
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				resolved_at: null,
				resolve_draft_id: "draft-one",
			}),
		);

		const conflict = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1", draftId: "draft-two" },
		});
		expect(conflict).toEqual({
			status: 409,
			body: { error: "draft_conflict" },
		});

		const retried = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1", draftId: "draft-one" },
		});
		expect(retried).toMatchObject({
			status: 200,
			body: { action: "resolve", lane: "thread", eventId: "evt-1" },
		});
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				resolve_draft_id: "draft-one",
				resolved_at: expect.any(String),
			}),
		);
	});

	it("resolves a verified mailbox draft without touching the Discord Hub", async () => {
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-mailbox-resolve",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:evt-mailbox-resolve",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
				readDraftReceipt: (draftId) => ({
					draftId,
					book: "runbook",
					lane: "mailbox",
					correlationKey: "machine|fleet|bridge_abnormal_exit|",
					eventId: "evt-mailbox-resolve",
					kind: "bridge_abnormal_exit",
				}),
			}),
		);

		const response = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "resolve",
				eventId: "evt-mailbox-resolve",
				draftId: "draft-mailbox",
			},
		});
		expect(response).toMatchObject({
			status: 200,
			body: { action: "resolve", lane: "mailbox" },
		});
		expect(store.getMailboxLedgerByEventId("evt-mailbox-resolve")).toEqual(
			expect.objectContaining({
				resolve_draft_id: "draft-mailbox",
				resolved_at: expect.any(String),
			}),
		);
	});

	it("renders every closure state on a paginated two-lane alert board", async () => {
		store.openAlertThread({
			correlationKey: "fw|lead-b|quota|",
			eventId: "evt-2",
			threadId: "root-2",
			rootMessageId: "root-2",
			channelId: "alerts",
			leadId: "lead-b",
			projectName: "flywheel",
			eventType: "quota",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		store.stampDutyAck("fw|lead-b|quota|", "evt-2");
		store.openAlertThread({
			correlationKey: "fw|lead-c|auth|",
			eventId: "evt-3",
			threadId: "root-3",
			rootMessageId: "root-3",
			channelId: "alerts",
			leadId: "lead-c",
			projectName: "flywheel",
			eventType: "auth",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:claude",
		});
		store.handoffLedger("thread", "fw|lead-c|auth|", "evt-3", {
			ownerRef: "lead:lead-c",
			reason: "contact_book",
			deliveryIdPrefix: "alert_handoff:thread:fw|lead-c|auth|:evt-3:lead-c",
		});
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "evt-4",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:evt-4",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "flywheel-eng-lead",
				routeClass: "duty_reroute",
				leadId: "fleet",
				projectName: "machine",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		store.bindResolveDraft(
			"mailbox",
			"machine|fleet|bridge_abnormal_exit|",
			"evt-4",
			"draft-four",
		);
		store.resolveMailboxLedger(
			"machine|fleet|bridge_abnormal_exit|",
			"evt-4",
			"draft-four",
		);
		const readHandoffSettlement = vi.fn(() => ({
			kind: "live" as const,
			state: "ACKED" as const,
		}));
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
				readHandoffSettlement,
				readBackfillDebt: () => ({
					owed: ["auth"],
					pending: 2,
					landed: 7,
				}),
				ledgerWriteErrors: () => 3,
				reroutedCount: () => 11,
			}),
		);

		const full = await request(app, {
			method: "GET",
			path: "/duty/alert-board?resolvedSince=2026-09-01T00%3A00%3A00.000Z&limit=10",
			token: "duty-token",
		});
		expect(full).toMatchObject({
			status: 200,
			body: {
				generatedAt: expect.any(String),
				dutyWritePath: "configured",
				ledgerWriteErrors: 3,
				reroutedCount: 11,
				totals: {
					unreviewed: 1,
					in_duty: 1,
					handed_off: 1,
					resolved_in_window: 1,
				},
				backfill: { owed: ["auth"], pending: 2, landed: 7 },
				truncated: false,
				nextCursor: null,
			},
		});
		const items = full.body.items as Array<Record<string, unknown>>;
		expect(items.map(({ eventId, state }) => [eventId, state])).toEqual([
			["evt-1", "unreviewed"],
			["evt-2", "in_duty"],
			["evt-3", "handed_off"],
			["evt-4", "resolved"],
		]);
		expect(items[2]).toMatchObject({
			lane: "thread",
			handoffLetter: "ACKED",
			fireCount: null,
		});
		expect(items[3]).toMatchObject({
			lane: "mailbox",
			handoffLetter: null,
			fireCount: 1,
		});

		const firstPage = await request(app, {
			method: "GET",
			path: "/duty/alert-board?resolvedSince=2026-09-01T00%3A00%3A00.000Z&limit=2",
			token: "duty-token",
		});
		expect(firstPage.body).toMatchObject({
			truncated: true,
			nextCursor: expect.any(String),
			totals: full.body.totals,
		});
		const nextPage = await request(app, {
			method: "GET",
			path: `/duty/alert-board?resolvedSince=2026-09-01T00%3A00%3A00.000Z&limit=2&cursor=${encodeURIComponent(String(firstPage.body.nextCursor))}`,
			token: "duty-token",
		});
		expect(
			(nextPage.body.items as Array<Record<string, unknown>>).map(
				(item) => item.eventId,
			),
		).toEqual(["evt-3", "evt-4"]);
	});

	it("validates board bounds and degrades a settlement read to UNKNOWN", async () => {
		store.handoffLedger("thread", "fw|lead-a|rate_limit|", "evt-1", {
			ownerRef: "lead:lead-a",
			reason: "contact_book",
			deliveryIdPrefix:
				"alert_handoff:thread:fw|lead-a|rate_limit|:evt-1:lead-a",
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
				readHandoffSettlement: () => {
					throw new Error("queue unavailable");
				},
			}),
		);

		for (const path of [
			"/duty/alert-board?limit=501",
			"/duty/alert-board?resolvedSince=not-a-date",
			"/duty/alert-board?cursor=not-a-cursor",
		]) {
			expect(
				(await request(app, { method: "GET", path, token: "duty-token" }))
					.status,
			).toBe(400);
		}
		const board = await request(app, {
			method: "GET",
			path: "/duty/alert-board",
			token: "duty-token",
		});
		expect(board.status).toBe(200);
		expect(board.body.items).toEqual([
			expect.objectContaining({
				eventId: "evt-1",
				handoffLetter: "UNKNOWN",
			}),
		]);
	});

	it("fails closed when duty auth is unconfigured or the locator is ambiguous", async () => {
		const unconfigured = express();
		unconfigured.use(express.json());
		unconfigured.use(
			"/duty",
			dutyAuth(),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);
		expect(
			(
				await request(unconfigured, {
					method: "GET",
					path: "/duty/alert-tickets/outstanding",
				})
			).status,
		).toBe(503);

		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [],
				getAlertHub: () => undefined,
			}),
		);
		for (const locator of [{}, { messageId: "root-1", eventId: "evt-1" }]) {
			const response = await request(app, {
				method: "POST",
				path: "/duty/alert-tickets/transition",
				token: "duty-token",
				body: { action: "ack", ...locator },
			});
			expect(response.status).toBe(400);
			expect(response.body.error).toBe("exactly_one_locator_required");
		}
	});

	it("keeps Codex-owned tickets ack-only", async () => {
		store.resolveAlertThread("fw|lead-a|rate_limit|", "evt-1");
		store.openAlertThread({
			correlationKey: "fw|lead-a|auth|",
			eventId: "evt-codex",
			threadId: "root-codex",
			rootMessageId: "root-codex",
			channelId: "alerts",
			leadId: "lead-a",
			projectName: "flywheel",
			eventType: "auth",
			ticketStatus: "NEW",
			ownerRef: "infra_bot:codex",
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/duty",
			dutyAuth("duty-token"),
			createAlertDutyRouter({
				store,
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botUserId: "222222222222222222",
							},
						],
					},
				] as never,
				getAlertHub: () => undefined,
			}),
		);
		const denied = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: {
				action: "handoff",
				eventId: "evt-codex",
				to: "flywheel-eng-lead",
				reason: "contact_book",
			},
		});
		expect(denied.status).toBe(409);
		expect(denied.body.error).toBe("codex_owner_ack_only");
		expect(store.getAlertThreadByEventId("evt-codex")?.acked_at).toBeNull();

		const acked = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "ack", eventId: "evt-codex" },
		});
		expect(acked.status).toBe(200);
	});

	it("exposes the late-bound dispatcher identity on the shared API probe", async () => {
		const dispatcher = { current: null as string | null };
		const app = express();
		app.use(
			"/api",
			createQueryRouter(store, [], {
				dispatcherBotUserId: () => dispatcher.current,
				dutyWritePath: () => "configured",
				ledgerWriteErrors: () => 2,
				reroutedCount: () => 4,
			}),
		);
		expect(
			(
				await request(app, {
					method: "GET",
					path: "/api/alert-duty/seat",
				})
			).body,
		).toEqual({
			dispatcherBotUserId: null,
			dutyWritePath: "configured",
			ledgerWriteErrors: 2,
			reroutedCount: 4,
		});
		dispatcher.current = "1524831623164596265";
		expect(
			(
				await request(app, {
					method: "GET",
					path: "/api/alert-duty/seat",
				})
			).body,
		).toEqual({
			dispatcherBotUserId: "1524831623164596265",
			dutyWritePath: "configured",
			ledgerWriteErrors: 2,
			reroutedCount: 4,
		});
	});
});
