/**
 * FLY-259 PR-B — WsTransport: a `ChildTransport` implementation that speaks to
 * the `codex remote-control` app-server daemon over a WebSocket (unix socket)
 * instead of a spawned stdio child.
 *
 * Frame/line conversion contract (design review R4 HIGH-1 — pinned, do not
 * "simplify"): `CodexLeadProcess` does its own line buffering and splits on
 * `\n`; the daemon socket speaks one complete JSON document per WS text frame
 * (no trailing newline). This adapter converts explicitly:
 *   - `writeStdin(data)`: line-buffer the outbound stream, send each complete
 *     NON-EMPTY line as one text frame (a partial trailing line waits for the
 *     rest — exactly mirroring how a stdio pipe would coalesce);
 *   - inbound WS message → `cb(frame + "\n")` so CodexLeadProcess's existing
 *     line buffer + bad-line tolerance work unchanged;
 *   - WS close/error → `onExit` exactly once (child-exit semantics: the
 *     consumer rejects all pending requests — reconnection is NOT this
 *     class's job; design review R5 HIGH-2: rebuild is supervised one level
 *     up, never an in-transport magic reconnect).
 *
 * The WS endpoint is INJECTED (`WsLike`) so unit tests drive a fake. The real
 * connection factory (ws library choice + ready-state handling against
 * `unix://<CODEX_HOME>/app-server-control/app-server-control.sock`) is
 * DEFERRED to PR-D's runtime assembly (code review R1 LOW-7 — no phantom
 * exports promised here). WS-over-unix itself is spike-verified:
 * doc/engineer/research/new/FLY-259-spike-results.md.
 */

import type { ChildTransport } from "./CodexLeadProcess.js";

/** Minimal WebSocket surface the adapter needs (injectable; `ws` satisfies it). */
export interface WsLike {
	send(data: string): void;
	close(): void;
	/** Hard teardown (maps from ChildTransport.kill). `ws` exposes terminate(). */
	terminate?(): void;
	on(event: "message", cb: (data: unknown) => void): void;
	on(event: "close", cb: (code?: number) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	on(event: "open", cb: () => void): void;
}

export class WsTransport implements ChildTransport {
	private readonly ws: WsLike;
	private outBuffer = "";
	private exited = false;
	private stdoutCb: ((chunk: string) => void) | undefined;
	private stderrCb: ((chunk: string) => void) | undefined;
	private exitCb:
		| ((code: number | null, signal: NodeJS.Signals | null) => void)
		| undefined;

	constructor(ws: WsLike) {
		this.ws = ws;
		this.ws.on("message", (data: unknown) => {
			// One frame = one JSON document; re-append the newline the line
			// buffer expects (R4 HIGH-1). Binary frames are stringified — a
			// garbled result takes CodexLeadProcess's bad-line path (skip+log).
			this.stdoutCb?.(`${String(data)}\n`);
		});
		this.ws.on("close", () => this.emitExit());
		this.ws.on("error", (err: Error) => {
			// Surface the error text where stderr would have gone, then treat
			// the connection as gone (ws emits close after error too — the
			// exit latch keeps onExit single-shot).
			this.stderrCb?.(`[WsTransport] ${err.message}\n`);
			this.emitExit();
		});
	}

	writeStdin(data: string): void {
		if (this.exited) return; // mirrors writing to a dead child's pipe (no-op here)
		this.outBuffer += data;
		const lines = this.outBuffer.split("\n");
		this.outBuffer = lines.pop() ?? ""; // partial trailing line waits
		for (const line of lines) {
			if (line.length === 0) continue; // blank lines never become frames
			this.ws.send(line);
		}
	}

	endStdin(): void {
		// Graceful shutdown step 1 — for a socket, that's a close handshake.
		this.ws.close();
	}

	kill(_signal?: NodeJS.Signals): void {
		// Hard teardown. NOTE: this kills OUR CONNECTION, never the daemon —
		// the daemon is shared with the TUI and supervised by codex itself.
		if (this.ws.terminate) this.ws.terminate();
		else this.ws.close();
	}

	onStdout(cb: (chunk: string) => void): void {
		this.stdoutCb = cb;
	}

	onStderr(cb: (chunk: string) => void): void {
		this.stderrCb = cb;
	}

	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void {
		this.exitCb = cb;
		if (this.exited) cb(null, null); // late subscriber still learns the death
	}

	private emitExit(): void {
		if (this.exited) return; // single-shot (close-after-error etc.)
		this.exited = true;
		this.exitCb?.(null, null);
	}
}
