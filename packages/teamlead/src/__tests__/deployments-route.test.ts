/**
 * FLY-727: /api/deployments ingestion route — validation + auth mount.
 */

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeploymentsRouter } from "../bridge/deployments-route.js";
import { StateStore } from "../StateStore.js";

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

describe("/api/deployments/report validation", () => {
	let store: StateStore;
	let app: express.Application;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		app = express();
		app.use(express.json());
		app.use("/api/deployments", createDeploymentsRouter(store));
	});
	afterEach(() => store.close());

	it("400 without projectName/source", async () => {
		const r = await request(app, "/api/deployments/report", {
			projectName: "flywheel",
		});
		expect(r.status).toBe(400);
	});

	it("400 without issue or pr", async () => {
		const r = await request(app, "/api/deployments/report", {
			projectName: "flywheel",
			source: "self-ship",
			mergeSha: "a".repeat(40),
		});
		expect(r.status).toBe(400);
	});

	it("400 without any event identity", async () => {
		const r = await request(app, "/api/deployments/report", {
			projectName: "flywheel",
			source: "self-ship",
			issueIdentifier: "FLY-1",
		});
		expect(r.status).toBe(400);
	});

	it("400 on non-40hex mergeSha", async () => {
		const r = await request(app, "/api/deployments/report", {
			projectName: "flywheel",
			source: "self-ship",
			issueIdentifier: "FLY-1",
			mergeSha: "nope",
		});
		expect(r.status).toBe(400);
	});

	it("200 + inserted on a valid report; second identical → inserted=false", async () => {
		const body = {
			projectName: "flywheel",
			source: "self-ship",
			issueIdentifier: "FLY-1",
			prNumber: 7,
			mergeSha: "b".repeat(40),
			deployedSha: "c".repeat(40),
			deployedAt: "2026-06-30 20:00:00",
		};
		const r1 = await request(app, "/api/deployments/report", body);
		expect(r1.status).toBe(200);
		expect(r1.body.inserted).toBe(true);
		const r2 = await request(app, "/api/deployments/report", body);
		expect(r2.status).toBe(200);
		expect(r2.body.inserted).toBe(false); // dedup
		const rows = store.getDeploymentEventsInRange(
			"2026-06-30 00:00:00",
			"2026-07-01 00:00:00",
		);
		expect(rows).toHaveLength(1);
	});
});
