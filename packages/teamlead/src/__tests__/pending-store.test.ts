/**
 * FLY-696 M1/C8c — durable account_switch_pending store.
 *
 * An account cap does NOT switch immediately (Codex R5#4 / plan C8c): it writes a
 * durable pending record keyed by sourceAlertId+observedAccount+generation with a
 * deadline. A cross-provider Infra Bot (M2) can claim it; otherwise the Bridge
 * watchdog fires the switch after the deadline. Restart-safe (survives a Bridge
 * restart) — the record is on disk, guarded by the same flock as the account
 * state. M1-only = short deadline → watchdog fires promptly.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimPending,
	duePending,
	type PendingSwitch,
	pendingKey,
	readPending,
	resolvePending,
	upsertPending,
	writePending,
} from "../account-heal/pending-store.js";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-pending-"));
	path = join(dir, "account-switch-pending.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<PendingSwitch> = {}): PendingSwitch => ({
	key: pendingKey("alert-1", "personal", 3),
	provider: "claude",
	sourceAlertId: "alert-1",
	observedAccount: "personal",
	observedGeneration: 3,
	scope: "5h",
	resetAt: "2026-07-04T02:30:00.000Z",
	deadlineAt: "2026-07-03T20:01:00.000Z",
	createdAt: "2026-07-03T20:00:00.000Z",
	...over,
});

describe("pendingKey", () => {
	it("is stable per (alert, account, generation)", () => {
		expect(pendingKey("a", "personal", 3)).toBe("a|personal|3");
		expect(pendingKey("a", "personal", 3)).toBe(pendingKey("a", "personal", 3));
	});
});

describe("pending-store IO", () => {
	it("readPending → [] when missing or corrupt", () => {
		expect(readPending(path)).toEqual([]);
		writeFileSync(path, "{ not json");
		expect(readPending(path)).toEqual([]);
	});

	it("write → read round-trips and is 0600", () => {
		const r = rec();
		writePending([r], path);
		expect(readPending(path)).toEqual([r]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("upsertPending is idempotent by key (no duplicates)", () => {
		upsertPending(rec(), path);
		upsertPending(rec({ deadlineAt: "2026-07-03T20:05:00.000Z" }), path);
		const all = readPending(path);
		expect(all).toHaveLength(1);
		expect(all[0]?.deadlineAt).toBe("2026-07-03T20:05:00.000Z");
	});

	it("resolvePending removes by key", () => {
		upsertPending(rec(), path);
		upsertPending(
			rec({
				key: pendingKey("alert-2", "school", 4),
				sourceAlertId: "alert-2",
			}),
			path,
		);
		resolvePending(pendingKey("alert-1", "personal", 3), path);
		const all = readPending(path);
		expect(all).toHaveLength(1);
		expect(all[0]?.sourceAlertId).toBe("alert-2");
	});

	it("claimPending claims an unclaimed record, refuses a claimed one", () => {
		upsertPending(rec(), path);
		const key = pendingKey("alert-1", "personal", 3);
		expect(claimPending(key, "codex-bot", path)).toBe(true);
		expect(readPending(path)[0]?.claimedBy).toBe("codex-bot");
		// already claimed → refuse (idempotent, no steal)
		expect(claimPending(key, "claude-bot", path)).toBe(false);
		expect(readPending(path)[0]?.claimedBy).toBe("codex-bot");
	});
});

describe("duePending", () => {
	it("returns records past their deadline that are unclaimed", () => {
		const now = Date.parse("2026-07-03T20:02:00.000Z");
		const past = rec({ deadlineAt: "2026-07-03T20:01:00.000Z" });
		const future = rec({
			key: "k2",
			sourceAlertId: "a2",
			deadlineAt: "2026-07-03T20:10:00.000Z",
		});
		expect(duePending([past, future], now).map((r) => r.key)).toEqual([
			past.key,
		]);
	});

	it("excludes claimed records (a bot is handling them)", () => {
		const now = Date.parse("2026-07-03T20:02:00.000Z");
		const claimed = rec({
			deadlineAt: "2026-07-03T20:01:00.000Z",
			claimedBy: "codex-bot",
		});
		expect(duePending([claimed], now)).toEqual([]);
	});
});
