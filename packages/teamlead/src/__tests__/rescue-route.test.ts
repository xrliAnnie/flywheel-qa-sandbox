/**
 * FLY-871 R3/C9 — POST /api/rescue route: validation, byte-compat off (409), a
 * refusal is a valid 200 result, an unexpected throw is 500.
 */

import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
	createRescueRouter,
	type RescueRouteRuntime,
} from "../bridge/rescue-route.js";

function request(
	app: express.Application,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((done) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			const data = JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
					},
				},
				(res: {
					statusCode: number;
					on: (e: string, cb: (c?: Buffer) => void) => void;
				}) => {
					let out = "";
					res.on("data", (c) => {
						out += c;
					});
					res.on("end", () => {
						server.close();
						done({ status: res.statusCode, body: out ? JSON.parse(out) : {} });
					});
				},
			);
			req.write(data);
			req.end();
		});
	});
}

function makeApp(runtime: RescueRouteRuntime | undefined | "none") {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/rescue",
		createRescueRouter({
			getRuntime: () => (runtime === "none" ? undefined : runtime),
		}),
	);
	return app;
}

describe("POST /api/rescue", () => {
	it("rejects an unknown route (400)", async () => {
		const app = makeApp({ rescueLead: vi.fn(), rescueRunner: vi.fn() });
		const r = await request(app, "/api/rescue", { route: "wat" });
		expect(r.status).toBe(400);
	});

	it("route=lead requires projectName + leadId (400)", async () => {
		const app = makeApp({ rescueLead: vi.fn(), rescueRunner: vi.fn() });
		const r = await request(app, "/api/rescue", { route: "lead", leadId: "x" });
		expect(r.status).toBe(400);
	});

	it("route=runner requires executionId (400)", async () => {
		const app = makeApp({ rescueLead: vi.fn(), rescueRunner: vi.fn() });
		const r = await request(app, "/api/rescue", { route: "runner" });
		expect(r.status).toBe(400);
	});

	it("byte-compat: no runtime (self-heal off) → 409 needs_human, never rescues", async () => {
		const app = makeApp("none");
		const r = await request(app, "/api/rescue", {
			route: "lead",
			projectName: "growth",
			leadId: "mufasa-lead",
		});
		expect(r.status).toBe(409);
		expect(r.body.reason).toBe("self_heal_disabled");
	});

	it("lead rescue success → 200 with the outcome", async () => {
		const rescueLead = vi.fn(async () => ({
			ok: true,
			target: "lead:mufasa-lead",
		}));
		const app = makeApp({ rescueLead, rescueRunner: vi.fn() });
		const r = await request(app, "/api/rescue", {
			route: "lead",
			projectName: "growth",
			leadId: "mufasa-lead",
		});
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(rescueLead).toHaveBeenCalledWith({
			projectName: "growth",
			leadId: "mufasa-lead",
		});
	});

	it("a rescue REFUSAL (no pending alert) is a valid 200 result, not an error", async () => {
		const rescueRunner = vi.fn(async () => ({
			ok: false,
			target: "runner:exec-1",
			reason: "no_pending_runner_login_expired_alert",
		}));
		const app = makeApp({ rescueLead: vi.fn(), rescueRunner });
		const r = await request(app, "/api/rescue", {
			route: "runner",
			executionId: "exec-1",
		});
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(false);
		expect(r.body.reason).toBe("no_pending_runner_login_expired_alert");
	});

	it("an unexpected throw fails loud → 500", async () => {
		const rescueRunner = vi.fn(async () => {
			throw new Error("kaboom");
		});
		const app = makeApp({ rescueLead: vi.fn(), rescueRunner });
		const r = await request(app, "/api/rescue", {
			route: "runner",
			executionId: "exec-1",
		});
		expect(r.status).toBe(500);
	});
});

describe("FLY-927 Task 2.3: rescue call ACKs the ticket", () => {
	it("runner rescue fires ackTicket with the correlation inputs BEFORE the rescue", async () => {
		const calls: string[] = [];
		const app = makeApp({
			rescueLead: vi.fn(),
			rescueRunner: vi.fn(async () => {
				calls.push("rescue");
				return { outcome: "attempted", detail: "ok" } as never;
			}),
			ackTicket: (input) => {
				calls.push(`ack:${input.route}:${input.executionId}`);
			},
		});
		const res = await request(app, "/api/rescue", {
			route: "runner",
			executionId: "exec-9",
		});
		expect(res.status).toBe(200);
		expect(calls).toEqual(["ack:runner:exec-9", "rescue"]);
	});

	it("ackTicket throwing never fails the rescue", async () => {
		const app = makeApp({
			rescueLead: vi.fn(
				async () => ({ outcome: "attempted", detail: "ok" }) as never,
			),
			rescueRunner: vi.fn(),
			ackTicket: () => {
				throw new Error("ack broke");
			},
		});
		const res = await request(app, "/api/rescue", {
			route: "lead",
			projectName: "fw",
			leadId: "lead-a",
		});
		expect(res.status).toBe(200);
	});

	it("runtime WITHOUT ackTicket keeps working (byte-compat)", async () => {
		const app = makeApp({
			rescueLead: vi.fn(
				async () => ({ outcome: "attempted", detail: "ok" }) as never,
			),
			rescueRunner: vi.fn(),
		});
		const res = await request(app, "/api/rescue", {
			route: "lead",
			projectName: "fw",
			leadId: "lead-a",
		});
		expect(res.status).toBe(200);
	});
});
