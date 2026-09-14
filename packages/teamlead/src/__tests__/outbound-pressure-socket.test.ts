import { once } from "node:events";
import { request } from "node:http";
import express from "express";
import { expect, it, vi } from "vitest";
import { OutboundPressureMeter } from "../bridge/outbound-pressure.js";

it("counts server socket destruction without finish and preserves the maximum finish latency", async () => {
	let now = 1000;
	const span = vi.fn();
	const meter = new OutboundPressureMeter({ now: () => now, recordSpan: span });
	let closed!: () => void;
	const destroyed = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const app = express();
	app.use(meter.observe("events"));
	app.get("/destroy", (_req, res) => {
		now += 800;
		res.once("close", closed);
		res.destroy();
	});
	app.get("/slow", (_req, res) => {
		now += 700;
		res.end();
	});
	app.get("/fast", (_req, res) => {
		now += 100;
		res.end();
	});
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing address");
	const base = `http://127.0.0.1:${address.port}`;
	try {
		await expect(fetch(`${base}/destroy`)).rejects.toThrow();
		await destroyed;
		expect(meter.snapshot().events).toMatchObject({
			requests_total: 1,
			finished_total: 0,
			response_closed_before_finish_total: 1,
			max_finish_ms: 0,
			slow_total: 0,
			last_closed_before_finish_after_ms: 800,
		});
		await (await fetch(`${base}/slow`)).text();
		await (await fetch(`${base}/fast`)).text();
		expect(meter.snapshot().events).toMatchObject({
			requests_total: 3,
			finished_total: 2,
			response_closed_before_finish_total: 1,
			max_finish_ms: 700,
			slow_total: 1,
		});
		expect(span).toHaveBeenCalledExactlyOnceWith("http:events", 1800, 2500);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("counts finished responses and actual disconnected sockets separately", async () => {
	let now = 1000;
	const recordSpan = vi.fn();
	const meter = new OutboundPressureMeter({ now: () => now, recordSpan });
	let disconnected!: () => void;
	const closed = new Promise<void>((resolve) => {
		disconnected = resolve;
	});
	let received!: () => void;
	const entered = new Promise<void>((resolve) => {
		received = resolve;
	});
	const app = express();
	app.get("/finished", meter.observe("events"), (_req, res) => {
		now += 501;
		res.json({ ok: true });
	});
	app.get("/boundary", meter.observe("lead_inbox_nudge"), (_req, res) => {
		now += 500;
		res.end();
	});
	app.get("/disconnect", meter.observe("workflow_decision"), (_req, res) => {
		now += 800;
		res.once("close", disconnected);
		received();
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing server address");
	try {
		await (await fetch(`http://127.0.0.1:${address.port}/finished`)).json();
		const req = request(`http://127.0.0.1:${address.port}/disconnect`);
		req.on("error", () => {});
		req.end();
		await entered;
		req.destroy();
		await closed;
		expect(meter.snapshot().events).toMatchObject({
			requests_total: 1,
			finished_total: 1,
			slow_total: 1,
			max_finish_ms: 501,
			response_closed_before_finish_total: 0,
		});
		expect(meter.snapshot().workflow_decision).toMatchObject({
			requests_total: 1,
			finished_total: 0,
			slow_total: 0,
			max_finish_ms: 0,
			response_closed_before_finish_total: 1,
			last_closed_before_finish_after_ms: 800,
			last_closed_before_finish_at: new Date(now).toISOString(),
		});
		await (await fetch(`http://127.0.0.1:${address.port}/boundary`)).text();
		expect(meter.snapshot().lead_inbox_nudge).toMatchObject({
			requests_total: 1,
			finished_total: 1,
			slow_total: 0,
			max_finish_ms: 500,
			response_closed_before_finish_total: 0,
		});
		expect(recordSpan).toHaveBeenCalledExactlyOnceWith(
			"http:events",
			1000,
			1501,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
