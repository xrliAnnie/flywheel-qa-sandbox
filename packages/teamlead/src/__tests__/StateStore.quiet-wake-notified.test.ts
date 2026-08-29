import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-637 #3/#4: persistent "already-notified" dedup for the quiet-path Lead
 * wake. Keyed by (execution_id, source, episode_fingerprint) so a Bridge restart
 * cannot re-wake the Lead for a frozen frame already reported. Direction A
 * (report-once) — NO backoff state, just a durable "reported this frame" flag.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("StateStore quiet_wake_notified (FLY-637)", () => {
	it("record then has = true; absent = false", async () => {
		const store = await freshStore();
		expect(store.hasQuietWakeNotified("e1", "idle", "fpX")).toBe(false);
		store.recordQuietWakeNotified("e1", "idle", "fpX");
		expect(store.hasQuietWakeNotified("e1", "idle", "fpX")).toBe(true);
	});

	it("distinct fingerprints are independent (a new frozen frame is wakeable)", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "idle", "fpX");
		expect(store.hasQuietWakeNotified("e1", "idle", "fpX")).toBe(true);
		expect(store.hasQuietWakeNotified("e1", "idle", "fpY")).toBe(false);
	});

	it("distinct sources are independent (idle vs stuck)", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "idle", "fp");
		expect(store.hasQuietWakeNotified("e1", "idle", "fp")).toBe(true);
		expect(store.hasQuietWakeNotified("e1", "stuck", "fp")).toBe(false);
	});

	it("recording the same key twice is idempotent (no throw)", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "stuck", "stuck");
		store.recordQuietWakeNotified("e1", "stuck", "stuck");
		expect(store.hasQuietWakeNotified("e1", "stuck", "stuck")).toBe(true);
	});

	it("clearQuietWakeNotified(execId) clears all sources for that execId only", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "idle", "a");
		store.recordQuietWakeNotified("e1", "stuck", "stuck");
		store.recordQuietWakeNotified("e2", "idle", "a");
		store.clearQuietWakeNotified("e1");
		expect(store.hasQuietWakeNotified("e1", "idle", "a")).toBe(false);
		expect(store.hasQuietWakeNotified("e1", "stuck", "stuck")).toBe(false);
		expect(store.hasQuietWakeNotified("e2", "idle", "a")).toBe(true);
	});

	it("clearQuietWakeNotified(execId, source) clears only that source", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "idle", "a");
		store.recordQuietWakeNotified("e1", "stuck", "stuck");
		store.clearQuietWakeNotified("e1", "idle");
		expect(store.hasQuietWakeNotified("e1", "idle", "a")).toBe(false);
		expect(store.hasQuietWakeNotified("e1", "stuck", "stuck")).toBe(true);
	});

	it("pruneQuietWakeNotifiedNotIn keeps listed execIds, drops the rest, within a source", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("keep", "idle", "a");
		store.recordQuietWakeNotified("drop", "idle", "a");
		store.recordQuietWakeNotified("drop", "stuck", "stuck"); // other source untouched
		store.pruneQuietWakeNotifiedNotIn("idle", ["keep"]);
		expect(store.hasQuietWakeNotified("keep", "idle", "a")).toBe(true);
		expect(store.hasQuietWakeNotified("drop", "idle", "a")).toBe(false);
		expect(store.hasQuietWakeNotified("drop", "stuck", "stuck")).toBe(true);
	});

	it("pruneQuietWakeNotifiedNotIn([]) deletes ALL rows for the source (empty-set guard, no SQL error)", async () => {
		const store = await freshStore();
		store.recordQuietWakeNotified("e1", "idle", "a");
		store.recordQuietWakeNotified("e2", "idle", "b");
		store.recordQuietWakeNotified("e1", "stuck", "stuck");
		expect(() => store.pruneQuietWakeNotifiedNotIn("idle", [])).not.toThrow();
		expect(store.hasQuietWakeNotified("e1", "idle", "a")).toBe(false);
		expect(store.hasQuietWakeNotified("e2", "idle", "b")).toBe(false);
		// other source untouched
		expect(store.hasQuietWakeNotified("e1", "stuck", "stuck")).toBe(true);
	});

	it("dedup survives a reopen of the same DB file (restart-tolerant)", async () => {
		// :memory: is per-connection; use a temp file to prove persistence.
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly637-store-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			const s1 = await StateStore.create(dbPath);
			s1.recordQuietWakeNotified("e1", "idle", "frozen");
			s1.close();
			const s2 = await StateStore.create(dbPath);
			expect(s2.hasQuietWakeNotified("e1", "idle", "frozen")).toBe(true);
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
