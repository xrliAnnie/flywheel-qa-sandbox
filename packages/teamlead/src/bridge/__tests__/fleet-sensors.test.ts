/**
 * FLY-1082 (Tasks 2.2/2.5/2.6): the fleet sensor pack — swap episode
 * lifecycle (trigger → hold → clear → resolve), idempotent repair, bot-down
 * latch + kickstart, throttled zombie scan with batch-signature dedup, and
 * the Hub recovery probe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import type { AlertThreadRow, StateStore } from "../../StateStore.js";
import { StateStore as RealStateStore } from "../../StateStore.js";
import {
	FleetSensors,
	fleetCorrelationKey,
	type InfraBotProbe,
} from "../fleet-sensors.js";
import type { SwapUsage } from "../machine-watermark.js";
import type { ZombieFinding } from "../zombie-scan.js";

const usage = (pct: number): SwapUsage => ({
	totalBytes: 100,
	usedBytes: pct,
	usedPct: pct,
});

function fleetRow(over: Partial<AlertThreadRow>): AlertThreadRow {
	return {
		correlation_key: "machine|swap|swap_pressure_high|",
		event_id: "e",
		episode_signature: null,
		thread_id: "t",
		root_message_id: null,
		channel_id: "c",
		lead_id: "swap",
		project_name: "machine",
		event_type: "swap_pressure_high",
		session_key: null,
		repair_status: null,
		opened_at: "2026-07-09 21:00:00",
		resolved_at: null,
		ticket_status: "NEW",
		owner_ref: "infra_bot:claude",
		attempt_count: 0,
		first_seen_at: "2026-07-09 21:00:00",
		acked_at: null,
		...over,
	} as AlertThreadRow;
}

describe("FleetSensors — swap (Task 2.2)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let resolved: string[];
	let notified: Array<{ leadId: string; content: string }>;
	let swapReading: SwapUsage | null;
	let now: number;

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		resolved = [];
		notified = [];
		swapReading = null;
		now = 1_720_000_000_000;
	});

	function makeSensors(env: Record<string, string> = {}) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async (ck) => {
				resolved.push(ck);
			},
			notifyLead: async (leadId, content) => {
				notified.push({ leadId, content });
				return true;
			},
			listLeadIds: () => ["tadashi", "honey-lemon", "peter"],
			readSwap: async () => swapReading,
			env: env as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
	}

	it("2 consecutive high ticks → ONE severe ticket; episode never re-fires", async () => {
		const sensors = makeSensors();
		swapReading = usage(85);
		await sensors.tick();
		expect(alerts).toHaveLength(0); // 1st high tick — confirmation pending
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("swap_pressure_high");
		expect(alerts[0]!.severity).toBe("severe");
		await sensors.tick(); // still high — same episode
		expect(alerts).toHaveLength(1);
	});

	it("clear (below LOW): lifts the sensor's own hold + quiet-resolves the ticket", async () => {
		const sensors = makeSensors();
		swapReading = usage(85);
		await sensors.tick();
		await sensors.tick(); // trigger
		await sensors.swapPressureRepair(alerts[0]!); // places the hold
		expect(store.getFleetPressureHold()?.set_by).toBe("swap-sensor");
		swapReading = usage(50);
		await sensors.tick(); // clear
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(resolved).toContain(
			fleetCorrelationKey("swap", "swap_pressure_high"),
		);
	});

	it("clear never lifts a hold someone ELSE placed", async () => {
		const sensors = makeSensors();
		store.setFleetPressureHold({ setBy: "annie-manual" });
		swapReading = usage(85);
		await sensors.tick();
		await sensors.tick();
		swapReading = usage(50);
		await sensors.tick();
		expect(store.getFleetPressureHold()?.set_by).toBe("annie-manual");
	});

	it("swapPressureRepair: places hold + broadcasts load-shed ONCE; repeat attempt is idempotent", async () => {
		const sensors = makeSensors();
		swapReading = usage(90);
		await sensors.tick();
		await sensors.tick();
		const first = await sensors.swapPressureRepair(alerts[0]!);
		expect(first.outcome).toBe("attempted");
		expect(store.getFleetPressureHold()).toBeDefined();
		expect(notified).toHaveLength(3); // one per Lead
		const second = await sensors.swapPressureRepair(alerts[0]!);
		expect(second.outcome).toBe("attempted");
		expect(second.detail).toContain("幂等");
		expect(notified).toHaveLength(3); // NOT re-broadcast
	});

	it("kill switch FLYWHEEL_FLEET_SENSOR_SWAP=0 disables the sensor", async () => {
		const sensors = makeSensors({ FLYWHEEL_FLEET_SENSOR_SWAP: "0" });
		swapReading = usage(95);
		await sensors.tick();
		await sensors.tick();
		expect(alerts).toHaveLength(0);
	});

	it("recoveryProbe: swap resolves iff the monitor left pressure", async () => {
		const sensors = makeSensors();
		swapReading = usage(85);
		await sensors.tick();
		await sensors.tick(); // in pressure
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(false);
		swapReading = usage(50);
		await sensors.tick(); // cleared
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(true);
	});

	it("Bridge restart with the watermark already fallen lifts the stranded durable hold (Codex R1 HIGH-1)", async () => {
		// Previous generation placed the hold, then the Bridge restarted — the
		// fresh monitor starts 'normal' and would never emit 'clear'.
		store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "90%" });
		const sensors = makeSensors(); // fresh monitor = post-restart state
		swapReading = usage(40); // below LOW
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeUndefined();
	});

	it("restart with the watermark STILL high keeps the hold (no premature lift)", async () => {
		store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "90%" });
		const sensors = makeSensors();
		swapReading = usage(85); // still above LOW/HIGH — first confirm tick
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
		swapReading = usage(70); // in the hysteresis band — still not below LOW
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
	});

	it("a MANUAL hold is never lifted by the restart-safety path", async () => {
		store.setFleetPressureHold({ setBy: "annie-manual" });
		const sensors = makeSensors();
		swapReading = usage(40);
		await sensors.tick();
		expect(store.getFleetPressureHold()?.set_by).toBe("annie-manual");
	});
});

describe("FleetSensors — infra bot (Task 2.5)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let resolved: string[];
	let probes: InfraBotProbe[];

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		resolved = [];
		probes = [];
	});

	function makeSensors(
		kick?: (label: string) => Promise<{ ok: boolean; error?: string }>,
	) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async (ck) => {
				resolved.push(ck);
			},
			readSwap: async () => null,
			probeBots: async () => probes,
			kickstart: kick ?? (async () => ({ ok: true })),
			env: {} as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
	}

	it("dead bot fires ONCE (episode latch) with the explicit dead-side metadata", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "com.flywheel.claw-infra",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		await sensors.tick(); // still dead — latched
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("infra_bot_down");
		expect(alerts[0]!.metadata?.infraBotDown).toMatchObject({
			provider: "claude",
			jobLabel: "com.flywheel.claw-infra",
		});
	});

	it("dead→alive edge clears the latch + quiet-resolves; a NEW death re-fires", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "codex",
				alive: false,
				jobLabel: "com.flywheel.codex-infra",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		probes = [{ ...probes[0]!, alive: true }];
		await sensors.tick();
		expect(resolved).toContain(
			fleetCorrelationKey("infra-bot:codex", "infra_bot_down"),
		);
		probes = [{ ...probes[0]!, alive: false }];
		await sensors.tick();
		expect(alerts).toHaveLength(2); // fresh episode
	});

	it("kickstart repair: attempted on success AND on failure (T2 gives the 2nd try — Codex R1 MED-2); blind → needs_human", async () => {
		const okSensors = makeSensors(async () => ({ ok: true }));
		const payload: AlertPayload = {
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventId: "e",
			eventType: "infra_bot_down",
			title: "t",
			body: "b",
			severity: "severe",
			metadata: {
				infraBotDown: { provider: "claude", jobLabel: "com.x.y" },
			},
		};
		expect((await okSensors.infraBotKickstartRepair(payload)).outcome).toBe(
			"attempted",
		);
		// A FAILED restart is still an attempt — stays in the T2 loop so the
		// contract's "2 次失败 → @Annie" gets its second try on reconcile.
		const failSensors = makeSensors(async () => ({
			ok: false,
			error: "nope",
		}));
		const failed = await failSensors.infraBotKickstartRepair(payload);
		expect(failed.outcome).toBe("attempted");
		expect(failed.detail).toContain("失败");
		const blind = await okSensors.infraBotKickstartRepair({
			...payload,
			metadata: {},
		});
		expect(blind.outcome).toBe("needs_human"); // refuses to restart blind
	});

	it("restart safety: a still-dead bot with an ACTIVE durable ticket re-latches instead of re-alerting (Codex R2)", async () => {
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "com.flywheel.claw-infra",
				probeSource: "launchctl print",
			},
		];
		const first = makeSensors();
		await first.tick();
		expect(alerts).toHaveLength(1);
		store.openAlertThread({
			correlationKey: "machine|infra-bot:claude|infra_bot_down|",
			eventId: alerts[0]!.eventId,
			threadId: "t-bot",
			channelId: "c",
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventType: "infra_bot_down",
			ticketStatus: "REPAIRING",
		});
		const postRestart = makeSensors(); // fresh in-memory latch
		await postRestart.tick();
		expect(alerts).toHaveLength(1); // no duplicate episode
	});

	it("T2 retry payload without metadata falls back to the env jobLabel (Codex R2 MED-3)", async () => {
		const kicked: string[] = [];
		const sensors = new FleetSensors({
			store,
			alert: async () => ({ sent: true }),
			readSwap: async () => null,
			kickstart: async (label) => {
				kicked.push(label);
				return { ok: true };
			},
			env: {
				FLYWHEEL_CLAUDE_INFRA_BOT_JOB: "com.flywheel.claw-infra",
			} as unknown as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
		// The Hub's reconcile retry reconstructs a MINIMAL payload — no metadata.
		const result = await sensors.infraBotKickstartRepair({
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventId: "e",
			eventType: "infra_bot_down",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(result.outcome).toBe("attempted");
		expect(kicked).toEqual(["com.flywheel.claw-infra"]);
	});

	it("recoveryProbe: bot resolves by the latest probe verdict (per provider)", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "j",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		const row = fleetRow({
			correlation_key: "machine|infra-bot:claude|infra_bot_down|",
			lead_id: "infra-bot:claude",
			event_type: "infra_bot_down",
		});
		expect(await sensors.recoveryProbe(row)).toBe(false);
		probes = [{ ...probes[0]!, alive: true }];
		await sensors.tick();
		expect(await sensors.recoveryProbe(row)).toBe(true);
	});
});

describe("FleetSensors — zombie scan (Task 2.6)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let findings: ZombieFinding[];
	let now: number;

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		findings = [];
		now = 1_720_000_000_000;
	});

	function makeSensors(env: Record<string, string> = {}) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			readSwap: async () => null,
			scanZombies: async () => findings,
			env: env as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
	}

	const zombie = (i: number): ZombieFinding => ({
		shape: "commdb_orphan",
		executionId: `z-${i}`,
		projectName: "flywheel",
		detail: "d",
	});

	it("below threshold (default 3) → no ticket; at threshold → (b)-type ticket with samples", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2)];
		await sensors.tick();
		expect(alerts).toHaveLength(0);
		findings = [zombie(1), zombie(2), zombie(3)];
		now += 16 * 60_000; // past the scan throttle
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("zombie_session_backlog");
		expect(alerts[0]!.body).toContain("z-1");
		expect(alerts[0]!.body).toContain("FLY-1066");
	});

	it("scan is throttled (~15 min): consecutive ticks do not rescan", async () => {
		const sensors = makeSensors();
		const scan = vi.fn(async () => [] as ZombieFinding[]);
		const throttled = new FleetSensors({
			store,
			alert: async () => ({ sent: true }),
			readSwap: async () => null,
			scanZombies: scan,
			env: {} as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
		await throttled.tick();
		await throttled.tick();
		expect(scan).toHaveBeenCalledTimes(1);
		void sensors;
	});

	it("same batch with an ACTIVE ticket never re-emits; a changed set emits fresh (Codex R1 HIGH-5)", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2), zombie(3)];
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		// Simulate the Hub opening the ticket row for the emitted alert.
		store.openAlertThread({
			correlationKey: "machine|zombie|zombie_session_backlog|",
			eventId: alerts[0]!.eventId,
			threadId: "t-z",
			channelId: "c",
			leadId: "zombie",
			projectName: "machine",
			eventType: "zombie_session_backlog",
			ticketStatus: "ESCALATED",
		});
		now += 16 * 60_000;
		await sensors.tick(); // same batch + active ticket → silent
		expect(alerts).toHaveLength(1);
		// Codex R2 (restart safety): the dedup rides the DURABLE ticket row —
		// a fresh post-restart sensor instance stays silent too.
		const postRestart = makeSensors();
		now += 16 * 60_000;
		await postRestart.tick();
		expect(alerts).toHaveLength(1);
		findings = [...findings, zombie(4)];
		now += 16 * 60_000;
		await sensors.tick(); // changed set → fresh event id
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).not.toBe(alerts[0]!.eventId);
	});

	it("same batch RE-EMITS with a fresh eventId once the ticket resolved (never claims-swallowed)", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2), zombie(3)];
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		// No active ticket row (e.g. resolved/archived) → the same backlog must
		// re-alert, and with a DIFFERENT eventId (permanent claims dedup).
		now += 16 * 60_000;
		await sensors.tick();
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).not.toBe(alerts[0]!.eventId);
	});

	it("sample list truncates at 10 with the total", async () => {
		const sensors = makeSensors();
		findings = Array.from({ length: 12 }, (_, i) => zombie(i));
		await sensors.tick();
		expect(alerts[0]!.body).toContain("共 12 个");
		expect(alerts[0]!.body).not.toContain("z-11");
	});
});
