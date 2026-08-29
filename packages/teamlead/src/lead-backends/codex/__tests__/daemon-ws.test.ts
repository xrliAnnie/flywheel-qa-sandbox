/**
 * FLY-259 PR-D — daemon-ws connection-factory race tests (review LOW-8): the
 * pre-open handshake must resolve on open, reject on error/close/timeout, and a
 * single-shot latch must keep any later event from re-settling the promise.
 */

import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
	connectDaemonWs,
	DAEMON_SOCKET_RELPATH,
	daemonSocketPath,
} from "../daemon-ws.js";

class FakeWs {
	handlers = new Map<string, ((...a: unknown[]) => void)[]>();
	terminated = false;
	on(ev: string, cb: (...a: unknown[]) => void): void {
		const l = this.handlers.get(ev) ?? [];
		l.push(cb);
		this.handlers.set(ev, l);
	}
	emit(ev: string, ...a: unknown[]): void {
		for (const cb of this.handlers.get(ev) ?? []) cb(...a);
	}
	terminate(): void {
		this.terminated = true;
	}
}

const ctorOf = (fake: FakeWs) => (): WebSocket => fake as unknown as WebSocket;

describe("connectDaemonWs", () => {
	it("resolves with the socket once it opens", async () => {
		const fake = new FakeWs();
		const p = connectDaemonWs({ codexHome: "/h", wsCtor: ctorOf(fake) });
		fake.emit("open");
		await expect(p).resolves.toBe(fake);
	});

	it("rejects if the socket errors before open", async () => {
		const fake = new FakeWs();
		const p = connectDaemonWs({ codexHome: "/h", wsCtor: ctorOf(fake) });
		fake.emit("error", new Error("ECONNREFUSED"));
		await expect(p).rejects.toThrow(/connect failed.*ECONNREFUSED/);
	});

	it("rejects if the socket closes before open", async () => {
		const fake = new FakeWs();
		const p = connectDaemonWs({ codexHome: "/h", wsCtor: ctorOf(fake) });
		fake.emit("close");
		await expect(p).rejects.toThrow(/closed before open/);
	});

	it("rejects AND terminates the socket on connect timeout", async () => {
		vi.useFakeTimers();
		try {
			const fake = new FakeWs();
			const p = connectDaemonWs({
				codexHome: "/h",
				connectTimeoutMs: 1000,
				wsCtor: ctorOf(fake),
			});
			// Attach the rejection handler BEFORE advancing the timer so the timeout
			// rejection is never momentarily unhandled (false-positive guard).
			const expectation = expect(p).rejects.toThrow(/timeout after 1000ms/);
			await vi.advanceTimersByTimeAsync(1000);
			await expectation;
			expect(fake.terminated).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("single-shot latch: a post-open error does not re-settle / throw", async () => {
		const fake = new FakeWs();
		const p = connectDaemonWs({ codexHome: "/h", wsCtor: ctorOf(fake) });
		fake.emit("open");
		await expect(p).resolves.toBe(fake);
		expect(() => fake.emit("error", new Error("late, ignored"))).not.toThrow();
	});
});

describe("daemonSocketPath", () => {
	it("joins codexHome with the control-socket rel path", () => {
		expect(daemonSocketPath("/home/.codex-x")).toBe(
			`/home/.codex-x/${DAEMON_SOCKET_RELPATH}`,
		);
	});
});
