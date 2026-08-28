import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadAlertNotifier } from "../../LeadAlertNotifier.js";
import { MetaAlertNotifier } from "../../MetaAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { startBridge } from "../plugin.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import type { BridgeConfig } from "../types.js";

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		generalChannel: "1516209289406971965",
		leads: [
			{
				agentId: "claude-infra-bot-lead",
				chatChannel: "alerts-test",
				alertChannel: "alerts-test",
				botToken: "test-token",
				match: { labels: ["Infra"] },
			},
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "alerts-test",
				alertChannel: "alerts-test",
				botToken: "test-token",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function config(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "alerts-test",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		replyByIssueEnabled: false,
		replyGuardEnabled: false,
		issuePrefixes: ["FLY"],
	};
}

async function seedQueuedAlerts(
	queueDir: string,
	deadLetterDir: string,
	count: number,
) {
	const store = await StateStore.create(":memory:");
	try {
		const notifier = new LeadAlertNotifier({
			store,
			projects,
			queueDir,
			deadLetterDir,
			fetchFn: async () =>
				new Response("unavailable", {
					status: 503,
					statusText: "Service Unavailable",
				}),
		});
		for (let index = 0; index < count; index++) {
			await expect(
				notifier.alert({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					eventId: `qa2076-drain-stuck-${index}`,
					eventType: index === 0 ? "rate_limit" : "login_expired",
					title: "queued alert",
					body: "Discord is unavailable",
					severity: "warning",
				}),
			).resolves.toMatchObject({ queued: true });
		}
	} finally {
		store.close();
	}
}

async function flushDrainTick(tick: () => void): Promise<void> {
	tick();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("FLY-2076 alert queue drain master switch", () => {
	const tempRoots: string[] = [];
	type DrainResult = Awaited<ReturnType<LeadAlertNotifier["drainQueue"]>>;

	async function runScenario(input: {
		enabled: boolean;
		queueSize: number;
		overflowThreshold: number;
		ticks: number;
	}) {
		const notify = vi
			.spyOn(MetaAlertNotifier.prototype, "notify")
			.mockResolvedValue({ debounced: false, desktop: false, file: true });
		vi.spyOn(
			MetaAlertNotifier.prototype,
			"probeDesktopCapability",
		).mockResolvedValue(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("unavailable", {
						status: 503,
						statusText: "Service Unavailable",
					}),
			),
		);

		const root = mkdtempSync(join(tmpdir(), "fly2076-drain-switch-"));
		tempRoots.push(root);
		const queueDir = join(root, "queue");
		const deadLetterDir = join(root, "deadletter");
		await seedQueuedAlerts(queueDir, deadLetterDir, input.queueSize);
		vi.stubEnv("FLYWHEEL_STATE_DIR", join(root, "state"));
		vi.stubEnv("FLYWHEEL_ALERT_QUEUE_DIR", queueDir);
		vi.stubEnv("FLYWHEEL_ALERT_DEADLETTER_DIR", deadLetterDir);
		vi.stubEnv("FLYWHEEL_ALERT_DRAIN_STUCK_CYCLES", "2");
		vi.stubEnv("FLYWHEEL_ALERT_QUEUE_MAX", String(input.overflowThreshold));
		// The real Bridge reads these ambient production settings during startup.
		// Keep this drain regression on its local notifier path so configured dev
		// hosts cannot inject unrelated roundtable or unified-alert behavior.
		vi.stubEnv("FLYWHEEL_ROUNDTABLE_CHANNEL_ID", "");
		vi.stubEnv("FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID", "");
		vi.stubEnv("FLYWHEEL_ALERT_SENDER_TOKEN_ENV", "");
		vi.stubEnv("FLYWHEEL_CODEX_HEALTH_GUARD", "0");

		const drainResults: DrainResult[] = [];
		const originalDrainQueue = LeadAlertNotifier.prototype.drainQueue;
		vi.spyOn(LeadAlertNotifier.prototype, "drainQueue").mockImplementation(
			async function (this: LeadAlertNotifier) {
				const result = await originalDrainQueue.call(this);
				drainResults.push(result);
				return result;
			},
		);

		const realSetInterval = globalThis.setInterval.bind(globalThis);
		const minuteTicks: Array<() => void> = [];
		const intervalSpy = vi
			.spyOn(globalThis, "setInterval")
			.mockImplementation(((handler, timeout, ...args) => {
				if (
					timeout === 60_000 &&
					typeof handler === "function" &&
					String(handler).includes("drainQueue")
				) {
					minuteTicks.push(() => handler(...args));
					const inert = realSetInterval(() => {}, 24 * 60 * 60_000);
					inert.unref?.();
					return inert;
				}
				return realSetInterval(handler, timeout, ...args);
			}) as typeof setInterval);

		const bridge = await startBridge(config(), projects);
		try {
			expect(minuteTicks).toHaveLength(1);
			if (!input.enabled) {
				const current = bridge.store.getFlagValueRow("alert_system");
				expect(current).toBeDefined();
				expect(
					bridge.store.applyFlagValueChange({
						name: "alert_system",
						rawTo: "0",
						expectedRevision: current!.revision,
						actor: "qa",
						reason: "FLY-2076 drain meta-alert OFF regression",
					}),
				).toMatchObject({ ok: true });
			}
			for (let index = 0; index < input.ticks; index++) {
				await flushDrainTick(minuteTicks[0]!);
			}
		} finally {
			await bridge.close();
			intervalSpy.mockRestore();
		}

		return { drainResults, notify };
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves a queued item without paging drain_stuck while OFF", async () => {
		const { drainResults, notify } = await runScenario({
			enabled: false,
			queueSize: 1,
			overflowThreshold: 500,
			ticks: 2,
		});
		expect(drainResults).toEqual([
			expect.objectContaining({ sent: 0, remaining: 1 }),
			expect.objectContaining({ sent: 0, remaining: 1 }),
		]);
		expect(notify).not.toHaveBeenCalled();
	}, 30_000);

	it("preserves an overflowing queue without paging queue_overflow while OFF", async () => {
		const { drainResults, notify } = await runScenario({
			enabled: false,
			queueSize: 2,
			overflowThreshold: 1,
			ticks: 1,
		});
		expect(drainResults).toEqual([
			expect.objectContaining({ sent: 0, remaining: 2 }),
		]);
		expect(notify).not.toHaveBeenCalled();
	}, 30_000);

	it("still pages drain_stuck for a genuine ON stall", async () => {
		const { notify } = await runScenario({
			enabled: true,
			queueSize: 1,
			overflowThreshold: 500,
			ticks: 2,
		});
		expect(
			notify.mock.calls.filter(([input]) => input.reason === "drain_stuck"),
		).toHaveLength(1);
	}, 30_000);
});
