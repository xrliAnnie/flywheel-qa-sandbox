import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuietSignals } from "../bridge/quiet-classifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { IdleWatchdogConfig } from "../RunnerIdleWatchdog.js";
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import type { Session } from "../StateStore.js";

/**
 * FLY-637 #2/#3: RunnerIdleWatchdog dedup is keyed on the normalized
 * quietFingerprint of the pane and persisted, so:
 *   - cosmetic pane jitter (spinner / ctx%) does NOT re-wake the Lead,
 *   - `executing` flicker does NOT clear the persistent dedup row,
 *   - a genuinely new frozen frame CAN wake once,
 *   - a Bridge restart (fresh watchdog, same store) does NOT re-wake,
 *   - `unknown` (no pane output) stays on in-memory status dedup,
 *   - the kill-switch reverts to MVP in-memory dedup.
 */

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-100",
		project_name: "geo",
		status: "running",
		issue_identifier: "GEO-100",
		issue_labels: "Product",
		...over,
	};
}

/** Store mock: event sinks via vi.fn, dedup methods backed by a real Set. */
function makeStore(sessions: Session[]) {
	const notified = new Set<string>(); // `${exec}|${source}|${fp}`
	const k = (e: string, s: string, f: string) => `${e}|${s}|${f}`;
	return {
		notified,
		getActiveSessions: vi.fn(() => sessions),
		appendLeadEvent: vi.fn(() => 1),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		isLeadEventDelivered: vi.fn(() => false),
		hasQuietWakeNotified: vi.fn((e: string, s: string, f: string) =>
			notified.has(k(e, s, f)),
		),
		recordQuietWakeNotified: vi.fn((e: string, s: string, f: string) => {
			notified.add(k(e, s, f));
		}),
		clearQuietWakeNotified: vi.fn((e: string, s?: string) => {
			for (const key of [...notified]) {
				const [ke, ks] = key.split("|");
				if (ke === e && (!s || ks === s)) notified.delete(key);
			}
		}),
		pruneQuietWakeNotifiedNotIn: vi.fn((s: string, keep: string[]) => {
			for (const key of [...notified]) {
				const [ke, ks] = key.split("|");
				if (ks === s && !keep.includes(ke)) notified.delete(key);
			}
		}),
	};
}

type PollStep = { status: string; reason?: string; output?: string };

function makeWatchdog(
	store: ReturnType<typeof makeStore>,
	steps: PollStep[],
	quiet: QuietSignals | null,
) {
	const runtime = {
		deliver: vi.fn(async () => ({ delivered: true })),
		shutdown: vi.fn(),
	};
	const registry = {
		getForLead: vi.fn(() => runtime),
		register: vi.fn(),
		resolve: vi.fn(),
		resolveWithLead: vi.fn(),
		shutdownAll: vi.fn(),
		size: 1,
	};
	const config: IdleWatchdogConfig = {
		pollIntervalMs: 30_000,
		waitingThresholdCycles: 2,
		projects: testProjects,
		store: store as unknown as IdleWatchdogConfig["store"],
		runtimeRegistry:
			registry as unknown as IdleWatchdogConfig["runtimeRegistry"],
		captureSessionFn:
			vi.fn() as unknown as IdleWatchdogConfig["captureSessionFn"],
		quietSignalsProbe: quiet ? () => quiet : undefined,
	};
	const watchdog = new RunnerIdleWatchdog(config);
	let i = 0;
	(watchdog as unknown as { statusQuery: unknown }).statusQuery = {
		query: vi.fn(async () => {
			const step = steps[Math.min(i, steps.length - 1)];
			i++;
			return {
				result: { status: step.status, reason: step.reason ?? step.status },
				output: step.output,
			};
		}),
		stopEviction: vi.fn(),
	};
	return watchdog;
}

const unexplained: QuietSignals = {
	status: "running",
	hasPendingGate: false,
	hasRecentComm: false,
	hasPendingReviewSignal: false,
	declaredKind: null,
};

// Same real content; only the volatile spinner timer churns → SAME normalized fp.
const FRAME_A = "Editing the handler\n✻ Cooked for 12s";
const FRAME_A_JITTER = "Editing the handler\n✻ Cooked for 47s";
// Real progress → DIFFERENT normalized fp.
const FRAME_B = "Running the test suite\n✻ Cooked for 3s";

describe("RunnerIdleWatchdog FLY-637 fingerprint dedup", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.FLYWHEEL_QUIET_PERSIST_DEDUP;
	});

	it("emits once for a frozen frame and never again despite spinner jitter (#2)", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd = makeWatchdog(
			store,
			[
				{ status: "idle", output: FRAME_A },
				{ status: "idle", output: FRAME_A_JITTER }, // jitter only → same fp
			],
			unexplained,
		);
		await wd.pollOnce();
		await wd.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("does NOT clear the persistent dedup on executing flicker (#1 HIGH)", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd = makeWatchdog(
			store,
			[
				{ status: "idle", output: FRAME_A }, // emit (record fp_A)
				{ status: "executing", output: FRAME_A_JITTER }, // flicker — must NOT clear
				{ status: "idle", output: FRAME_A }, // same fp → suppressed
			],
			unexplained,
		);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("a genuinely new frozen frame (different normalized fp) wakes once more (#2)", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd = makeWatchdog(
			store,
			[
				{ status: "idle", output: FRAME_A }, // emit for A
				{ status: "executing", output: FRAME_B }, // real progress
				{ status: "idle", output: FRAME_B }, // new frozen frame → emit for B
			],
			unexplained,
		);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
	});

	it("a Bridge restart (fresh watchdog, same store) does NOT re-wake the same frame (#3/#4)", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd1 = makeWatchdog(
			store,
			[{ status: "idle", output: FRAME_A }],
			unexplained,
		);
		await wd1.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
		// New watchdog instance = wiped in-memory state, but the persistent row remains.
		const wd2 = makeWatchdog(
			store,
			[{ status: "idle", output: FRAME_A }],
			unexplained,
		);
		await wd2.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1); // still 1, not 2
	});

	it("unknown (no pane output) uses in-memory status dedup, not the persistent table (#3 MED)", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd1 = makeWatchdog(
			store,
			[
				{ status: "unknown", output: undefined },
				{ status: "unknown", output: undefined }, // same status → in-memory dedup
			],
			unexplained,
		);
		await wd1.pollOnce();
		await wd1.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
		// no persistent row written for the no-pane case
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
		// a fresh watchdog re-wakes (proves it was in-memory, not persistent)
		const wd2 = makeWatchdog(
			store,
			[{ status: "unknown", output: undefined }],
			unexplained,
		);
		await wd2.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
	});

	it("kill-switch FLYWHEEL_QUIET_PERSIST_DEDUP=0 reverts to MVP in-memory dedup (byte-compat)", async () => {
		process.env.FLYWHEEL_QUIET_PERSIST_DEDUP = "0";
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd1 = makeWatchdog(
			store,
			[
				{ status: "idle", output: FRAME_A },
				{ status: "idle", output: FRAME_A },
			],
			unexplained,
		);
		await wd1.pollOnce();
		await wd1.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1); // in-memory dedup
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled(); // no persistence
		// fresh watchdog re-wakes (MVP: in-memory only, restart re-alerts)
		const wd2 = makeWatchdog(
			store,
			[{ status: "idle", output: FRAME_A }],
			unexplained,
		);
		await wd2.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
	});

	it("prunes persistent idle rows for sessions no longer running", async () => {
		const sessions = [makeSession()];
		const store = makeStore(sessions);
		const wd = makeWatchdog(
			store,
			[{ status: "idle", output: FRAME_A }],
			unexplained,
		);
		await wd.pollOnce();
		expect(store.notified.size).toBe(1);
		// session leaves the running set → next poll prunes its row
		sessions.length = 0;
		await wd.pollOnce();
		expect(store.notified.size).toBe(0);
	});
});
