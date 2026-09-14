import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
	bindingFixture,
	NOW,
} from "../../ship-judgment/__tests__/binding-fixture.js";

it(
	"serves authenticated read-only statistics while off and rejects invalid scope",
	{ timeout: 30000 },
	async () => {
		const { createBridgeApp } = await import("../plugin.js");
		const { store, db } = await bindingFixture();
		const app = createBridgeApp(
			store,
			[{ projectName: "flywheel", projectRoot: "/tmp/fixture", leads: [] }],
			{
				host: "127.0.0.1",
				port: 0,
				dbPath: ":memory:",
				notificationChannel: "fixture",
				defaultLeadAgentId: "lead",
				stuckThresholdMinutes: 15,
				stuckCheckIntervalMs: 300000,
				orphanThresholdMinutes: 60,
				apiToken: "fixture-api-token",
			} as import("../types.js").BridgeConfig,
		);
		const server = createServer(app);
		try {
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/ship-judgment/report`;
			const query = new URLSearchParams({
				project: "flywheel",
				from: NOW,
				to: "2026-09-12T00:00:00.000Z",
				asOf: "2026-09-12T00:00:00.000Z",
			});
			expect((await fetch(`${base}?${query}`)).status).toBe(401);
			const headers = { Authorization: "Bearer fixture-api-token" };
			const showUrl =
				base.replace("/report", "/show") + "?project=flywheel&question=q";
			const shown = await fetch(showUrl, { headers });
			expect(shown.status).toBe(200);
			expect(await shown.json()).toMatchObject({
				schema_version: 1,
				questionId: "q",
				records: [],
			});
			expect((await fetch(showUrl + "&id=extra", { headers })).status).toBe(
				400,
			);
			expect(
				(
					await fetch(
						base.replace("/report", "/show") + "?project=flywheel&id=missing",
						{ headers },
					)
				).status,
			).toBe(404);
			const before = db.prepare("SELECT total_changes() AS n").get();
			const response = await fetch(`${base}?${query}`, { headers });
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toMatchObject({
				schema_version: 1,
				source: "machine",
				policy: "ship-judgment-v1",
				report: { project: "flywheel", outcomeRecords: 0 },
			});
			expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
			const { runShipJudgment } = await import(
				"../../../../flywheel-comm/src/commands/ship-judgment.js"
			);
			const output: string[] = [];
			expect(
				await runShipJudgment(
					[
						"report",
						"--project",
						"flywheel",
						"--from",
						NOW,
						"--to",
						"2026-09-12T00:00:00.000Z",
						"--as-of",
						"2026-09-12T00:00:00.000Z",
					],
					{
						env: {
							TEAMLEAD_API_TOKEN: "fixture-api-token",
							BRIDGE_URL: new URL(base).origin,
						},
						log: (value) => output.push(value),
					},
				),
			).toBe(0);
			expect(JSON.parse(output[0]!)).toEqual(body);
			output.length = 0;
			expect(
				await runShipJudgment(
					["show", "--project", "flywheel", "--question", "q"],
					{
						env: {
							TEAMLEAD_API_TOKEN: "fixture-api-token",
							BRIDGE_URL: new URL(base).origin,
						},
						log: (value) => output.push(value),
					},
				),
			).toBe(0);
			expect(JSON.parse(output[0]!)).toMatchObject({
				questionId: "q",
				records: [],
			});
			expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
			for (const suffix of ["&project=raya", "&extra=1", "&from=bad"]) {
				expect(
					(await fetch(`${base}?${query}${suffix}`, { headers })).status,
				).toBe(400);
			}
			expect(
				(await fetch(`${base}?${query}`, { method: "POST", headers })).status,
			).toBe(404);
			db.exec("DROP TABLE ship_judgment_outcome");
			const failed = await fetch(`${base}?${query}`, { headers });
			expect(failed.status).toBe(503);
			expect(await failed.json()).toEqual({ error: "statistics_read_failed" });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	},
);

it.each([false, true])(
	"rejects statistics access without a valid master token (configured=%s)",
	{ timeout: 30000 },
	async (configured) => {
		const { createBridgeApp } = await import("../plugin.js");
		const { store } = await bindingFixture();
		const app = createBridgeApp(store, [], {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "fixture",
			defaultLeadAgentId: "lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			...(configured ? { apiToken: "fixture-master" } : {}),
			geminiAgentToken: "fixture-scoped",
		} as import("../types.js").BridgeConfig);
		const server = createServer(app);
		try {
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/ship-judgment/report?project=flywheel&from=${NOW}&to=2026-09-12T00:00:00.000Z`;
			const response = await fetch(url, {
				headers: { Authorization: "Bearer fixture-scoped" },
			});
			expect(response.status).toBe(configured ? 403 : 503);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	},
);
