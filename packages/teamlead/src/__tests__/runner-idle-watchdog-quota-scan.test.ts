/**
 * FLY-696 M1/③ — the RunnerIdleWatchdog `runnerQuotaScan` piggyback contract:
 *   - called once per session with the SAME capture output the poll took;
 *   - skipped on capture infra errors (no valid pane);
 *   - a throwing scan is contained (the idle poll survives);
 *   - absent scan (self-heal off) = byte-compat no-op.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { IdleWatchdogConfig } from "../RunnerIdleWatchdog.js";
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import type { Session } from "../StateStore.js";

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

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-100",
		project_name: "geo",
		status: "running",
		issue_identifier: "GEO-100",
		issue_labels: "Product",
		...overrides,
	};
}

function createMockStore(sessions: Session[]) {
	return {
		getActiveSessions: vi.fn(() => sessions),
		appendLeadEvent: vi.fn(() => 1),
		isLeadEventDelivered: vi.fn(() => false),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		recoverFromCorruption: vi.fn(() => false),
		hasQuietWakeNotified: vi.fn(() => false),
		recordQuietWakeNotified: vi.fn(),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
}

function createWatchdog(opts: {
	scan?: (session: Session, pane: string) => void | Promise<void>;
	statusResponse: {
		result: { status: string; reason: string };
		captureErrorStatus?: number;
		output?: string;
	};
}) {
	const sessions = [makeSession()];
	const store = createMockStore(sessions);
	const registry = {
		getForLead: vi.fn(() => ({
			deliver: vi.fn(async () => ({ delivered: true })),
			shutdown: vi.fn(),
		})),
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
		store: store as any,
		runtimeRegistry: registry as any,
		captureSessionFn: vi.fn(async () => ({
			output: "dummy",
			executionId: "exec-1",
			projectName: "geo",
		})) as any,
		...(opts.scan !== undefined && { runnerQuotaScan: opts.scan }),
	};

	const watchdog = new RunnerIdleWatchdog(config);
	(watchdog as any).statusQuery = {
		query: vi.fn(async () => opts.statusResponse),
		stopEviction: vi.fn(),
	};
	return watchdog;
}

describe("RunnerIdleWatchdog runnerQuotaScan piggyback (FLY-696 M1/③)", () => {
	it("calls the scan once with the session + the SAME captured pane", async () => {
		const scan = vi.fn();
		const watchdog = createWatchdog({
			scan,
			statusResponse: {
				result: { status: "executing", reason: "active" },
				output: "PANE-CONTENT",
			},
		});
		await watchdog.pollOnce();
		expect(scan).toHaveBeenCalledOnce();
		expect(scan).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
			"PANE-CONTENT",
		);
	});

	it("skips the scan on a capture infra error (no valid pane)", async () => {
		const scan = vi.fn();
		const watchdog = createWatchdog({
			scan,
			statusResponse: {
				result: { status: "unknown", reason: "capture failed" },
				captureErrorStatus: 502,
				output: undefined,
			},
		});
		await watchdog.pollOnce();
		expect(scan).not.toHaveBeenCalled();
	});

	it("a throwing scan is contained — the poll completes without rejecting", async () => {
		const scan = vi.fn(() => {
			throw new Error("scan exploded");
		});
		const watchdog = createWatchdog({
			scan,
			statusResponse: {
				result: { status: "executing", reason: "active" },
				output: "PANE",
			},
		});
		await expect(watchdog.pollOnce()).resolves.toBeUndefined();
		expect(scan).toHaveBeenCalledOnce();
	});

	it("absent scan (self-heal off) — poll runs unchanged (byte-compat)", async () => {
		const watchdog = createWatchdog({
			statusResponse: {
				result: { status: "executing", reason: "active" },
				output: "PANE",
			},
		});
		await expect(watchdog.pollOnce()).resolves.toBeUndefined();
	});
});
