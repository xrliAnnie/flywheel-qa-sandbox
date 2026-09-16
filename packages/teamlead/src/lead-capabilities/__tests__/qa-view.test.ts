import { afterEach, expect, it, vi } from "vitest";
import { QaViewServer } from "../qa-view.js";

const servers: QaViewServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});
it("denies mutation routes without calling providers", async () => {
	const snapshot = vi.fn(),
		run = vi.fn();
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot,
		run,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	for (const path of [
		"/api/fleet/stage",
		"/api/fleet/apply",
		"/api/fleet/changes/confirm",
		"/api/fleet/flag/test",
		"/api/runner-defaults/stage",
		"/api/fleet/runner/stage",
		"/api/fleet/runner/apply",
		"/api/fleet/re-qa/stage",
		"/api/fleet/gate-carrier-rebind/stage",
		"/api/fleet/gate-carrier-rebind/apply",
		"/api/runner-defaults/apply",
		"/api/re-qa/stage",
		"/api/gate-carrier-rebind/stage",
		"/api/gate-carrier-rebind/apply",
		"/actions/terminate",
		"/api/actions/merge",
		"/unknown",
	]) {
		for (const method of [
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"OPTIONS",
		]) {
			const response = await fetch(origin + path, { method });
			expect([403, 405]).toContain(response.status);
		}
	}
	expect(snapshot).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
});
const snapshotDto = {
	observedAt: "2026-09-13T00:00:00.000Z",
	leads: [
		{
			projectName: "flywheel",
			leadId: "eng",
			displayName: "<script>alert('x')</script>",
			backend: "codex-app-server",
			status: "ready",
		},
	],
};
const runDto = {
	observedAt: "2026-09-13T00:00:00.000Z",
	runId: "run-1",
	issueId: "FLY-2519",
	projectName: "flywheel",
	leadId: "eng",
	status: "running",
};
it("renders escaped read-only HTML and exact typed DTO routes", async () => {
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async () => snapshotDto,
		run: async () => runDto,
		allowedRunIds: () => new Set(["run-1"]),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const response = await fetch(`${origin}/`);
	expect(response.status).toBe(200);
	const html = await response.text();
	expect(html).toContain("只读验收视图");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("<form");
	expect(await (await fetch(`${origin}/api/fleet/snapshot`)).json()).toEqual(
		snapshotDto,
	);
	expect(await (await fetch(`${origin}/api/runs/run-1`)).json()).toEqual(
		runDto,
	);
	expect((await fetch(`${origin}/api/runs/foreign`)).status).toBe(403);
	expect(await (await fetch(`${origin}/`, { method: "HEAD" })).text()).toBe("");
});
it("denies method overrides and event streams before reading DTOs", async () => {
	const snapshot = vi.fn(async () => snapshotDto),
		run = vi.fn(async () => runDto);
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot,
		run,
		allowedRunIds: () => new Set(["run-1"]),
	});
	servers.push(server);
	const { origin } = await server.listen();
	for (const headers of [
		{ "x-http-method-override": "POST" },
		{ "x-method-override": "DELETE" },
		{ "x-http-method": "PATCH" },
		{ accept: "text/event-stream" },
	])
		expect(
			(await fetch(`${origin}/api/fleet/snapshot`, { headers })).status,
		).toBe(403);
	expect(snapshot).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
});
it("rejects oversized DTO responses without sending partial content", async () => {
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async () => ({
			...snapshotDto,
			leads: Array.from({ length: 500 }, () => ({
				...snapshotDto.leads[0]!,
				displayName: "x".repeat(512),
				status: "y".repeat(512),
			})),
		}),
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const response = await fetch(`${origin}/api/fleet/snapshot`);
	expect(response.status).toBe(403);
	expect(await response.text()).toBe("");
});
it("checks activation and run allowlist again after asynchronous reads", async () => {
	let valid = true;
	const snapshot = vi.fn(async () => {
		valid = false;
		return snapshotDto;
	});
	let allowed = new Set(["run-1"]);
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: (activation) => {
			expect(activation).toBe("a1");
			if (!valid) throw new Error("PRIVATE_CAUSE");
		},
		snapshot,
		run: async () => {
			allowed = new Set();
			return runDto;
		},
		allowedRunIds: () => allowed,
	});
	servers.push(server);
	const { origin } = await server.listen();
	const response = await fetch(`${origin}/`);
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("PRIVATE_CAUSE");
	await fetch(`${origin}/`);
	expect(snapshot).toHaveBeenCalledTimes(1);
	valid = true;
	expect((await fetch(`${origin}/api/runs/run-1`)).status).toBe(403);
});
it("rejects unexpected source fields instead of forwarding credentials", async () => {
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async () => ({ ...snapshotDto, token: "PRIVATE_TOKEN" }),
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const response = await fetch(`${origin}/api/fleet/snapshot`);
	expect(response.status).toBe(403);
	expect(await response.text()).toBe("");
});

import { connect } from "node:net";

it("refuses WebSocket upgrades and foreign Host without provider calls", async () => {
	const snapshot = vi.fn(async () => snapshotDto);
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot,
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const url = new URL(origin);
	for (const extra of ["Connection: Upgrade\r\nUpgrade: websocket\r\n", ""]) {
		const response = await new Promise<string>((resolve, reject) => {
			let received = "";
			const socket = connect(Number(url.port), "127.0.0.1", () =>
				socket.write(
					`GET / HTTP/1.1\r\nHost: ${extra ? url.host : "foreign.example"}\r\n${extra}Connection: close\r\n\r\n`,
				),
			);
			socket.on("data", (chunk) => {
				received += chunk;
			});
			socket.on("end", () => resolve(received));
			socket.on("error", reject);
		});
		expect(response).toContain("403");
	}
	expect(snapshot).not.toHaveBeenCalled();
});
it("cancels a pending DTO read when its browser request disconnects", async () => {
	let signal: AbortSignal | undefined,
		started = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async (context) => {
			signal = context.signal;
			started();
			return new Promise(() => {});
		},
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const controller = new AbortController();
	const request = fetch(`${origin}/api/fleet/snapshot`, {
		signal: controller.signal,
	}).catch(() => null);
	await ready;
	controller.abort();
	await request;
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(signal?.aborted).toBe(true);
});
it("caps accepted idle connections and closes them with concurrent shutdown", async () => {
	const snapshot = vi.fn(async () => snapshotDto);
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot,
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const port = Number(new URL(origin).port);
	const sockets: import("node:net").Socket[] = [];
	try {
		for (let i = 0; i < 65; i++) {
			const socket = connect(port, "127.0.0.1");
			sockets.push(socket);
			socket.on("error", () => {});
			await new Promise<void>((resolve) => socket.once("connect", resolve));
		}
		const overflow = sockets.at(-1)!;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(overflow.destroyed).toBe(true);
		await Promise.all([server.close(), server.close()]);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(sockets.every((socket) => socket.destroyed)).toBe(true);
		expect(snapshot).not.toHaveBeenCalled();
	} finally {
		for (const socket of sockets) socket.destroy();
	}
});
it("destroys an upgraded connection whose client leaves its half open", async () => {
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async () => snapshotDto,
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const { origin } = await server.listen();
	const url = new URL(origin);
	const socket = connect({
		port: Number(url.port),
		host: "127.0.0.1",
		allowHalfOpen: true,
	});
	socket.on("error", () => {});
	socket.resume();
	try {
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		const ended = new Promise<void>((resolve) => socket.once("end", resolve));
		socket.write(
			`GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
		);
		await ended;
		const closed = server.close();
		expect(
			await Promise.race([
				closed.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
			]),
		).toBe(true);
	} finally {
		socket.destroy();
	}
});

import { Server as HttpServer } from "node:http";

it("resets failed startup and hides raw socket errors before retry", async () => {
	const server = new QaViewServer({
		activationId: "a1",
		assertCurrent: () => {},
		snapshot: async () => snapshotDto,
		run: async () => runDto,
		allowedRunIds: () => new Set(),
	});
	servers.push(server);
	const listen = vi
		.spyOn(HttpServer.prototype, "listen")
		.mockImplementationOnce(function (this: HttpServer) {
			queueMicrotask(() =>
				this.emit("error", new Error("PRIVATE_SOCKET_CAUSE")),
			);
			return this;
		});
	try {
		await expect(server.listen()).rejects.toThrow("qa_view_listen_failed");
	} finally {
		listen.mockRestore();
	}
	const { origin } = await server.listen();
	expect((await fetch(`${origin}/`)).status).toBe(200);
});
