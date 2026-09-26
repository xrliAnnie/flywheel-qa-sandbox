/**
 * FLY-1160 §3.3 — BrainPort security + protocol contract (real http loopback).
 *
 * Every /brain/* endpoint (health included) is Bearer-gated with a
 * constant-time compare; 127.0.0.1 only; health leaks counts, never keys;
 * validation → 400/404/408/413/415; same-key in-flight turn → supersede via
 * the interrupt barrier (barrier failure → 503); client disconnect =
 * interrupt; shutdown → 503.
 */
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPort } from "../brain/BrainPort.js";

const TOKEN = "test-token-123";
const randPort = () => 22000 + Math.floor(Math.random() * 20000);

interface FakeBrain {
	interrupts: number;
	release?: () => void;
	calls: number;
	respond(
		turn: { text: string; history: unknown[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string>;
	interrupt(): Promise<void>;
}

function fakeBrain(
	opts: {
		chunks?: string[];
		hangFirst?: boolean;
		interruptFails?: boolean;
		/** interrupt() only counts; the test releases the hung turn itself. */
		manualRelease?: boolean;
	} = {},
): FakeBrain {
	const brain: FakeBrain = {
		interrupts: 0,
		calls: 0,
		async *respond() {
			brain.calls++;
			if (opts.hangFirst && brain.calls === 1) {
				await new Promise<void>((r) => {
					brain.release = r;
				});
				return;
			}
			for (const c of opts.chunks ?? []) yield c;
		},
		async interrupt() {
			brain.interrupts++;
			// barrier failure is only meaningful once a turn is actually in
			// flight (the arrival barrier on an idle brain is a no-op resolve)
			if (opts.interruptFails && brain.calls > 0)
				throw new Error("barrier failed");
			if (!opts.manualRelease) brain.release?.();
		},
	};
	return brain;
}

function makeManager() {
	const brains = new Map<string, FakeBrain>();
	return {
		brains,
		get: (k: string) => brains.get(k),
		stats: () => ({ active: brains.size }),
	};
}

const openPorts: BrainPort[] = [];
afterEach(async () => {
	for (const p of openPorts) await p.close();
	openPorts.length = 0;
});

async function start(
	manager = makeManager(),
	opts: { bodyTimeoutMs?: number } = {},
) {
	const port = randPort();
	const bp = new BrainPort({ manager, port, token: TOKEN, ...opts });
	openPorts.push(bp);
	await bp.listen();
	return { bp, port, manager };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };
const turnReq = (
	port: number,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	fetch(`http://127.0.0.1:${port}/brain/turn`, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH, ...headers },
		body: JSON.stringify(body),
	});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("BrainPort — auth", () => {
	it("rejects EVERY /brain/* endpoint without a valid Bearer token (health included)", async () => {
		const { port } = await start();
		const health = await fetch(`http://127.0.0.1:${port}/brain/health`);
		expect(health.status).toBe(401);
		const wrong = await fetch(`http://127.0.0.1:${port}/brain/health`, {
			headers: { authorization: "Bearer wrong-token" },
		});
		expect(wrong.status).toBe(401);
		const turn = await fetch(`http://127.0.0.1:${port}/brain/turn`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "a", text: "hi" }),
		});
		expect(turn.status).toBe(401);
	});

	it("health returns {ok, active} only — never keys/issues", async () => {
		const manager = makeManager();
		manager.brains.set("FLY-9999:secret-lead", fakeBrain());
		const { port } = await start(manager);
		const res = await fetch(`http://127.0.0.1:${port}/brain/health`, {
			headers: AUTH,
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(JSON.parse(body)).toEqual({ ok: true, active: 1 });
		expect(body).not.toContain("FLY-9999");
	});
});

describe("BrainPort — /brain/turn validation", () => {
	it("streams the brain's chunks as a plain-text response", async () => {
		const manager = makeManager();
		manager.brains.set("FLY-1:lead", fakeBrain({ chunks: ["你", "好"] }));
		const { port } = await start(manager);
		const res = await turnReq(port, { key: "FLY-1:lead", text: "hi" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("你好");
	});

	it("404 on an unbound key (only daemon wiring can open/close brains)", async () => {
		const { port } = await start();
		const res = await turnReq(port, { key: "nope", text: "hi" });
		expect(res.status).toBe(404);
	});

	it("400 on a key outside the charset whitelist", async () => {
		const { port } = await start();
		const res = await turnReq(port, { key: "bad key!", text: "hi" });
		expect(res.status).toBe(400);
	});

	it("413 when text exceeds 16KB", async () => {
		const manager = makeManager();
		manager.brains.set("a", fakeBrain());
		const { port } = await start(manager);
		const res = await turnReq(port, { key: "a", text: "x".repeat(17 * 1024) });
		expect(res.status).toBe(413);
	});

	it("415 without application/json", async () => {
		const manager = makeManager();
		manager.brains.set("a", fakeBrain());
		const { port } = await start(manager);
		const res = await fetch(`http://127.0.0.1:${port}/brain/turn`, {
			method: "POST",
			headers: { "content-type": "text/plain", ...AUTH },
			body: JSON.stringify({ key: "a", text: "hi" }),
		});
		expect(res.status).toBe(415);
	});

	it("408 when the body never finishes within the read timeout", async () => {
		const { port } = await start(makeManager(), { bodyTimeoutMs: 50 });
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path: "/brain/turn",
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${TOKEN}`,
					},
				},
				(res) => resolve(res.statusCode ?? 0),
			);
			req.on("error", reject);
			req.write('{"key":"a"'); // never ends
		});
		expect(status).toBe(408);
	});
});

describe("BrainPort — supersede / disconnect / shutdown", () => {
	it("a new turn on a key with an in-flight turn supersedes: interrupt barrier first, then the new turn", async () => {
		const manager = makeManager();
		const brain = fakeBrain({ hangFirst: true, chunks: ["second"] });
		manager.brains.set("a", brain);
		const { port } = await start(manager);
		const first = turnReq(port, { key: "a", text: "one" });
		first.catch(() => {});
		await waitFor(() => brain.release !== undefined);
		const second = await turnReq(port, { key: "a", text: "two" });
		expect(second.status).toBe(200);
		expect(await second.text()).toBe("second");
		// every arrival runs the barrier (no-op on idle): one for each turn
		expect(brain.interrupts).toBe(2);
		await first; // superseded turn's stream closed cleanly
	});

	it("503 when the supersede barrier fails (voice barge-in must not stack turns)", async () => {
		const manager = makeManager();
		const brain = fakeBrain({ hangFirst: true, interruptFails: true });
		manager.brains.set("a", brain);
		const { bp, port } = await start(manager);
		const first = turnReq(port, { key: "a", text: "one" });
		first.catch(() => {});
		await waitFor(() => brain.release !== undefined);
		const second = await turnReq(port, { key: "a", text: "two" });
		expect(second.status).toBe(503);
		await bp.close();
		await first.catch(() => {});
	});

	it("racing turns on one key are LAST-WINS: stale queued turns end as empty interrupted streams, exactly one brain turn runs (Codex #550 R1)", async () => {
		const manager = makeManager();
		const brain = fakeBrain({
			hangFirst: true,
			chunks: ["winner"],
			manualRelease: true,
		});
		manager.brains.set("a", brain);
		const { port } = await start(manager);
		const first = turnReq(port, { key: "a", text: "one" });
		first.catch(() => {});
		await waitFor(() => brain.release !== undefined);
		const second = turnReq(port, { key: "a", text: "two" });
		second.catch(() => {});
		await new Promise((r) => setTimeout(r, 20)); // two is queued behind one
		const third = turnReq(port, { key: "a", text: "three" });
		third.catch(() => {});
		await new Promise((r) => setTimeout(r, 20)); // three claimed the key
		brain.release?.(); // NOW the hung first turn ends
		const [r2, r3] = await Promise.all([second, third]);
		expect(await r2.text()).toBe(""); // superseded while queued — never ran
		expect(await r3.text()).toBe("winner"); // the newest turn is the one that ran
		expect(brain.calls).toBe(2); // one hung + one winner; the stale turn never hit the brain
		await first;
	});

	it("client disconnect mid-turn = interrupt (platform aborts in-flight requests — FLY-1006 research)", async () => {
		const manager = makeManager();
		const brain = fakeBrain({ hangFirst: true });
		manager.brains.set("a", brain);
		const { port } = await start(manager);
		const ctrl = new AbortController();
		const p = fetch(`http://127.0.0.1:${port}/brain/turn`, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ key: "a", text: "one" }),
			signal: ctrl.signal,
		});
		p.catch(() => {});
		await waitFor(() => brain.calls === 1);
		ctrl.abort();
		await waitFor(() => brain.interrupts >= 1);
	});

	it("a client that disconnects while QUEUED never reaches the brain (Codex #550 R2)", async () => {
		const manager = makeManager();
		const brain = fakeBrain({ hangFirst: true, manualRelease: true });
		manager.brains.set("a", brain);
		const { port } = await start(manager);
		const first = turnReq(port, { key: "a", text: "one" });
		first.catch(() => {});
		await waitFor(() => brain.release !== undefined);
		const ctrl = new AbortController();
		const queued = fetch(`http://127.0.0.1:${port}/brain/turn`, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ key: "a", text: "two" }),
			signal: ctrl.signal,
		});
		queued.catch(() => {});
		await new Promise((r) => setTimeout(r, 20)); // queued behind turn one
		ctrl.abort(); // client hangs up while still queued
		await new Promise((r) => setTimeout(r, 20));
		brain.release?.(); // turn one ends
		await first;
		await new Promise((r) => setTimeout(r, 30));
		expect(brain.calls).toBe(1); // the dead queued turn never ran
	});

	it("beginShutdown → every request answers 503 (Phase 1 of the two-phase shutdown)", async () => {
		const manager = makeManager();
		manager.brains.set("a", fakeBrain({ chunks: ["x"] }));
		const { bp, port } = await start(manager);
		bp.beginShutdown();
		const health = await fetch(`http://127.0.0.1:${port}/brain/health`, {
			headers: AUTH,
		});
		expect(health.status).toBe(503);
		const turn = await turnReq(port, { key: "a", text: "hi" });
		expect(turn.status).toBe(503);
	});

	it("POST /brain/interrupt runs the barrier and returns ok", async () => {
		const manager = makeManager();
		const brain = fakeBrain();
		manager.brains.set("a", brain);
		const { port } = await start(manager);
		const res = await fetch(`http://127.0.0.1:${port}/brain/interrupt`, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ key: "a" }),
		});
		expect(res.status).toBe(200);
		expect(brain.interrupts).toBe(1);
		const missing = await fetch(`http://127.0.0.1:${port}/brain/interrupt`, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ key: "zzz" }),
		});
		expect(missing.status).toBe(404);
	});
});
