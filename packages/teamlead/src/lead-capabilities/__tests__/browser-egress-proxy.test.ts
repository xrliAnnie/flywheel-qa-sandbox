import { createServer, get } from "node:http";
import { afterEach, expect, it } from "vitest";
import { startBrowserEgressProxy } from "../browser-egress-proxy.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
it("proxies exact QA origin to pinned address and refuses another local origin", async () => {
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(req.url!);
		res.end("fixture");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const port = (server.address() as { port: number }).port;
	const proxy = await startBrowserEgressProxy({
		policy: () => ({
			localQaTargets: [
				{ origin: `http://localhost:${port}`, address: "127.0.0.1" },
			],
			protectedPorts: [9876, 9222],
		}),
		assertCurrent: () => {},
	});
	cleanup.push(proxy.close);
	const read = (url: string) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			get(
				{ host: "127.0.0.1", port: proxy.port, path: url, agent: false },
				(res) => {
					let body = "";
					res.on("data", (c) => {
						body += c;
					});
					res.on("end", () => resolve({ status: res.statusCode!, body }));
				},
			).on("error", reject);
		});
	await expect(read(`http://localhost:${port}/report`)).resolves.toEqual({
		status: 200,
		body: "fixture",
	});
	await expect(read("http://127.0.0.1:9876/admin")).resolves.toMatchObject({
		status: 403,
	});
	expect(requests).toEqual(["/report"]);
});

it.each([4, 2 * 1024 * 1024])(
	"CONNECT uses the pinned QA endpoint and preserves a %i-byte reply",
	async (payloadSize) => {
		const { createServer: tcpServer, connect } = await import("node:net");
		const received: string[] = [];
		const upstream = tcpServer((socket) =>
			socket.on("data", (bytes) => {
				received.push(bytes.toString());
				socket.end("p".repeat(payloadSize));
			}),
		);
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		cleanup.push(
			() => new Promise<void>((resolve) => upstream.close(() => resolve())),
		);
		const port = (upstream.address() as { port: number }).port;
		const proxy = await startBrowserEgressProxy({
			policy: () => ({
				localQaTargets: [
					{ origin: `https://localhost:${port}`, address: "127.0.0.1" },
				],
				protectedPorts: [9876, 9222],
			}),
			assertCurrent: () => {},
		});
		cleanup.push(proxy.close);
		const response = await new Promise<string>((resolve, reject) => {
			const client = connect(proxy.port, "127.0.0.1", () =>
				client.write(
					`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\nping`,
				),
			);
			let result = "";
			client.pause();
			setTimeout(() => client.resume(), 25);
			client.setTimeout(2000, () => {
				client.destroy();
				reject(new Error("tunnel timeout"));
			});
			client.on("data", (chunk) => {
				result += chunk;
			});
			client.on("end", () => resolve(result));
			client.on("error", reject);
		});
		expect(response).toContain("200 Connection Established");
		expect(response.endsWith("p".repeat(payloadSize))).toBe(true);
		expect(received.join("")).toBe("ping");
	},
);

it("rejects authority revocation after DNS before any connection and closes idempotently", async () => {
	let current = true;
	const proxy = await startBrowserEgressProxy({
		policy: () => ({ localQaTargets: [], protectedPorts: [9876, 9222] }),
		assertCurrent: () => {
			if (!current) throw new Error("revoked");
		},
		lookup: async () => {
			current = false;
			return [{ address: "93.184.216.34", family: 4 }];
		},
	});
	cleanup.push(proxy.close);
	const status = await new Promise<number>((resolve, reject) =>
		get(
			{
				host: "127.0.0.1",
				port: proxy.port,
				path: "http://example.com",
				agent: false,
			},
			(res) => {
				res.resume();
				resolve(res.statusCode!);
			},
		).on("error", reject),
	);
	expect(status).toBe(403);
	await proxy.close();
	await proxy.close();
});
it("forwards WebSocket upgrade only to the pinned permitted QA origin", async () => {
	const { connect } = await import("node:net");
	const upstream = createServer();
	upstream.on("upgrade", (_req, socket, head) => {
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
		);
		if (head.length) socket.end(`echo:${head}`);
		else socket.once("data", (bytes) => socket.end(`echo:${bytes}`));
	});
	await new Promise<void>((resolve) =>
		upstream.listen(0, "127.0.0.1", resolve),
	);
	cleanup.push(
		() => new Promise<void>((resolve) => upstream.close(() => resolve())),
	);
	const port = (upstream.address() as { port: number }).port;
	const proxy = await startBrowserEgressProxy({
		policy: () => ({
			localQaTargets: [
				{ origin: `http://localhost:${port}`, address: "127.0.0.1" },
			],
			protectedPorts: [9876, 9222],
		}),
		assertCurrent: () => {},
	});
	cleanup.push(proxy.close);
	const result = await new Promise<string>((resolve, reject) => {
		const socket = connect(proxy.port, "127.0.0.1", () =>
			socket.write(
				`GET http://localhost:${port}/ws HTTP/1.1\r\nHost: ignored.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nping`,
			),
		);
		let body = "";
		socket.on("data", (c) => {
			body += c;
		});
		socket.on("end", () => resolve(body));
		socket.on("error", reject);
		socket.setTimeout(2000, () => {
			socket.destroy();
			reject(new Error("upgrade timeout"));
		});
	});
	expect(result).toContain("101 Switching Protocols");
	expect(result).toContain("echo:ping");
});

it.each(["http", "connect", "websocket"])(
	"cancels DNS when the %s client disconnects, without reaching another dispatch guard",
	async (kind) => {
		let checks = 0;
		let release!: (rows: Array<{ address: string; family: number }>) => void;
		let started!: () => void;
		const lookupStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const proxy = await startBrowserEgressProxy({
			policy: () => ({ localQaTargets: [], protectedPorts: [9876, 9222] }),
			assertCurrent: () => {
				checks++;
				if (checks > 2) throw new Error("unexpected late dispatch");
			},
			lookup: () => {
				started();
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		});
		cleanup.push(proxy.close);
		const { connect } = await import("node:net");
		const raw =
			kind === "connect"
				? "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"
				: `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n${kind === "websocket" ? "Connection: Upgrade\r\nUpgrade: websocket\r\n" : ""}\r\n`;
		const client = connect(proxy.port, "127.0.0.1", () => client.write(raw));
		client.on("error", () => {});
		await lookupStarted;
		await new Promise<void>((resolve) => {
			client.once("close", resolve);
			client.destroy();
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		release([{ address: "93.184.216.34", family: 4 }]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(checks).toBe(2);
	},
);
