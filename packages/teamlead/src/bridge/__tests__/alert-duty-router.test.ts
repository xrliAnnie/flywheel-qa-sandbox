import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createAlertDutyRouter, dutyAuth } from "../alert-duty-router.js";
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

	it("hands a ticket to a roster Lead and re-renders its mention", async () => {
		const renderTicketLine = vi.fn(async () => {});
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
		expect(response.status).toBe(200);
		expect(store.getAlertThreadByEventId("evt-1")).toEqual(
			expect.objectContaining({
				ticket_status: "ESCALATED",
				owner_ref: "lead:flywheel-eng-lead",
			}),
		);
		expect(renderTicketLine).toHaveBeenCalledWith(
			expect.objectContaining({ event_id: "evt-1" }),
			"<@222222222222222222>",
		);
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
			body: { action: "handoff", eventId: "evt-1", to: "missing-lead" },
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
			}),
		);
		const unavailable = await request(appWithoutHub, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1" },
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
			}),
		);
		const accepted = await request(app, {
			method: "POST",
			path: "/duty/alert-tickets/transition",
			token: "duty-token",
			body: { action: "resolve", eventId: "evt-1" },
		});
		expect(accepted.status).toBe(200);
		expect(resolve).toHaveBeenCalledWith("fw|lead-a|rate_limit|", "evt-1");
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
			}),
		);
		expect(
			(
				await request(app, {
					method: "GET",
					path: "/api/alert-duty/seat",
				})
			).body,
		).toEqual({ dispatcherBotUserId: null });
		dispatcher.current = "1524831623164596265";
		expect(
			(
				await request(app, {
					method: "GET",
					path: "/api/alert-duty/seat",
				})
			).body,
		).toEqual({ dispatcherBotUserId: "1524831623164596265" });
	});
});
