import { describe, expect, it } from "vitest";
import {
	connectDaemonTransport,
	daemonSocketPath,
	WsDaemonTransport,
	type WsLike,
} from "../src/codex-daemon-transport.js";

// ── FLY-1188 M4b — ws-over-unix DaemonTransport (ws injected) ─────────────

/** A scriptable fake `ws`: the test drives open/message/close/error + sends. */
class FakeWs implements WsLike {
	sent: string[] = [];
	terminated = false;
	closedByUs = false;
	throwOnSend = false;
	/** When set, send() reports this error to the completion callback (async). */
	asyncSendError: Error | null = null;
	readyState = 1; // OPEN by default
	private handlers = new Map<string, ((arg: unknown) => void)[]>();

	send(data: string, cb?: (err?: Error) => void): void {
		if (this.throwOnSend) throw new Error("socket write failed");
		this.sent.push(data);
		if (this.asyncSendError) cb?.(this.asyncSendError);
	}
	close(): void {
		this.closedByUs = true;
	}
	terminate(): void {
		this.terminated = true;
	}
	on(event: string, cb: (arg: never) => void): void {
		const list = this.handlers.get(event) ?? [];
		list.push(cb as (arg: unknown) => void);
		this.handlers.set(event, list);
	}
	emit(event: string, arg?: unknown): void {
		for (const cb of this.handlers.get(event) ?? []) cb(arg);
	}
}

describe("daemonSocketPath", () => {
	it("appends the fixed control-socket relpath to CODEX_HOME", () => {
		expect(daemonSocketPath("/home/x/.codex-runner")).toBe(
			"/home/x/.codex-runner/app-server-control/app-server-control.sock",
		);
	});
});

describe("WsDaemonTransport", () => {
	it("JSON-serializes each outbound frame to one text message", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		t.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0])).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
		});
	});

	it("JSON-parses each inbound message to one frame for the handler", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		const frames: unknown[] = [];
		t.onMessage((f) => frames.push(f));
		ws.emit("message", JSON.stringify({ id: 1, result: { ok: true } }));
		expect(frames).toEqual([{ id: 1, result: { ok: true } }]);
	});

	it("drops a non-JSON inbound frame instead of throwing", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		const frames: unknown[] = [];
		t.onMessage((f) => frames.push(f));
		expect(() => ws.emit("message", "not json {{{")).not.toThrow();
		expect(frames).toEqual([]);
	});

	it("buffers frames that arrive BEFORE onMessage is registered, then replays in order", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		// two frames land before the client wires its handler
		ws.emit("message", JSON.stringify({ n: 1 }));
		ws.emit("message", JSON.stringify({ n: 2 }));
		const frames: unknown[] = [];
		t.onMessage((f) => frames.push(f));
		expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
	});

	it("surfaces a ws close as a single onClose(reason)", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		const reasons: string[] = [];
		t.onClose((r) => reasons.push(r));
		ws.emit("close", 1006);
		ws.emit("close", 1006); // a second close must not double-fire
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain("closed");
	});

	it("surfaces a ws error as onClose too (child-exit semantics)", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		const reasons: string[] = [];
		t.onClose((r) => reasons.push(r));
		ws.emit("error", new Error("ECONNRESET"));
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain("ECONNRESET");
	});

	it("replays a close that arrived BEFORE onClose was registered", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		ws.emit("close"); // dies before the client wires its close handler
		const reasons: string[] = [];
		t.onClose((r) => reasons.push(r));
		expect(reasons).toHaveLength(1);
	});

	it("send propagates a transport write failure (does not swallow it)", () => {
		const ws = new FakeWs();
		ws.throwOnSend = true;
		const t = new WsDaemonTransport(ws);
		// R21: the client's request() catch relies on a synchronous throw to
		// mark itself closed — the transport must not eat it.
		expect(() => t.send({ id: 1 })).toThrow("socket write failed");
	});

	it("send on a non-OPEN socket throws synchronously (real ws would silently no-op while CLOSING)", () => {
		const ws = new FakeWs();
		ws.readyState = 2; // CLOSING
		const t = new WsDaemonTransport(ws);
		expect(() => t.send({ id: 1 })).toThrow(/non-open daemon socket/);
		expect(ws.sent).toHaveLength(0); // never written
	});

	it("an ASYNC send error surfaces as onClose", () => {
		const ws = new FakeWs();
		ws.asyncSendError = new Error("EPIPE");
		const t = new WsDaemonTransport(ws);
		const reasons: string[] = [];
		t.onClose((r) => reasons.push(r));
		t.send({ id: 1 });
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain("EPIPE");
	});

	it("drops a frame that arrives AFTER close (does not replay it ahead of the pending close)", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		ws.emit("close"); // dies before handlers are wired
		ws.emit("message", JSON.stringify({ late: true })); // arrives after close
		const frames: unknown[] = [];
		const reasons: string[] = [];
		t.onMessage((f) => frames.push(f));
		t.onClose((r) => reasons.push(r));
		expect(frames).toEqual([]); // the post-close frame was dropped
		expect(reasons).toHaveLength(1);
	});

	it("a runaway pre-registration frame buffer fails the transport closed", () => {
		const ws = new FakeWs();
		const t = new WsDaemonTransport(ws);
		// flood frames before any handler is registered
		for (let i = 0; i < 1100; i++) ws.emit("message", JSON.stringify({ i }));
		const reasons: string[] = [];
		t.onClose((r) => reasons.push(r));
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain("overflow");
	});

	it("close() calls ws.close(); a throwing close falls back to terminate()", () => {
		const ok = new FakeWs();
		new WsDaemonTransport(ok).close();
		expect(ok.closedByUs).toBe(true);

		const bad = new FakeWs();
		bad.close = () => {
			throw new Error("already gone");
		};
		new WsDaemonTransport(bad).close();
		expect(bad.terminated).toBe(true);
	});
});

describe("connectDaemonTransport", () => {
	it("resolves a transport once the socket opens", async () => {
		const ws = new FakeWs();
		const p = connectDaemonTransport({
			codexHome: "/h",
			wsCtor: () => ws,
		});
		ws.emit("open");
		const t = await p;
		expect(t).toBeInstanceOf(WsDaemonTransport);
	});

	it("rejects on a pre-open error", async () => {
		const ws = new FakeWs();
		const p = connectDaemonTransport({ codexHome: "/h", wsCtor: () => ws });
		ws.emit("error", new Error("no such socket"));
		await expect(p).rejects.toThrow(/connect failed/);
	});

	it("rejects on a close before open", async () => {
		const ws = new FakeWs();
		const p = connectDaemonTransport({ codexHome: "/h", wsCtor: () => ws });
		ws.emit("close");
		await expect(p).rejects.toThrow(/closed before open/);
	});

	it("rejects (and terminates) on connect timeout", async () => {
		const ws = new FakeWs();
		const p = connectDaemonTransport({
			codexHome: "/h",
			connectTimeoutMs: 5,
			wsCtor: () => ws,
		});
		await expect(p).rejects.toThrow(/connect timeout/);
		expect(ws.terminated).toBe(true);
	});

	it("passes the ws+unix URL built from CODEX_HOME to the ctor", async () => {
		let seenUrl = "";
		const ws = new FakeWs();
		const p = connectDaemonTransport({
			codexHome: "/home/x/.codex-runner",
			wsCtor: (url) => {
				seenUrl = url;
				return ws;
			},
		});
		ws.emit("open");
		await p;
		expect(seenUrl).toBe(
			"ws+unix:///home/x/.codex-runner/app-server-control/app-server-control.sock:/",
		);
	});

	it("an explicit socketPath overrides the CODEX_HOME-derived path", async () => {
		let seenUrl = "";
		const ws = new FakeWs();
		const p = connectDaemonTransport({
			socketPath: "/tmp/fw-codex-sock/abc.sock",
			codexHome: "/home/x/.codex-runner", // ignored when socketPath is set
			wsCtor: (url) => {
				seenUrl = url;
				return ws;
			},
		});
		ws.emit("open");
		await p;
		expect(seenUrl).toBe("ws+unix:///tmp/fw-codex-sock/abc.sock:/");
	});

	it("rejects when neither socketPath nor codexHome is given", async () => {
		await expect(connectDaemonTransport({})).rejects.toThrow(
			/requires either socketPath or codexHome/,
		);
	});
});
