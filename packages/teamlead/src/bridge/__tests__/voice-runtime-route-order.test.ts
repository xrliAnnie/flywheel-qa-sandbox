import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { type BridgeAppOptions, createBridgeApp } from "../plugin.js";
import { RunnerAdmissionController } from "../runner-admission.js";

it("mounts runtime headphone and handoff routers before the catch-all", async () => {
	const store = await StateStore.create(":memory:");
	const headphone = express.Router().get("/probe", (_req, res) => {
		res.json({ route: "headphone" });
	});
	const handoffs = express.Router().get("/probe", (_req, res) => {
		res.json({ route: "handoffs" });
	});
	const routeHolders = {
		headphoneRouter: { current: headphone },
		voiceHandoffRouter: { current: handoffs },
	} as unknown as BridgeAppOptions;
	const app = createBridgeApp(
		store,
		[],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300_000,
			orphanThresholdMinutes: 60,
			apiToken: "master",
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		routeHolders,
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		for (const [path, route] of [
			["/api/voice/headphone/probe", "headphone"],
			["/api/voice/handoffs/probe", "handoffs"],
		] as const) {
			const response = await fetch(`${base}${path}`, {
				headers: { Authorization: "Bearer master" },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ route });
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	}
});

it("FLY-2863: mounts the agenda routes; Lead commands take the ingest token without being shadowed", async () => {
	const store = await StateStore.create(":memory:");
	const agenda = express.Router().get("/probe", (_req, res) => {
		res.json({ route: "agenda" });
	});
	const lead = express.Router().post("/results", (_req, res) => {
		res.json({ route: "lead" });
	});
	const routeHolders = {
		voiceAgendaRouter: { current: agenda },
		voiceAgendaLeadRouter: { current: lead },
	} as unknown as BridgeAppOptions;
	const app = createBridgeApp(
		store,
		[],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300_000,
			orphanThresholdMinutes: 60,
			apiToken: "master",
			ingestToken: "ingest",
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		routeHolders,
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const probe = await fetch(`${base}/api/voice/agenda/probe`, {
			headers: { Authorization: "Bearer master" },
		});
		expect(await probe.json()).toEqual({ route: "agenda" });
		const ingestOnAgenda = await fetch(`${base}/api/voice/agenda/probe`, {
			headers: { Authorization: "Bearer ingest" },
		});
		expect(ingestOnAgenda.status).toBe(401);
		const leadResult = await fetch(`${base}/api/voice/agenda/lead/results`, {
			method: "POST",
			headers: { Authorization: "Bearer ingest" },
		});
		expect(leadResult.status).toBe(200);
		expect(await leadResult.json()).toEqual({ route: "lead" });
		const noToken = await fetch(`${base}/api/voice/agenda/lead/results`, {
			method: "POST",
		});
		expect(noToken.status).toBe(401);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	}
});
