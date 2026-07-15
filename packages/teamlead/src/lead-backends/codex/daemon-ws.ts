/**
 * FLY-259 PR-D — daemon-ws: the real WebSocket connection factory for the
 * remote-control daemon socket (deferred here from PR-B per code review R1
 * LOW-7). Resolves an OPEN `WsLike` (WsTransport requires a writable
 * connection — `ws` throws on send before open); rejects on pre-open
 * error/close. Post-open lifecycle (close/error → child-exit semantics) is
 * WsTransport's job; reconnection is the DaemonConnectionSupervisor's.
 */

import WebSocket from "ws";
import type { WsLike } from "./WsTransport.js";

export const DAEMON_SOCKET_RELPATH =
	"app-server-control/app-server-control.sock";

export function daemonSocketPath(codexHome: string): string {
	return `${codexHome}/${DAEMON_SOCKET_RELPATH}`;
}

export interface ConnectDaemonWsOptions {
	codexHome: string;
	/** Pre-open handshake timeout (default 10s). */
	connectTimeoutMs?: number;
	/** Injectable ctor for tests. */
	wsCtor?: (url: string) => WebSocket;
}

/** Connect to the daemon control socket; resolve once OPEN. */
export function connectDaemonWs(opts: ConnectDaemonWsOptions): Promise<WsLike> {
	const sock = daemonSocketPath(opts.codexHome);
	// `ws` supports WS-over-unix via the ws+unix scheme: socket path, then
	// `:` + request path (spike-verified handshake: HTTP/1.1 101).
	// CRITICAL (real-daemon verified): permessage-deflate MUST be disabled —
	// the codex daemon hangs up on the extension offer ("socket hang up");
	// with it off the handshake + initialize round-trip succeed.
	const url = `ws+unix://${sock}:/`;
	const ctor =
		opts.wsCtor ??
		((u: string) => new WebSocket(u, { perMessageDeflate: false }));
	const timeoutMs = opts.connectTimeoutMs ?? 10_000;
	return new Promise<WsLike>((resolve, reject) => {
		let settled = false;
		const ws = ctor(url);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			ws.terminate?.();
			reject(
				new Error(`daemon WS connect timeout after ${timeoutMs}ms (${sock})`),
			);
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		ws.on("open", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ws as unknown as WsLike);
		});
		ws.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`daemon WS connect failed (${sock}): ${err.message}`));
		});
		ws.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`daemon WS closed before open (${sock})`));
		});
	});
}
