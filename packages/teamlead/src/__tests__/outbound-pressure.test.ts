import { describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { StateStore } from "../StateStore.js";

describe("outbound HTTP pressure", () => {
	it("exposes counters for all three Bridge routes in health", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			ingestToken: "test-token",
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
		});
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing server address");
		const base = `http://127.0.0.1:${address.port}`;
		try {
			for (const path of [
				"/events",
				"/api/workflow/decision",
				"/api/lead-inbox/nudge",
			]) {
				await (
					await fetch(base + path, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: "Bearer test-token",
						},
						body: "{}",
					})
				).text();
			}
			const health = await (await fetch(`${base}/health`)).json();
			expect(health.ok).toBe(true);
			for (const route of ["events", "workflow_decision", "lead_inbox_nudge"]) {
				expect(health.outbound_pressure?.[route]).toMatchObject({
					requests_total: 1,
					finished_total: 1,
					response_closed_before_finish_total: 0,
				});
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	});
});
