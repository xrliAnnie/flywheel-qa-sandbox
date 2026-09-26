import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetSensors } from "../bridge/fleet-sensors.js";
import type { PressureSnapshot } from "../bridge/machine-watermark.js";
import {
	createPressureSampler,
	pressureNotificationPayload,
} from "../bridge/pressure-sampler.js";
import {
	type AlertPayload,
	FLEET_ALERT_PROJECT,
	LeadAlertNotifier,
} from "../LeadAlertNotifier.js";
import { StateStore } from "../StateStore.js";

const unifiedAlert = {
	channelId: "alerts",
	repairBotTokenEnv: "CASS_BOT_TOKEN",
};

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "swap",
		projectName: FLEET_ALERT_PROJECT,
		eventId: "swap-pressure:episode-a",
		eventType: "swap_pressure_high",
		episodeId: "episode-a",
		title: "memory pressure",
		body: "pressure is high",
		severity: "severe",
		...over,
	};
}

function queueFile(
	queueDir: string,
	name: string,
	record: AlertPayload & { queuedAt?: string; queueReason?: string },
): void {
	writeFileSync(join(queueDir, `${name}.json`), JSON.stringify(record), "utf8");
}

function okFetch() {
	let id = 0;
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () => "",
		json: async () => ({ id: `root-${++id}` }),
	}));
}

describe("FLY-1764 replay freshness", () => {
	let store: StateStore;
	let queueDir: string;
	let deadLetterDir: string;
	let savedMode: string | undefined;
	let savedSender: string | undefined;
	let savedToken: string | undefined;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		queueDir = mkdtempSync(join(tmpdir(), "fly1764-replay-q-"));
		deadLetterDir = mkdtempSync(join(tmpdir(), "fly1764-replay-dl-"));
		savedMode = process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS;
		savedSender = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		savedToken = process.env.TEST_REPLAY_ALERT_TOKEN;
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = "TEST_REPLAY_ALERT_TOKEN";
		process.env.TEST_REPLAY_ALERT_TOKEN = "test-token";
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(queueDir, { recursive: true, force: true });
		rmSync(deadLetterDir, { recursive: true, force: true });
		for (const [key, value] of [
			["FLYWHEEL_ALERT_REPLAY_FRESHNESS", savedMode],
			["FLYWHEEL_ALERT_SENDER_TOKEN_ENV", savedSender],
			["TEST_REPLAY_ALERT_TOKEN", savedToken],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("drop_stale suppresses proven-ended episodes without counting a delivery failure", async () => {
		process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = "drop_stale";
		queueFile(queueDir, "001-a", {
			...payload(),
			queuedAt: "2026-08-14T09:00:00.000Z",
			queueReason: "discord-503",
		});
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn,
			queueDir,
			deadLetterDir,
			unifiedAlert,
			replayFreshnessProbe: () => true,
			queueMaxAgeMs: Number.POSITIVE_INFINITY,
		});

		const result = await notifier.drainQueue();

		expect(result).toMatchObject({
			sent: 0,
			remaining: 0,
			deadLettered: 0,
			staleSuppressed: 1,
			delivered: [],
		});
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(deadLetterDir)).toEqual(["stale-episode-001-a.json"]);
	});

	it("live, unknown, non-fleet, and throwing probes all fail open to delivery", async () => {
		process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = "drop_stale";
		const records = [
			payload({ eventId: "live", episodeId: "live" }),
			payload({ eventId: "unknown", episodeId: "unknown" }),
			payload({
				leadId: "lead-a",
				projectName: "flywheel",
				eventId: "other",
				eventType: "pane_hash_stuck",
				episodeId: undefined,
			}),
			payload({ eventId: "throws", episodeId: "throws" }),
		];
		for (const [index, record] of records.entries()) {
			queueFile(queueDir, `00${index}-${record.eventId}`, {
				...record,
				queuedAt: `2026-08-14T09:00:0${index}.000Z`,
				queueReason: "discord-503",
			});
		}
		const logger = vi.fn();
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn,
			queueDir,
			deadLetterDir,
			unifiedAlert,
			queueMaxAgeMs: Number.POSITIVE_INFINITY,
			logger,
			replayFreshnessProbe: (input) => {
				if (input.eventId === "live") return false;
				if (input.eventId === "throws") throw new Error("probe unavailable");
				return null;
			},
		});

		const result = await notifier.drainQueue();

		expect(result.sent).toBe(4);
		expect(result.staleSuppressed).toBe(0);
		expect(result.deadLettered).toBe(0);
		expect(fetchFn).toHaveBeenCalledTimes(4);
		expect(logger).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("probe unavailable"),
		);
	});

	it("accept_delayed is the default; an invalid mode logs once and also accepts", async () => {
		const run = async (mode: string | undefined) => {
			if (mode === undefined)
				delete process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS;
			else process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = mode;
			queueFile(queueDir, `mode-${mode ?? "default"}`, {
				...payload({ eventId: `mode-${mode ?? "default"}` }),
				queuedAt: new Date().toISOString(),
				queueReason: "discord-503",
			});
			const logger = vi.fn();
			const probe = vi.fn(() => true);
			const result = await new LeadAlertNotifier({
				store,
				projects: [],
				fetchFn: okFetch(),
				queueDir,
				deadLetterDir,
				unifiedAlert,
				logger,
				replayFreshnessProbe: probe,
			}).drainQueue();
			return { logger, probe, result };
		};

		const defaulted = await run(undefined);
		expect(defaulted.result.sent).toBe(1);
		expect(defaulted.probe).not.toHaveBeenCalled();
		expect(defaulted.logger).not.toHaveBeenCalled();

		const invalid = await run("drop_everything");
		expect(invalid.result.sent).toBe(1);
		expect(invalid.probe).not.toHaveBeenCalled();
		expect(invalid.logger).toHaveBeenCalledTimes(1);
		expect(invalid.logger).toHaveBeenCalledWith(
			expect.stringContaining("drop_everything"),
		);
	});

	it("drop_stale preserves oldest-first order for entries that remain deliverable", async () => {
		process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = "drop_stale";
		queueFile(queueDir, "z-newer-name", {
			...payload({ eventId: "older", title: "older" }),
			queuedAt: "2026-08-14T09:00:00.000Z",
			queueReason: "discord-503",
		});
		queueFile(queueDir, "a-older-name", {
			...payload({ eventId: "newer", title: "newer" }),
			queuedAt: "2026-08-14T09:01:00.000Z",
			queueReason: "discord-503",
		});
		const fetchFn = okFetch();
		await new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn,
			queueDir,
			deadLetterDir,
			unifiedAlert,
			queueMaxAgeMs: Number.POSITIVE_INFINITY,
			replayFreshnessProbe: () => false,
		}).drainQueue();

		const sentTitles = fetchFn.mock.calls.map(([, init]) => {
			const body = JSON.parse((init as RequestInit).body as string);
			return body.content as string;
		});
		expect(sentTitles[0]).toContain("older");
		expect(sentTitles[1]).toContain("newer");
	});

	it("never suppresses point-in-time crash or pressure-hold failure evidence", () => {
		const sensors = new FleetSensors({
			store,
			alert: vi.fn(),
			logger: () => {},
		});
		sensors.bootReconcileDone = true;
		store.setFleetPressureHold({ setBy: "swap-sensor" });

		expect(
			sensors.replayFreshness({
				eventType: "bridge_abnormal_exit",
				leadId: "bridge",
				eventId: "bridge-abnormal-exit:episode-a",
				episodeId: "episode-a",
			}),
		).toBeNull();
		expect(
			sensors.replayFreshness({
				eventType: "swap_pressure_high",
				leadId: "swap",
				eventId: "swap-holdfail:1720000000000",
				episodeId: "1720000000000",
			}),
		).toBeNull();
	});

	it("real pressure notices retain pause/resume/degraded identities through notifier dedup and queued replay", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
		process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = "drop_stale";
		const seed = new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn: vi.fn(async () => ({
				ok: false,
				status: 503,
				statusText: "down",
				text: async () => "down",
			})),
			queueDir,
			deadLetterDir,
			unifiedAlert,
		});
		const snapshot: PressureSnapshot = {
			sampledAtMs: Date.now(),
			source: "vm_stat",
			freePct: 12,
			swapoutDeltaPages: 0,
			baselineAtMs: Date.now() - 30_000,
			state: "healthy",
			reason: "non_danger",
			evidenceValidUntilMs: Date.now() + 90_000,
		};
		const sensors = new FleetSensors({
			store,
			alert: vi.fn(),
			pressureSnapshot: () => snapshot,
		});
		const records = (["pause", "resume", "degraded"] as const).map((kind) =>
			pressureNotificationPayload(
				{
					id: `swap-pressure:one-episode:${kind}`,
					episodeId: "one-episode",
					kind,
					snapshot,
				},
				snapshot,
			),
		);
		for (const record of records)
			expect(await seed.alert(record)).toMatchObject({ queued: true });
		expect(await seed.alert(records[1]!)).toMatchObject({
			skipped: "duplicate",
		});
		expect(readdirSync(queueDir)).toHaveLength(3);
		const fetchFn = okFetch();
		const result = await new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn,
			queueDir,
			deadLetterDir,
			unifiedAlert,
			replayFreshnessProbe: (input) => sensors.replayFreshness(input),
		}).drainQueue();
		expect(result.staleSuppressed).toBe(1);
		expect(result.sent).toBe(2);
		expect(result.delivered.map((d) => d.payload.eventId).sort()).toEqual([
			"swap-pressure:one-episode:degraded",
			"swap-pressure:one-episode:resume",
		]);
	});
	it("two standalone sensor outages in one boot survive restart and permanent notifier dedup", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
		const fetchFn = okFetch();
		const notifier = new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn,
			queueDir,
			deadLetterDir,
			unifiedAlert,
		});
		const delivered: AlertPayload[] = [];
		let reading: {
			freePct: number;
			swapoutsTotal: number;
			pageSize: number;
		} | null = null;
		const options = {
			store,
			hostBootId: "same-boot",
			readPressure: async () => reading,
			monotonicNow: Date.now,
		};
		const attach = (sampler: ReturnType<typeof createPressureSampler>) =>
			sampler.attachAlertSink({
				alert: async (payload) => {
					const result = await notifier.alert(payload);
					if (result.sent) delivered.push(payload);
					return result;
				},
			});
		const first = createPressureSampler(options);
		attach(first);
		first.start();
		await vi.advanceTimersByTimeAsync(60_000);
		reading = { freePct: 12, swapoutsTotal: 100, pageSize: 16384 };
		await vi.advanceTimersByTimeAsync(90_000);
		expect(delivered.map((p) => p.metadata?.pressureSampler?.kind)).toEqual([
			"degraded",
			"resume",
		]);
		await first.stop();
		reading = null;
		const second = createPressureSampler(options);
		attach(second);
		second.start();
		await vi.advanceTimersByTimeAsync(90_000);
		const pendingEpisode = JSON.parse(
			store.getPressureSamplerState()!.cacheJson,
		).notifications.degradedEpisodeId;
		await second.stop();
		const resumed = createPressureSampler(options);
		attach(resumed);
		resumed.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(
			JSON.parse(store.getPressureSamplerState()!.cacheJson).notifications
				.degradedEpisodeId,
		).toBe(pendingEpisode);
		reading = { freePct: 12, swapoutsTotal: 100, pageSize: 16384 };
		await vi.advanceTimersByTimeAsync(90_000);
		await resumed.stop();
		expect(delivered.map((p) => p.metadata?.pressureSampler?.kind)).toEqual([
			"degraded",
			"resume",
			"degraded",
			"resume",
		]);
		expect(new Set(delivered.map((p) => p.eventId)).size).toBe(4);
		expect(delivered[0]!.episodeId).toBe(delivered[1]!.episodeId);
		expect(delivered[2]!.episodeId).toBe(delivered[3]!.episodeId);
	});
});
