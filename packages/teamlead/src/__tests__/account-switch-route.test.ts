import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import { createAccountSwitchRouter } from "../bridge/account-switch-route.js";

function request(
	app: express.Application,
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((done) => {
		const server = createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			const data = JSON.stringify(body);
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port,
					path: "/api/account-switch",
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
					},
				},
				(res: {
					statusCode: number;
					on: (event: string, cb: (chunk?: Buffer) => void) => void;
				}) => {
					let out = "";
					res.on("data", (chunk) => {
						out += chunk;
					});
					res.on("end", () => {
						server.close();
						done({
							status: res.statusCode,
							body: out ? JSON.parse(out) : {},
						});
					});
				},
			);
			req.write(data);
			req.end();
		});
	});
}

describe("POST /api/account-switch", () => {
	it("is permanently retired before request validation", async () => {
		const app = express();
		app.use(express.json());
		app.use("/api/account-switch", createAccountSwitchRouter());

		const response = await request(app, {});

		expect(response).toEqual({
			status: 410,
			body: {
				error: "retired",
				reason: "quota_daemon_cutover",
			},
		});
	});

	it(
		"keeps the outer tokenless deployment guard at 503",
		{ timeout: 30_000 },
		async () => {
			const { createBridgeApp } = await import("../bridge/plugin.js");
			const { StateStore } = await import("../StateStore.js");
			const store = await StateStore.create(":memory:");
			try {
				const app = createBridgeApp(store, [], {
					host: "127.0.0.1",
					port: 0,
					dbPath: ":memory:",
					notificationChannel: "test-channel",
					defaultLeadAgentId: "product-lead",
					stuckThresholdMinutes: 15,
					stuckCheckIntervalMs: 300_000,
					orphanThresholdMinutes: 60,
				});

				const response = await request(app, {});

				expect(response.status).toBe(503);
				expect(response.body.error).toBe(
					"account-switch API requires TEAMLEAD_API_TOKEN",
				);
			} finally {
				store.close();
			}
		},
	);
});
