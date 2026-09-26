import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuietSignals } from "../bridge/quiet-classifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { IdleWatchdogConfig } from "../RunnerIdleWatchdog.js";
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import type { Session } from "../StateStore.js";

/**
 * FLY-626: RunnerIdleWatchdog must NOT wake the Lead (`runner_idle_detected`)
 * for a legitimately-quiet runner. The cheap `quietSignalsProbe` + classifyQuiet
 * suppress the wake; an unexplained quiet (or no probe) still wakes.
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

function createMockStore(sessions: Session[]) {
	return {
		getActiveSessions: vi.fn(() => sessions),
		appendLeadEvent: vi.fn(() => 1),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		isLeadEventDelivered: vi.fn(() => false),
		// FLY-637: persistent quiet-wake dedup surface the watchdog now consults.
		hasQuietWakeNotified: vi.fn(() => false),
		recordQuietWakeNotified: vi.fn(),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
}

function createWatchdog(quietSignals: QuietSignals | null) {
	const sessions = [makeSession()];
	const store = createMockStore(sessions);
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
		// biome-ignore lint/suspicious/noExplicitAny: test mocks
		store: store as any,
		// biome-ignore lint/suspicious/noExplicitAny: test mocks
		runtimeRegistry: registry as any,
		captureSessionFn: vi.fn(async () => ({
			output: "idle pane",
			executionId: "exec-1",
			projectName: "geo",
			// biome-ignore lint/suspicious/noExplicitAny: test mocks
		})) as any,
		quietSignalsProbe: quietSignals ? () => quietSignals : undefined,
	};
	const watchdog = new RunnerIdleWatchdog(config);
	// Force an immediate-trigger "idle" status.
	(watchdog as unknown as { statusQuery: unknown }).statusQuery = {
		query: vi.fn(async () => ({
			result: { status: "idle", reason: "idle at prompt" },
			output: "idle pane",
		})),
		stopEviction: vi.fn(),
	};
	return { watchdog, store };
}

function signals(over: Partial<QuietSignals> = {}): QuietSignals {
	return {
		status: "running",
		hasPendingGate: false,
		hasRecentComm: false,
		hasPendingReviewSignal: false,
		declaredKind: null,
		...over,
	};
}

describe("RunnerIdleWatchdog FLY-626 quiet suppression", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("suppresses the idle wake for a self-declared parked runner", async () => {
		const { watchdog, store } = createWatchdog(
			signals({ declaredKind: "parked" }),
		);
		await watchdog.pollOnce();
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("suppresses for long_task / pending_gate / recent_comm", async () => {
		for (const s of [
			signals({ declaredKind: "long_task" }),
			signals({ hasPendingGate: true }),
			signals({ hasRecentComm: true }),
		]) {
			const { watchdog, store } = createWatchdog(s);
			await watchdog.pollOnce();
			expect(store.appendLeadEvent).not.toHaveBeenCalled();
		}
	});

	it("still wakes when the quiet is unexplained", async () => {
		const { watchdog, store } = createWatchdog(signals()); // nothing explains it
		await watchdog.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("byte-compat: no probe wired ⇒ wakes (pre-FLY-626 behavior)", async () => {
		const { watchdog, store } = createWatchdog(null);
		await watchdog.pollOnce();
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});
});
