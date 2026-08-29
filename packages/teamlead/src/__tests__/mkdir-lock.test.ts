/**
 * FLY-696 M1/C5 — withMkdirLock: the interprocess lock the switch executor and
 * the bash `flywheel-claude-profile` both acquire. Uses an atomic `mkdir` (which
 * is atomic in both Node and shell) rather than flock(2) — Node has no native
 * flock, and mkdir-lock coordinates across languages, which is exactly what
 * Codex R2 required (an OS-visible lock BOTH sides take).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withMkdirLock } from "../account-heal/mkdir-lock.js";

let dir: string;
let lock: string;
beforeEach(() => {
	dir = join(
		tmpdir(),
		`fly696-lock-${process.pid}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	lock = join(dir, "claude-accounts.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("withMkdirLock", () => {
	it("acquires, runs fn, releases (lock dir gone afterward)", async () => {
		let ran = false;
		const out = await withMkdirLock(lock, async () => {
			ran = true;
			expect(existsSync(lock)).toBe(true); // held during fn
			return 42;
		});
		expect(ran).toBe(true);
		expect(out).toBe(42);
		expect(existsSync(lock)).toBe(false); // released
	});

	it("releases the lock even when fn throws", async () => {
		await expect(
			withMkdirLock(lock, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});

	it("times out when the lock is held by a live holder", async () => {
		// Simulate a live holder: create the lock dir + a fresh marker for THIS pid.
		mkdirSync(lock);
		writeFileSync(
			join(lock, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		await expect(
			withMkdirLock(lock, async () => "never", { timeoutMs: 60, retryMs: 10 }),
		).rejects.toThrow(/timeout/i);
		rmSync(lock, { recursive: true, force: true });
	});

	it("breaks a stale lock held by a dead pid, then acquires", async () => {
		mkdirSync(lock);
		writeFileSync(
			join(lock, "holder"),
			// pid 2^31-1 is not a real process → treated as dead
			JSON.stringify({ pid: 2147483646, at: Date.now() }),
		);
		let ran = false;
		await withMkdirLock(lock, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	it("breaks a lock whose marker is older than staleMs even if pid looks alive", async () => {
		mkdirSync(lock);
		writeFileSync(
			join(lock, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }),
		);
		let ran = false;
		await withMkdirLock(
			lock,
			async () => {
				ran = true;
			},
			{ staleMs: 1000 },
		);
		expect(ran).toBe(true);
	});
});
