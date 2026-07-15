/**
 * FLY-259 PR-B — WsTransport unit tests: the R4 HIGH-1 frame/line conversion
 * contract + child-exit semantics (single-shot, late subscriber, error path).
 */

import { describe, expect, it } from "vitest";
import type { WsLike } from "../WsTransport.js";
import { WsTransport } from "../WsTransport.js";

type Handler = (...args: never[]) => void;

function makeFakeWs() {
	const sent: string[] = [];
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let closed = 0;
	let terminated = 0;
	const ws: WsLike = {
		send: (d: string) => {
			sent.push(d);
		},
		close: () => {
			closed += 1;
		},
		terminate: () => {
			terminated += 1;
		},
		on: ((event: string, cb: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(cb as (...args: unknown[]) => void);
			handlers.set(event, list);
		}) as WsLike["on"],
	};
	const fire = (event: string, ...args: unknown[]) => {
		for (const cb of handlers.get(event) ?? []) cb(...args);
	};
	return {
		ws,
		sent,
		fire,
		closedCount: () => closed,
		terminatedCount: () => terminated,
	};
}

describe("WsTransport — outbound line→frame (R4 HIGH-1)", () => {
	it("sends each complete non-empty line as one frame", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		t.writeStdin('{"a":1}\n{"b":2}\n');
		expect(f.sent).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("buffers a partial trailing line until completed (no premature frame)", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		t.writeStdin('{"a"');
		expect(f.sent).toEqual([]);
		t.writeStdin(":1}\n");
		expect(f.sent).toEqual(['{"a":1}']);
	});

	it("skips blank lines (never sends empty frames)", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		t.writeStdin('\n\n{"a":1}\n\n');
		expect(f.sent).toEqual(['{"a":1}']);
	});

	it("a single write carrying many lines fans out to many frames in order", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		t.writeStdin('{"a":1}\n{"b":2}\n{"c"');
		t.writeStdin(":3}\n");
		expect(f.sent).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	});

	it("writes after exit are dropped (dead-pipe semantics)", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		f.fire("close");
		t.writeStdin('{"a":1}\n');
		expect(f.sent).toEqual([]);
	});
});

describe("WsTransport — inbound frame→line (R4 HIGH-1)", () => {
	it("appends a newline to every inbound frame for the line buffer", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		const chunks: string[] = [];
		t.onStdout((c) => chunks.push(c));
		f.fire("message", '{"jsonrpc":"2.0","id":1,"result":{}}');
		expect(chunks).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n']);
	});

	it("non-string frame data is stringified (garbage takes the bad-line path downstream)", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		const chunks: string[] = [];
		t.onStdout((c) => chunks.push(c));
		f.fire("message", Buffer.from('{"x":1}'));
		expect(chunks[0]?.endsWith("\n")).toBe(true);
	});
});

describe("WsTransport — exit semantics (child-exit parity; R5 HIGH-2 boundary)", () => {
	it("close → onExit(null, null) exactly once", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		const exits: Array<[number | null, NodeJS.Signals | null]> = [];
		t.onExit((c, s) => exits.push([c, s]));
		f.fire("close");
		f.fire("close");
		expect(exits).toEqual([[null, null]]);
	});

	it("error → stderr line + onExit once; a following close does not double-fire", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		const errs: string[] = [];
		let exits = 0;
		t.onStderr((c) => errs.push(c));
		t.onExit(() => {
			exits += 1;
		});
		f.fire("error", new Error("ECONNRESET"));
		f.fire("close"); // ws emits close after error — must stay single-shot
		expect(errs[0]).toContain("ECONNRESET");
		expect(exits).toBe(1);
	});

	it("late onExit subscriber still learns of a death that already happened", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		f.fire("close");
		let told = false;
		t.onExit(() => {
			told = true;
		});
		expect(told).toBe(true);
	});

	it("endStdin → ws.close (graceful); kill → terminate (hard, connection-only)", () => {
		const f = makeFakeWs();
		const t = new WsTransport(f.ws);
		t.endStdin();
		expect(f.closedCount()).toBe(1);
		t.kill("SIGTERM");
		expect(f.terminatedCount()).toBe(1);
	});
});
