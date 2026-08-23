import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
} from "../bridge/tmux-lookup.js";
import {
	HeartbeatService,
	type StaleTerminalCloseConfig,
} from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

// FLY-867: checkStaleCompleted probes tmux through these module-level imports;
// mock them so the stale loop reaches the close/notify branch deterministically.
vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: vi.fn(() => ({
		tmuxWindow: "runner-p:FLY-1-claude-x",
	})),
	isTmuxWindowAlive: vi.fn(async () => true),
	lookupTmuxTarget: vi.fn(),
	probeRunnerProcessLiveness: vi.fn(),
}));

const mockGetTmuxTarget = vi.mocked(getTmuxTargetFromCommDb);
const mockIsTmuxAlive = vi.mocked(isTmuxWindowAlive);

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "qa-exec-1",
		issue_id: "FLY-1",
		project_name: "p",
		status: "completed",
		issue_identifier: "FLY-1",
		last_activity_at: "2026-03-06 09:00:00",
		...overrides,
	} as Session;
}

describe("FLY-867 stale-terminal close (checkStaleCompleted upgrade)", () => {
	let store: {
		getStaleCompletedSessions: ReturnType<typeof vi.fn>;
		getSession: ReturnType<typeof vi.fn>;
	};
	let notifier: { onSessionStale: ReturnType<typeof vi.fn> };
	let closeStale: ReturnType<typeof vi.fn>;
	let staleCfg: StaleTerminalCloseConfig;

	function makeService(cfg?: StaleTerminalCloseConfig): HeartbeatService {
		return new HeartbeatService(
			store as never,
			notifier as never,
			15,
			60_000,
			60,
			undefined,
			24, // staleThresholdHours
			0, // staleCheckIntervalMs=0 → every call runs the stale sweep
			undefined,
			48,
			undefined,
			undefined,
			cfg,
		);
	}

	beforeEach(() => {
		store = {
			getStaleCompletedSessions: vi.fn().mockReturnValue([]),
			getSession: vi.fn().mockReturnValue(undefined),
		};
		notifier = { onSessionStale: vi.fn().mockResolvedValue(undefined) };
		closeStale = vi.fn().mockResolvedValue({ closed: true });
		staleCfg = { closeStale };
	});

	it("closes a leaked completed session and skips the stale notify", async () => {
		const s = makeSession({ status: "completed" });
		store.getStaleCompletedSessions.mockReturnValue([s]);
		const service = makeService(staleCfg);

		await service.checkStaleCompleted();

		expect(closeStale).toHaveBeenCalledOnce();
		expect(closeStale).toHaveBeenCalledWith(s);
		expect(notifier.onSessionStale).not.toHaveBeenCalled();
	});

	it("closes failed and blocked leaks too (backstop owns the full stale-query set)", async () => {
		const failed = makeSession({ execution_id: "e-f", status: "failed" });
		const blocked = makeSession({ execution_id: "e-b", status: "blocked" });
		store.getStaleCompletedSessions.mockReturnValue([failed, blocked]);
		const service = makeService(staleCfg);

		await service.checkStaleCompleted();

		expect(closeStale).toHaveBeenCalledTimes(2);
		expect(notifier.onSessionStale).not.toHaveBeenCalled();
	});

	it("falls through to notify (and does NOT dedupe the close) when the close fails", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		closeStale.mockResolvedValue({ closed: false });
		const service = makeService(staleCfg);

		await service.checkStaleCompleted();
		expect(closeStale).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStale).toHaveBeenCalledTimes(1);

		// Next cycle: close is RETRIED (not deduped); the notify IS deduped.
		await service.checkStaleCompleted();
		expect(closeStale).toHaveBeenCalledTimes(2);
		expect(notifier.onSessionStale).toHaveBeenCalledTimes(1);
	});

	it("treats alreadyGone as a confirmed teardown (no notify)", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		closeStale.mockResolvedValue({ closed: false, alreadyGone: true });
		const service = makeService(staleCfg);

		await service.checkStaleCompleted();

		expect(notifier.onSessionStale).not.toHaveBeenCalled();
	});

	it("unwired (no 14th constructor arg) → pre-FLY-867 notify-only", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		const service = makeService(undefined);

		await service.checkStaleCompleted();

		expect(closeStale).not.toHaveBeenCalled();
		expect(notifier.onSessionStale).toHaveBeenCalledOnce();
	});

	// FLY-867 (Codex code R1 MEDIUM): the unwired path must be byte-compatible
	// with pre-FLY-867 GEO-270 — an already-notified stale session is dedup'd
	// BEFORE the CommDB/tmux probe, not after. Assert the probe runs exactly once
	// across two cycles (not once per cycle).
	it("unwired: an already-notified session is NOT re-probed on the next cycle (byte-compat)", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		mockGetTmuxTarget.mockClear();
		mockIsTmuxAlive.mockClear();
		const service = makeService(undefined);

		await service.checkStaleCompleted();
		await service.checkStaleCompleted();

		expect(mockGetTmuxTarget).toHaveBeenCalledTimes(1);
		expect(mockIsTmuxAlive).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStale).toHaveBeenCalledTimes(1);
	});

	// Counterpart: when close IS enabled, the probe DOES run every cycle (a
	// failed close must keep retrying) — proves the byte-compat guard is
	// close-disabled-only, not a blanket regression.
	it("close enabled: a failed-close session IS re-probed every cycle (retry semantics)", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		closeStale.mockResolvedValue({ closed: false });
		mockGetTmuxTarget.mockClear();
		mockIsTmuxAlive.mockClear();
		const service = makeService(staleCfg);

		await service.checkStaleCompleted();
		await service.checkStaleCompleted();

		expect(mockGetTmuxTarget).toHaveBeenCalledTimes(2);
		expect(closeStale).toHaveBeenCalledTimes(2);
	});

	it("a successful close clears the notify dedup so a same-exec reincarnation re-notifies", async () => {
		const s = makeSession();
		store.getStaleCompletedSessions.mockReturnValue([s]);
		// Cycle 1: close fails → notify + dedup entry.
		closeStale.mockResolvedValueOnce({ closed: false });
		const service = makeService(staleCfg);
		await service.checkStaleCompleted();
		expect(notifier.onSessionStale).toHaveBeenCalledTimes(1);
		// Cycle 2: close succeeds → dedup entry cleared.
		closeStale.mockResolvedValueOnce({ closed: true });
		await service.checkStaleCompleted();
		// Cycle 3: same exec leaks AGAIN (reincarnation); close fails, so the
		// notify must fire again rather than being suppressed by stale dedup state.
		closeStale.mockResolvedValueOnce({ closed: false });
		await service.checkStaleCompleted();
		expect(notifier.onSessionStale).toHaveBeenCalledTimes(2);
	});
});
