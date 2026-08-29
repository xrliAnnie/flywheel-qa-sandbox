/**
 * FLY-205 `waitForSession` unit coverage — added by FLY-123 when consolidating
 * the ghost-start guard onto this helper (QA Finding 3). The helper had no
 * dedicated unit test; these lock its bounded-poll contract:
 *   - slow-but-alive (row appears after N polls) → returned (no false ghost)
 *   - genuine ghost (row never appears) → undefined after the deadline
 * Uses real timers with tiny intervals (fast) + a mock store.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session, StateStore } from "../../StateStore.js";
import { waitForSession } from "../session-wait.js";

function mockStore(getSession: () => Session | undefined): StateStore {
	return { getSession } as unknown as StateStore;
}

const fakeRow = { execution_id: "e1" } as unknown as Session;

describe("waitForSession (FLY-205 helper; FLY-123 ghost-guard coverage)", () => {
	it("returns immediately when the row already exists (no poll)", async () => {
		const getSession = vi.fn(() => fakeRow);
		const row = await waitForSession(mockStore(getSession), "e1", {
			intervalMs: 5,
			timeoutMs: 1000,
		});
		expect(row).toBe(fakeRow);
		expect(getSession).toHaveBeenCalledTimes(1);
	});

	it("slow-but-alive: row appears after N polls → returned (FLY-123 F3 contract)", async () => {
		let calls = 0;
		const getSession = vi.fn(() => (++calls >= 4 ? fakeRow : undefined));
		const row = await waitForSession(mockStore(getSession), "e1", {
			intervalMs: 5,
			timeoutMs: 1000,
		});
		expect(row).toBe(fakeRow);
		expect(calls).toBeGreaterThanOrEqual(4);
	});

	it("genuine ghost: row never appears → undefined after the deadline", async () => {
		const getSession = vi.fn(() => undefined);
		const start = Date.now();
		const row = await waitForSession(mockStore(getSession), "e1", {
			intervalMs: 5,
			timeoutMs: 40,
		});
		expect(row).toBeUndefined();
		expect(Date.now() - start).toBeGreaterThanOrEqual(35);
		expect(getSession.mock.calls.length).toBeGreaterThan(1); // polled, not one-shot
	});
});
