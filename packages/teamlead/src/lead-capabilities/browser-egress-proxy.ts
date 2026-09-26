import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { createConnection, type Socket } from "node:net";
import {
	type BrowserEgressAddress,
	type BrowserEgressPolicy,
	resolveBrowserEgressTarget,
} from "./browser-egress.js";

/**
 * FLY-2886 upstream-chain proof. Codex's managed sandbox proxy forwards only
 * publicly resolvable hosts, so the probe uses one; this proxy answers the exact
 * URL itself before any resolution. A request that bypasses this proxy reaches
 * the real host and is never recorded here.
 */
export const EGRESS_PROBE_URL_PREFIX =
	"http://example.com/.well-known/flywheel-egress-probe/";
const PROBE_NONCE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PENDING_PROBES = 64;
function egressProbeNonce(raw: string | undefined): string | undefined {
	if (!raw?.startsWith(EGRESS_PROBE_URL_PREFIX)) return undefined;
	const nonce = raw.slice(EGRESS_PROBE_URL_PREFIX.length);
	return PROBE_NONCE.test(nonce) ? nonce : undefined;
}
export interface BrowserEgressProxyOptions {
	policy(): BrowserEgressPolicy;
	assertCurrent(): void;
	lookup?: (hostname: string) => Promise<BrowserEgressAddress[]>;
	/** Bound on establishing a CONNECT tunnel (default 30s). */
	connectTimeoutMs?: number;
}
function headers(input: IncomingHttpHeaders): IncomingHttpHeaders {
	const blocked = new Set([
		"connection",
		"proxy-connection",
		"proxy-authorization",
		"proxy-authenticate",
		"keep-alive",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
	]);
	for (const name of (input.connection ?? "").split(","))
		blocked.add(name.trim().toLowerCase());
	return Object.fromEntries(
		Object.entries(input).filter(([name]) => !blocked.has(name.toLowerCase())),
	);
}
/** Activation-scoped forward proxy. The OS sandbox must be configured separately
 * to make this its only network destination. No credentials/logged URLs here. */
export async function startBrowserEgressProxy(
	options: BrowserEgressProxyOptions,
) {
	options.assertCurrent();
	const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
	const lifetime = new AbortController();
	const sockets = new Set<Socket>();
	const probes = new Set<string>();
	const server = createServer(
		{ maxHeaderSize: 16 * 1024 },
		async (incoming, response) => {
			const connection = new AbortController();
			const signal = AbortSignal.any([lifetime.signal, connection.signal]);
			incoming.once("aborted", () => connection.abort());
			response.once("close", () => connection.abort());
			const deny = () => {
				if (!response.headersSent) {
					response.writeHead(403, { connection: "close" });
					response.end("browser_egress_denied");
				} else response.destroy();
			};
			try {
				options.assertCurrent();
				const probe = egressProbeNonce(incoming.url);
				if (probe && incoming.method === "GET") {
					if (probes.size < MAX_PENDING_PROBES) probes.add(probe);
					response.writeHead(204, { connection: "close" });
					response.end();
					return;
				}
				const policy = options.policy();
				const revision = JSON.stringify(policy);
				const target = await resolveBrowserEgressTarget(incoming.url ?? "", {
					policy,
					lookup: options.lookup,
					signal,
				});
				options.assertCurrent();
				if (revision !== JSON.stringify(options.policy()) || signal.aborted)
					throw new Error("revoked");
				const url = new URL(target.url);
				if (url.protocol !== "http:") throw new Error("CONNECT required");
				const outgoing = request(
					{
						hostname: target.address,
						family: target.family,
						port: target.port,
						method: incoming.method,
						path: `${url.pathname}${url.search}`,
						headers: { ...headers(incoming.headers), host: url.host },
						agent: false,
						signal,
					},
					(upstream) => {
						response.writeHead(
							upstream.statusCode ?? 502,
							headers(upstream.headers),
						);
						upstream.on("error", () => response.destroy());
						upstream.pipe(response);
					},
				);
				outgoing.on("socket", (socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
				});
				outgoing.setTimeout(30_000, () => outgoing.destroy());
				outgoing.on("error", () => {
					if (!response.headersSent) {
						response.writeHead(502, { connection: "close" });
						response.end("browser_egress_unavailable");
					} else response.destroy();
				});
				incoming.once("aborted", () => outgoing.destroy());
				response.once("close", () => outgoing.destroy());
				incoming.pipe(outgoing);
			} catch {
				deny();
			}
		},
	);
	server.on("upgrade", async (incoming, client, head) => {
		const connection = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, connection.signal]);
		client.once("close", () => connection.abort());
		client.once("end", () => connection.abort());
		client.on("error", () => client.destroy());
		try {
			options.assertCurrent();
			if (
				incoming.method !== "GET" ||
				incoming.headers.upgrade?.toLowerCase() !== "websocket"
			)
				throw new Error("invalid upgrade");
			const policy = options.policy();
			const revision = JSON.stringify(policy);
			const target = await resolveBrowserEgressTarget(
				(incoming.url ?? "").replace(/^ws:\/\//, "http://"),
				{ policy, lookup: options.lookup, signal },
			);
			options.assertCurrent();
			if (
				client.destroyed ||
				signal.aborted ||
				revision !== JSON.stringify(options.policy())
			)
				throw new Error("revoked");
			const url = new URL(target.url);
			if (url.protocol !== "http:") throw new Error("CONNECT required");
			const outgoing = request({
				hostname: target.address,
				family: target.family,
				port: target.port,
				method: "GET",
				path: `${url.pathname}${url.search}`,
				headers: {
					...headers(incoming.headers),
					host: url.host,
					connection: "Upgrade",
					upgrade: "websocket",
				},
				agent: false,
				signal,
			});
			outgoing.on("socket", (socket) => {
				sockets.add(socket);
				socket.once("close", () => sockets.delete(socket));
			});
			outgoing.on("error", () => client.destroy());
			outgoing.setTimeout(30_000, () => outgoing.destroy());
			outgoing.on("response", (res) => {
				res.resume();
				outgoing.destroy();
				client.destroy();
			});
			outgoing.on("upgrade", (res, upstream, upstreamHead) => {
				try {
					options.assertCurrent();
					if (
						signal.aborted ||
						revision !== JSON.stringify(options.policy()) ||
						res.statusCode !== 101 ||
						res.headers.upgrade?.toLowerCase() !== "websocket"
					)
						throw new Error("invalid upgrade");
					const safeHeaders = {
						...headers(res.headers),
						connection: "Upgrade",
						upgrade: "websocket",
					};
					client.write(
						`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(safeHeaders)
							.flatMap(([name, value]) =>
								(Array.isArray(value) ? value : [value])
									.filter((value) => value !== undefined)
									.map((value) => `${name}: ${value}\r\n`),
							)
							.join("")}\r\n`,
					);
					upstream.on("error", () => client.destroy());
					upstream.once("close", () => client.end());
					client.once("close", () => upstream.destroy());
					upstream.setTimeout(30_000, () => upstream.destroy());
					if (upstreamHead.length) client.write(upstreamHead);
					if (head.length) upstream.write(head);
					client.pipe(upstream);
					upstream.pipe(client);
				} catch {
					upstream.destroy();
					client.destroy();
				}
			});
			client.once("close", () => outgoing.destroy());
			outgoing.end();
		} catch {
			client.end(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
		}
	});
	server.on("connect", async (incoming, client, head) => {
		const connection = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, connection.signal]);
		client.once("close", () => connection.abort());
		client.once("end", () => connection.abort());
		client.on("error", () => client.destroy());
		try {
			options.assertCurrent();
			const authority = incoming.url ?? "";
			if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):[0-9]{1,5}$/.test(authority))
				throw new Error("invalid CONNECT authority");
			const policy = options.policy();
			const revision = JSON.stringify(policy);
			const target = await resolveBrowserEgressTarget(`https://${authority}`, {
				policy,
				lookup: options.lookup,
				signal,
			});
			options.assertCurrent();
			if (
				client.destroyed ||
				signal.aborted ||
				revision !== JSON.stringify(options.policy())
			)
				throw new Error("revoked");
			const upstream = createConnection({
				host: target.address,
				port: target.port,
				family: target.family,
			});
			sockets.add(upstream);
			upstream.once("close", () => {
				sockets.delete(upstream);
				client.end();
			});
			upstream.on("error", () => client.destroy());
			client.once("close", () => upstream.destroy());
			upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
			upstream.once("connect", () => {
				try {
					options.assertCurrent();
					if (signal.aborted || revision !== JSON.stringify(options.policy()))
						throw new Error("revoked");
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					// Only establishing is time-bounded. Codex's own model and realtime
					// websockets ride these tunnels (FLY-2886 ruling B); a quiet voice
					// session must not be cut. Close/revocation still tear them down.
					upstream.setTimeout(0);
					// The CONNECT client is the proxy's own net.Socket.
					(client as Socket).setTimeout(0);
					if (head.length) upstream.write(head);
					client.pipe(upstream);
					upstream.pipe(client);
				} catch {
					upstream.destroy();
					client.destroy();
				}
			});
		} catch {
			client.end(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
		}
	});
	server.maxConnections = 64;
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.setTimeout(connectTimeoutMs, () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("browser_proxy_start_failed");
	let closing: Promise<void> | undefined;
	return {
		port: address.port,
		/** True once per recorded probe nonce; the observation is consumed. */
		probeSeen: (nonce: string) => probes.delete(nonce),
		close: () => {
			closing ??= new Promise<void>((resolve) => {
				lifetime.abort();
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			});
			return closing;
		},
	};
}
