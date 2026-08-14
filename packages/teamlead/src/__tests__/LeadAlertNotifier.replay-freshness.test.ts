import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetSensors } from "../bridge/fleet-sensors.js";
import type { MemoryPressure } from "../bridge/machine-watermark.js";
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

	it("real FleetSensors payloads retain episode identity: old A suppresses while live B delivers", async () => {
		process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS = "drop_stale";
		const seedFetch = vi.fn(async () => ({
			ok: false,
			status: 503,
			statusText: "down",
			text: async () => "down",
		}));
		const seed = new LeadAlertNotifier({
			store,
			projects: [],
			fetchFn: seedFetch,
			queueDir,
			deadLetterDir,
			unifiedAlert,
		});
		let now = 1_720_000_000_000;
		let reading: MemoryPressure | null = null;
		let hold:
			| { set_by: string; set_at: string; watermark: string | null }
			| undefined;
		const holdStore = {
			setFleetPressureHold(input: { setBy: string; watermark?: string }) {
				if (hold) return false;
				hold = {
					set_by: input.setBy,
					set_at: String(now),
					watermark: input.watermark ?? null,
				};
				return true;
			},
			getFleetPressureHold: () => hold,
			clearFleetPressureHold() {
				hold = undefined;
				return true;
			},
		};
		const sensors = new FleetSensors({
			store: holdStore as unknown as StateStore,
			alert: (record) => seed.alert(record),
			readPressure: async () => reading,
			env: {
				FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0",
				FLYWHEEL_FLEET_SENSOR_BOT: "0",
				FLYWHEEL_FLEET_SENSOR_ZOMBIE: "0",
			},
			now: () => now,
			logger: () => {},
		});
		const high: MemoryPressure = {
			freePct: 5,
			swapoutsTotal: 1000,
			pageSize: 16384,
		};
		const healthy: MemoryPressure = {
			freePct: 45,
			swapoutsTotal: 1000,
			pageSize: 16384,
		};

		reading = high;
		await sensors.tick();
		await sensors.tick(); // A queued
		reading = healthy;
		now += 10_000;
		await sensors.tick(); // A recovered
		await new Promise((resolve) => setTimeout(resolve, 5));
		reading = high;
		now += 10_000;
		await sensors.tick();
		await sensors.tick(); // B queued and still live

		const queued = readdirSync(queueDir).map((file) =>
			JSON.parse(readFileSync(join(queueDir, file), "utf8")),
		);
		expect(queued).toHaveLength(2);
		expect(queued.every((record) => typeof record.episodeId === "string")).toBe(
			true,
		);
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
		expect(result.sent).toBe(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result.delivered[0]?.payload.eventId).toBe(
			`swap-pressure:${String(now)}`,
		);
	});
});
