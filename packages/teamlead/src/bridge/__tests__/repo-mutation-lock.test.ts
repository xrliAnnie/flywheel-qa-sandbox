/** FLY-1185 §2.11 — repo mutation coordinator unit tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRepoMutationLock } from "../repo-mutation-lock.js";

// Real dirs so canonicalizeWorktreePath resolves symlinks consistently
// (macOS /tmp → /private/tmp is exactly the aliasing the lock must collapse).
const dirA = mkdtempSync(path.join(tmpdir(), "fly1185-lock-a-"));
const dirB = mkdtempSync(path.join(tmpdir(), "fly1185-lock-b-"));

afterAll(() => {
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createRepoMutationLock", () => {
	it("serializes critical sections on the same key", async () => {
		const lock = createRepoMutationLock();
		const events: string[] = [];
		const first = lock.withRepoLock(dirA, async () => {
			events.push("first-start");
			await sleep(30);
			events.push("first-end");
		});
		const second = lock.withRepoLock(dirA, async () => {
			events.push("second-start");
			await sleep(1);
			events.push("second-end");
		});
		await Promise.all([first, second]);
		expect(events).toEqual([
			"first-start",
			"first-end",
			"second-start",
			"second-end",
		]);
	});

	it("runs different keys concurrently", async () => {
		const lock = createRepoMutationLock();
		const events: string[] = [];
		let releaseA!: () => void;
		const gateA = new Promise<void>((r) => {
			releaseA = r;
		});
		const a = lock.withRepoLock(dirA, async () => {
			events.push("a-start");
			await gateA;
			events.push("a-end");
		});
		const b = lock.withRepoLock(dirB, async () => {
			events.push("b-ran");
		});
		await b; // must complete while A still holds its own key
		expect(events).toContain("b-ran");
		expect(events).not.toContain("a-end");
		releaseA();
		await a;
	});

	it("re-entrant acquisition inside the same async context does not deadlock", async () => {
		const lock = createRepoMutationLock();
		const result = await lock.withRepoLock(dirA, async () => {
			// e.g. sweep holds the lock and calls a wrapped WorktreeManager method
			return lock.withRepoLock(dirA, async () => "inner-ran");
		});
		expect(result).toBe("inner-ran");
	});

	it("releases the lock when the critical section throws", async () => {
		const lock = createRepoMutationLock();
		await expect(
			lock.withRepoLock(dirA, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// A subsequent holder must not be blocked by the failed one.
		const ok = await lock.withRepoLock(dirA, async () => "after-throw");
		expect(ok).toBe("after-throw");
		expect(lock.pendingCount(dirA)).toBe(0);
	});

	it("collapses path aliases (symlinked forms) onto one key", async () => {
		const lock = createRepoMutationLock();
		// On macOS tmpdir() often returns /var/... while the canonical path is
		// /private/var/...; build an alias by un-resolving is unreliable, so
		// instead assert that a non-canonical spelling (with a `..` hop) maps to
		// the same key.
		const alias = path.join(dirA, "..", path.basename(dirA));
		const events: string[] = [];
		const first = lock.withRepoLock(dirA, async () => {
			events.push("first-start");
			await sleep(30);
			events.push("first-end");
		});
		const second = lock.withRepoLock(alias, async () => {
			events.push("second-start");
		});
		await Promise.all([first, second]);
		expect(events).toEqual(["first-start", "first-end", "second-start"]);
	});
});
