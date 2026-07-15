/**
 * FLY-1188 M4b — the real WebSocket-over-unix transport for the runner-side
 * codex remote-control daemon. Wraps a `ws` connection to the daemon's control
 * socket in the object-framed `DaemonTransport` that CodexDaemonClient consumes
 * (one JSON document per WS text frame — no line buffering, unlike teamlead's
 * WsTransport which serves CodexLeadProcess's line-oriented contract).
 *
 * Dependency-direction note: claude-runner MUST NOT import teamlead (teamlead
 * depends on claude-runner). The wire details are reimplemented here, mirroring
 * the verified precedent (teamlead lead-backends/codex/daemon-ws.ts):
 *   - the `ws+unix://<sock>:/` scheme (socket path, then `:` + request path);
 *   - permessage-deflate MUST be disabled — the daemon hangs up on the
 *     extension offer ("socket hang up"); with it off the handshake succeeds;
 *   - resolve only once the socket is OPEN (ws throws on send before open).
 *
 * The WS endpoint is INJECTED (`WsLike`, which the real `ws` satisfies) so the
 * transport is unit-testable with a fake — the same seam the lead precedent
 * uses.
 */

import type { DaemonTransport } from "./codex-daemon-client.js";

/** The daemon's control socket, relative to CODEX_HOME (matches the daemon). */
export const DAEMON_SOCKET_RELPATH =
	"app-server-control/app-server-control.sock";

export function daemonSocketPath(codexHome: string): string {
	return `${codexHome}/${DAEMON_SOCKET_RELPATH}`;
}

/** Standard WebSocket.readyState for an OPEN socket. */
const WS_OPEN = 1;
/**
 * Cap the pre-registration replay buffer. The window between wrapping the ws
 * and `new CodexDaemonClient(...)` is synchronous, so this is only ever hit by
 * a misbehaving/hostile peer — treat overflow as a fatal transport fault.
 */
const MAX_PENDING_FRAMES = 1024;

/** Minimal WebSocket surface the transport needs (injectable; `ws` satisfies). */
export interface WsLike {
	/**
	 * `ws.send` takes an optional completion callback that reports an ASYNC
	 * write error (real `ws` only THROWS synchronously while CONNECTING; in
	 * CLOSING/CLOSED with no callback it returns silently).
	 */
	send(data: string, cb?: (err?: Error) => void): void;
	close(): void;
	/** Hard teardown; `ws` exposes terminate(). */
	terminate?(): void;
	/** Standard WebSocket readyState (0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED). */
	readyState?: number;
	on(event: "message", cb: (data: unknown) => void): void;
	on(event: "close", cb: (code?: number) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	on(event: "open", cb: () => void): void;
}

/**
 * A `DaemonTransport` over a `ws` connection: JSON-serialize each outbound
 * frame to one text message; JSON-parse each inbound text message to one frame.
 * Close/error surface as a single `onClose` (child-exit semantics — the client
 * rejects pending requests; reconnection is a level up, never in-transport).
 */
export class WsDaemonTransport implements DaemonTransport {
	private readonly ws: WsLike;
	private msgHandler: ((frame: unknown) => void) | undefined;
	private closeHandler: ((reason: string) => void) | undefined;
	private closed = false;
	// Frames / a close that arrive before the client registers its handlers are
	// buffered and replayed on registration, so nothing is dropped in the tiny
	// window between wrap and `new CodexDaemonClient(...)`.
	private readonly pendingFrames: unknown[] = [];
	private pendingCloseReason: string | null = null;

	constructor(ws: WsLike) {
		this.ws = ws;
		this.ws.on("message", (data: unknown) => this.onWsMessage(data));
		this.ws.on("close", (code?: number) =>
			this.onWsClose(`daemon socket closed${code != null ? ` (${code})` : ""}`),
		);
		this.ws.on("error", (err: Error) =>
			this.onWsClose(`daemon socket error: ${err.message}`),
		);
	}

	private onWsMessage(data: unknown): void {
		// R-M4b LOW: once closed, drop every late frame — a frame that arrives
		// after close must NOT be replayed ahead of the pending close (that would
		// invert the wire order the client sees).
		if (this.closed) return;
		let frame: unknown;
		try {
			frame = JSON.parse(typeof data === "string" ? data : String(data));
		} catch {
			// A non-JSON frame is unusable — drop it (the client only speaks
			// JSON-RPC; a garbled frame can't resolve or notify anything).
			return;
		}
		if (this.msgHandler) {
			this.msgHandler(frame);
			return;
		}
		if (this.pendingFrames.length >= MAX_PENDING_FRAMES) {
			// Runaway pre-registration buffering is a fault, not backpressure —
			// fail the transport closed rather than grow without bound.
			this.onWsClose("pre-registration frame buffer overflow");
			return;
		}
		this.pendingFrames.push(frame);
	}

	private onWsClose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		if (this.closeHandler) this.closeHandler(reason);
		else this.pendingCloseReason = reason;
	}

	send(frame: unknown): void {
		// R-M4b MEDIUM: the M4a client relies on a SYNCHRONOUS throw to fail
		// closed on a fatal write (R21). Real `ws` only throws synchronously
		// while CONNECTING; in CLOSING/CLOSED (no callback) it returns silently
		// — so guard readyState ourselves (a non-open socket → throw now), and
		// route any ASYNC write error to onClose so a late failure still surfaces.
		if (
			this.closed ||
			(this.ws.readyState != null && this.ws.readyState !== WS_OPEN)
		) {
			throw new Error(
				`cannot send on a non-open daemon socket (readyState=${this.ws.readyState ?? "unknown"})`,
			);
		}
		this.ws.send(JSON.stringify(frame), (err?: Error) => {
			if (err) this.onWsClose(`daemon socket send failed: ${err.message}`);
		});
	}

	onMessage(handler: (frame: unknown) => void): void {
		this.msgHandler = handler;
		// Replay anything buffered before registration, in order.
		while (this.pendingFrames.length > 0) {
			const frame = this.pendingFrames.shift();
			handler(frame);
		}
	}

	onClose(handler: (reason: string) => void): void {
		this.closeHandler = handler;
		if (this.pendingCloseReason !== null) {
			const reason = this.pendingCloseReason;
			this.pendingCloseReason = null;
			handler(reason);
		}
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// Already gone — force it down and let the close handler settle.
			this.ws.terminate?.();
		}
	}
}

export interface ConnectDaemonTransportOptions {
	/**
	 * Explicit control-socket path. Takes precedence over `codexHome`. Use this
	 * when the daemon listens on a path NOT under CODEX_HOME (the runner daemon
	 * uses a SUN_LEN-safe short socket path independent of its CODEX_HOME).
	 */
	socketPath?: string;
	/**
	 * CODEX_HOME to derive the socket path from (the lead-side convention:
	 * `<CODEX_HOME>/app-server-control/app-server-control.sock`). Ignored when
	 * `socketPath` is given.
	 */
	codexHome?: string;
	/** Pre-open handshake timeout (default 10s). */
	connectTimeoutMs?: number;
	/**
	 * Injectable ws constructor (default: the real `ws` with
	 * permessage-deflate off). Tests pass a fake to avoid a live socket.
	 */
	wsCtor?: (url: string) => WsLike;
}

/**
 * Connect to the runner daemon's control socket and resolve a
 * `DaemonTransport` once the socket is OPEN. Rejects on pre-open
 * error/close/timeout (ws throws on send before open, so an unopened socket
 * must never reach the client).
 */
export async function connectDaemonTransport(
	opts: ConnectDaemonTransportOptions,
): Promise<DaemonTransport> {
	const sock =
		opts.socketPath ??
		(opts.codexHome ? daemonSocketPath(opts.codexHome) : undefined);
	if (!sock) {
		throw new Error(
			"connectDaemonTransport requires either socketPath or codexHome",
		);
	}
	const url = `ws+unix://${sock}:/`;
	const timeoutMs = opts.connectTimeoutMs ?? 10_000;
	const ctor = opts.wsCtor ?? (await defaultWsCtor());
	return new Promise<DaemonTransport>((resolve, reject) => {
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
			resolve(new WsDaemonTransport(ws));
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

/** Lazily load `ws` only when a real connection is made (keeps tests ws-free). */
async function defaultWsCtor(): Promise<(url: string) => WsLike> {
	const { default: WebSocket } = await import("ws");
	return (url: string) =>
		new WebSocket(url, { perMessageDeflate: false }) as unknown as WsLike;
}
