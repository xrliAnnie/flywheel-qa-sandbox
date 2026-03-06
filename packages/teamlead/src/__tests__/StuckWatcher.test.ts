import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StuckWatcher } from "../StuckWatcher.js";
import type { Session } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-stuck",
		issue_id: "GEO-100",
		project_name: "geoforge",
		status: "running",
		issue_identifier: "GEO-100",
		last_activity_at: "2026-03-06 09:00:00",
		...overrides,
	};
}

describe("StuckWatcher", () => {
	let store: { getStuckSessions: ReturnType<typeof vi.fn> };
	let notifier: { onSessionStuck: ReturnType<typeof vi.fn> };
	let watcher: StuckWatcher;

	beforeEach(() => {
		store = { getStuckSessions: vi.fn().mockReturnValue([]) };
		notifier = { onSessionStuck: vi.fn().mockResolvedValue(undefined) };
		watcher = new StuckWatcher(store as any, notifier as any, 15, 60_000);
	});

	afterEach(() => {
		watcher.stop();
	});

	it("check() detects stuck session and notifies", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await watcher.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledWith(session, expect.any(Number));
	});

	it("check() skips already-notified sessions", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await watcher.check();
		await watcher.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("check() does nothing when no stuck sessions", async () => {
		store.getStuckSessions.mockReturnValue([]);

		await watcher.check();

		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	});

	it("start/stop manages interval", () => {
		vi.useFakeTimers();

		watcher.start();
		// Starting again is a no-op
		watcher.start();

		vi.advanceTimersByTime(60_000);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);

		watcher.stop();
		vi.advanceTimersByTime(60_000);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);

		vi.useRealTimers();
	});
});
