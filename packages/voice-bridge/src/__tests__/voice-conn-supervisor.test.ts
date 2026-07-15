/**
 * FLY-967 round-3 (revised) — orchestrator VoiceConnection lifecycle.
 *
 * Annie's failure shape: voice.join resolved Ready, then the connection
 * dropped ASYNCHRONOUSLY and the orchestrator silently left the VC (her
 * screenshot: the bot simply wasn't in the room; QA's 4/4 clean autostart
 * joins rule out a throwing join). The supervisor must make that death
 * impossible to miss (log every transition + errors), auto-rejoin, and
 * surface LOUDLY when it cannot recover — never a silent death.
 */
import { describe, expect, it } from "vitest";
import {
	superviseVoiceConnection,
	type VoiceConnHandle,
} from "../audio/VoiceConnSupervisor.js";

function fakeTimers() {
	const pending: (() => void)[] = [];
	return {
		timers: {
			set: (fn: () => void, _ms: number) => {
				pending.push(fn);
				return fn;
			},
			clear: (t: unknown) => {
				const i = pending.indexOf(t as () => void);
				if (i >= 0) pending.splice(i, 1);
			},
		},
		fire: () => {
			const fn = pending.shift();
			fn?.();
		},
		pendingCount: () => pending.length,
	};
}

function fakeHandle() {
	let stateCb: ((from: string, to: string) => void) | undefined;
	let errCb: ((err: Error) => void) | undefined;
	let statusVal = "ready";
	let rejoinResult = true;
	const rejoinCalls: string[] = [];
	const handle: VoiceConnHandle = {
		status: () => statusVal,
		rejoin: () => {
			rejoinCalls.push(statusVal);
			return rejoinResult;
		},
		onStateChange: (cb) => {
			stateCb = cb;
			return () => {
				stateCb = undefined;
			};
		},
		onError: (cb) => {
			errCb = cb;
			return () => {
				errCb = undefined;
			};
		},
	};
	return {
		handle,
		emitState: (from: string, to: string) => {
			statusVal = to;
			stateCb?.(from, to);
		},
		emitError: (e: Error) => errCb?.(e),
		setStatus: (s: string) => {
			statusVal = s;
		},
		setRejoinResult: (v: boolean) => {
			rejoinResult = v;
		},
		rejoinCalls,
		subscribed: () => stateCb !== undefined,
	};
}

function supervise(
	overrides: Partial<Parameters<typeof superviseVoiceConnection>[1]> = {},
) {
	const h = fakeHandle();
	const t = fakeTimers();
	const lines: string[] = [];
	const fatals: string[] = [];
	const dispose = superviseVoiceConnection(h.handle, {
		label: "orchestrator",
		log: (l) => lines.push(l),
		onFatal: (r) => fatals.push(r),
		timers: t.timers,
		...overrides,
	});
	return { h, t, lines, fatals, dispose };
}

describe("FLY-967 — superviseVoiceConnection", () => {
	it("logs every state transition and every error (the diagnosis surface)", () => {
		const { h, lines } = supervise();
		h.emitState("ready", "disconnected");
		h.emitState("disconnected", "signalling");
		h.emitState("signalling", "ready");
		h.emitError(new Error("ip discovery blew up"));
		expect(lines.some((l) => l.includes("ready -> disconnected"))).toBe(true);
		expect(lines.some((l) => l.includes("signalling -> ready"))).toBe(true);
		expect(lines.some((l) => l.includes("ERROR: ip discovery blew up"))).toBe(
			true,
		);
	});

	it("disconnect that self-recovers before settle never triggers a rejoin", () => {
		const { h, t } = supervise();
		h.emitState("ready", "disconnected");
		h.emitState("disconnected", "ready"); // discordjs resumed by itself
		t.fire(); // stale settle timer (if any) must be a no-op
		expect(h.rejoinCalls).toEqual([]);
	});

	it("disconnect that sticks past settle forces a rejoin; landing ready recovers", () => {
		const { h, t, lines, fatals } = supervise();
		h.emitState("ready", "disconnected");
		expect(t.pendingCount()).toBe(1);
		t.fire(); // settle: still disconnected → rejoin #1
		expect(h.rejoinCalls).toHaveLength(1);
		expect(lines.some((l) => l.includes("rejoin attempt 1/3"))).toBe(true);
		h.emitState("disconnected", "ready"); // rejoin landed
		t.fire(); // post-rejoin settle check must accept the recovery
		expect(h.rejoinCalls).toHaveLength(1);
		expect(fatals).toEqual([]);
	});

	it("exhausting maxRejoins surfaces FATAL exactly once and stops", () => {
		const { h, t, lines, fatals } = supervise({ maxRejoins: 2 });
		h.emitState("ready", "disconnected");
		t.fire(); // rejoin 1
		t.fire(); // rejoin 2
		t.fire(); // exhausted → fatal
		expect(h.rejoinCalls).toHaveLength(2);
		expect(fatals).toHaveLength(1);
		expect(fatals[0]).toContain("2 rejoin attempts");
		expect(lines.some((l) => l.includes("FATAL"))).toBe(true);
		expect(t.pendingCount()).toBe(0); // no further attempts scheduled
	});

	it("rejoin() returning false is FATAL immediately", () => {
		const { h, t, fatals } = supervise();
		h.setRejoinResult(false);
		h.emitState("ready", "disconnected");
		t.fire();
		expect(fatals).toHaveLength(1);
		expect(fatals[0]).toContain("rejoin() failed");
	});

	it("destruction is FATAL (once, even when reported twice)", () => {
		const { h, fatals } = supervise();
		h.emitState("ready", "destroyed");
		h.emitState("destroyed", "destroyed");
		expect(fatals).toEqual(["connection destroyed"]);
	});

	it("observe mode logs transitions/errors but never rejoins nor fatals", () => {
		const { h, t, lines, fatals } = supervise({ mode: "observe" });
		h.emitState("ready", "disconnected");
		h.emitState("disconnected", "destroyed");
		h.emitError(new Error("boom"));
		expect(t.pendingCount()).toBe(0);
		expect(h.rejoinCalls).toEqual([]);
		expect(fatals).toEqual([]);
		expect(lines.some((l) => l.includes("ready -> disconnected"))).toBe(true);
		expect(lines.some((l) => l.includes("ERROR: boom"))).toBe(true);
	});

	it("stalling in signalling/connecting is supervised too — rejoin then fatal, never a silent stall (Codex R15)", () => {
		const { h, t, fatals } = supervise({ maxRejoins: 2 });
		// @discordjs/voice's own reconnect path: ready -> signalling, then stuck.
		h.emitState("ready", "signalling");
		expect(t.pendingCount()).toBe(1); // settle armed for the non-ready state
		t.fire(); // still signalling → rejoin 1
		t.fire(); // rejoin 2
		t.fire(); // exhausted → fatal
		expect(h.rejoinCalls).toHaveLength(2);
		expect(fatals).toHaveLength(1);
	});

	it("flapping between non-ready states never starves the settle check (single pending timer)", () => {
		const { h, t } = supervise();
		h.emitState("ready", "disconnected");
		h.emitState("disconnected", "signalling");
		h.emitState("signalling", "connecting");
		expect(t.pendingCount()).toBe(1); // re-arms do not stack nor reset-starve
		t.fire(); // still connecting → rejoin fires despite the flapping
		expect(h.rejoinCalls).toHaveLength(1);
	});

	it("dispose unsubscribes and cancels any pending settle work", () => {
		const { h, t, dispose } = supervise();
		h.emitState("ready", "disconnected");
		expect(t.pendingCount()).toBe(1);
		dispose();
		expect(t.pendingCount()).toBe(0);
		expect(h.subscribed()).toBe(false);
		t.fire(); // nothing queued — and nothing rejoins
		expect(h.rejoinCalls).toEqual([]);
	});
});
