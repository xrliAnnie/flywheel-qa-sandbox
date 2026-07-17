/**
 * FLY-696 M1/C5 — withMkdirLock: the interprocess lock the switch executor and
 * the bash `flywheel-claude-profile` both acquire. Uses an atomic `mkdir` (which
 * is atomic in both Node and shell) rather than flock(2) — Node has no native
 * flock, and mkdir-lock coordinates across languages, which is exactly what
 * Codex R2 required (an OS-visible lock BOTH sides take).
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getLeaseProof,
	renewMkdirLock,
	validateLeaseProof,
	withMkdirLock,
} from "../account-heal/mkdir-lock.js";

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

	it("fails loudly instead of spinning when the lock parent is missing", async () => {
		rmSync(dir, { recursive: true, force: true });

		await expect(
			withMkdirLock(lock, async () => "never", {
				timeoutMs: 20,
				retryMs: 1,
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("times out instead of busy-looping when the lock path is not a directory", async () => {
		writeFileSync(lock, "not-a-directory");
		let sleeps = 0;
		let now = 0;

		await expect(
			withMkdirLock(lock, async () => "never", {
				timeoutMs: 20,
				retryMs: 5,
				now: () => now,
				sleep: async (ms) => {
					sleeps++;
					now += ms;
				},
			}),
		).rejects.toThrow(/timeout/i);
		expect(sleeps).toBeGreaterThan(0);
	});

	it("recovers an old corrupt marker after the stale age bound", async () => {
		mkdirSync(lock);
		const marker = join(lock, "holder.corrupt");
		writeFileSync(marker, "{truncated");
		const old = new Date(Date.now() - 10_000);
		utimesSync(marker, old, old);

		let ran = false;
		await withMkdirLock(
			lock,
			async () => {
				ran = true;
			},
			{ staleMs: 1_000 },
		);

		expect(ran).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	it("recovers an orphaned stale-break claim after the stale age bound", async () => {
		mkdirSync(lock);
		writeFileSync(
			join(lock, ".stale-break.4242.7"),
			JSON.stringify({ pid: 4242, at: 1, token: "orphan" }),
		);
		const old = new Date(Date.now() - 10_000);
		utimesSync(lock, old, old);

		let ran = false;
		await withMkdirLock(
			lock,
			async () => {
				ran = true;
			},
			{ staleMs: 1_000, timeoutMs: 40, retryMs: 5 },
		);

		expect(ran).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	it("recovers an old marker when its live pid identity was recycled", async () => {
		mkdirSync(lock);
		writeFileSync(
			join(lock, "holder.reused"),
			JSON.stringify({
				pid: process.pid,
				at: Date.now() - 10_000,
				processStartTime: "old-process-start",
			}),
		);

		let ran = false;
		await withMkdirLock(
			lock,
			async () => {
				ran = true;
			},
			{
				staleMs: 1_000,
				readProcessStartTime: () => "current-process-start",
			},
		);

		expect(ran).toBe(true);
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

	it("never steals an old lock while its holder pid is still alive", async () => {
		mkdirSync(lock);
		const marker = join(lock, "holder");
		writeFileSync(
			marker,
			JSON.stringify({
				pid: process.pid,
				at: Date.now() - 10_000,
			}),
		);
		const old = new Date(Date.now() - 10_000);
		utimesSync(marker, old, old);
		await expect(
			withMkdirLock(lock, async () => "never", {
				staleMs: 1000,
				timeoutMs: 40,
				retryMs: 5,
			}),
		).rejects.toThrow(/timeout/i);
		expect(existsSync(join(lock, "holder"))).toBe(true);
	});

	it("does not delete a replacement installed between stale inspection and break", async () => {
		mkdirSync(lock);
		writeFileSync(
			join(lock, "holder"),
			JSON.stringify({ pid: 2147483646, at: Date.now() - 10_000 }),
		);
		let interleaved = false;

		await expect(
			withMkdirLock(lock, async () => "never", {
				timeoutMs: 40,
				retryMs: 5,
				beforeStaleBreak: () => {
					if (interleaved) return;
					interleaved = true;
					rmSync(lock, { recursive: true, force: true });
					mkdirSync(lock);
					writeFileSync(
						join(lock, "holder.replacement"),
						JSON.stringify({
							pid: process.pid,
							at: Date.now(),
							token: "replacement",
						}),
					);
				},
			}),
		).rejects.toThrow(/timeout/i);

		expect(interleaved).toBe(true);
		expect(readdirSync(lock)).toEqual(["holder.replacement"]);
	});

	it("renews a lock owned by this process without changing holder identity", async () => {
		const refreshedAt = Date.now() + 5_000;
		await withMkdirLock(lock, async () => {
			const marker = readdirSync(lock).find((name) =>
				name.startsWith("holder."),
			);
			if (!marker) throw new Error("owned marker missing");
			const markerPath = join(lock, marker);
			const before = JSON.parse(readFileSync(markerPath, "utf8"));

			expect(renewMkdirLock(lock, () => refreshedAt)).toBe(true);
			expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(before);
			expect(statSync(markerPath).mtimeMs).toBeCloseTo(refreshedAt, -1);
		});
	});

	it("exports a child-safe lease proof that fails after holder replacement", async () => {
		await withMkdirLock(lock, async () => {
			const proof = getLeaseProof(lock);
			expect(proof).toMatchObject({ lockPath: lock });
			expect(proof && validateLeaseProof(proof)).toBe(true);
			if (!proof) throw new Error("proof missing");
			writeFileSync(
				proof.markerPath,
				JSON.stringify({
					pid: process.pid,
					at: Date.now(),
					token: "replacement",
				}),
			);
			expect(validateLeaseProof(proof)).toBe(false);
		});
	});

	it("refuses to renew a missing or replacement holder and leaves it untouched", () => {
		expect(renewMkdirLock(lock, () => 200)).toBe(false);
		mkdirSync(lock);
		const replacement = JSON.stringify({ pid: process.pid + 1, at: 150 });
		writeFileSync(join(lock, "holder"), replacement);

		expect(renewMkdirLock(lock, () => 200)).toBe(false);
		expect(readFileSync(join(lock, "holder"), "utf8")).toBe(replacement);
	});

	it("does not release a lock whose holder was replaced during the callback", async () => {
		await withMkdirLock(lock, async () => {
			writeFileSync(
				join(lock, "holder"),
				JSON.stringify({ pid: process.pid + 1, at: Date.now() }),
			);
		});

		expect(existsSync(lock)).toBe(true);
	});

	it("does not delete a replacement installed immediately before release", async () => {
		let interleaved = false;
		await withMkdirLock(lock, async () => undefined, {
			beforeRelease: () => {
				interleaved = true;
				rmSync(lock, { recursive: true, force: true });
				mkdirSync(lock);
				writeFileSync(
					join(lock, "holder.replacement"),
					JSON.stringify({
						pid: process.pid,
						at: Date.now(),
						token: "replacement",
					}),
				);
			},
		});

		expect(interleaved).toBe(true);
		expect(readdirSync(lock)).toEqual(["holder.replacement"]);
	});
});
