/**
 * FLY-1082 (Tasks 2.2/2.5/2.6) + FLY-1142: the fleet sensor pack — memory
 * pressure episode lifecycle (trigger → hold → clear → resolve) on REAL
 * pressure signals (free% / swapout-delta, three-state health), idempotent
 * repair, bot-down latch + kickstart, throttled zombie scan with
 * batch-signature dedup, and the Hub recovery probe.
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
import { policyForKind } from "../ticket-escalation.js";
import type { ZombieFinding } from "../zombie-scan.js";

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

describe("FleetSensors — pressure snapshot consumers", () => {
	it("never probes or writes holds during a Lead pass; repair and recovery are read-only", async () => {
		const store = {
			setFleetPressureHold: vi.fn(),
			clearFleetPressureHold: vi.fn(),
		} as unknown as StateStore;
		let state: "unknown" | "healthy" | "pressure" = "unknown";
		const sensors = new FleetSensors({
			store,
			alert: vi.fn(),
			pressureSnapshot: () => ({
				state,
				source: "vm_stat",
				sampledAtMs: 1000,
				baselineAtMs: 0,
				freePct: 12,
				swapoutDeltaPages: 0,
				reason: state,
				evidenceValidUntilMs: 91_000,
			}),
			env: {
				FLYWHEEL_FLEET_SENSOR_BOT: "0",
				FLYWHEEL_FLEET_SENSOR_ZOMBIE: "0",
			},
		});
		await sensors.tick();
		expect(await sensors.recoveryProbe(fleetRow({}))).toBeNull();
		state = "pressure";
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(false);
		state = "healthy";
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(true);
		expect(
			await sensors.swapPressureRepair({
				eventId: "swap-pressure:old",
				eventType: "swap_pressure_high",
			} as AlertPayload),
		).toMatchObject({ outcome: "no_action", action: "none" });
		expect(store.setFleetPressureHold).not.toHaveBeenCalled();
		expect(store.clearFleetPressureHold).not.toHaveBeenCalled();
		expect(sensors.lastWatermark).toBe("12.0% free");
	});
	it("queued recovery/degraded history is retained while stale pause uses current fresh evidence", () => {
		const sensors = new FleetSensors({
			store: {} as StateStore,
			alert: vi.fn(),
			pressureSnapshot: () => ({
				state: "healthy",
				source: "vm_stat",
				sampledAtMs: 1000,
				baselineAtMs: 0,
				freePct: 12,
				swapoutDeltaPages: 0,
				reason: "non_danger",
				evidenceValidUntilMs: 91_000,
			}),
		});
		const input = {
			eventType: "swap_pressure_high" as const,
			leadId: "swap",
			episodeId: "old",
			eventId: "swap-pressure:old:pause",
		};
		expect(sensors.replayFreshness(input)).toBe(true);
		expect(
			sensors.replayFreshness({
				...input,
				eventId: "swap-pressure:old:resume",
			}),
		).toBeNull();
		expect(
			sensors.replayFreshness({
				...input,
				eventId: "swap-pressure:old:degraded",
			}),
		).toBeNull();
	});
	it("malformed repair identities request review without any mutation", async () => {
		const store = {
			setFleetPressureHold: vi.fn(),
			clearFleetPressureHold: vi.fn(),
		} as unknown as StateStore;
		const sensors = new FleetSensors({ store, alert: vi.fn() });
		for (const eventId of [
			"",
			"garbage",
			"swap-pressure:",
			"swap-holdfail:   ",
		]) {
			expect(
				await sensors.swapPressureRepair({ eventId } as AlertPayload),
			).toMatchObject({ outcome: "needs_human", action: "none" });
		}
		expect(store.setFleetPressureHold).not.toHaveBeenCalled();
		expect(store.clearFleetPressureHold).not.toHaveBeenCalled();
	});
	it("retains single-shot swap remediation policy", () => {
		expect(policyForKind("swap_pressure_high", {}).retryOnReconcile).toBe(
			false,
		);
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
		expect(
			sensors.replayFreshness({
				eventType: "infra_bot_down",
				leadId: "infra-bot:claude",
				eventId: "infra-bot-down:claude",
			}),
		).toBeNull();
		await sensors.tick();
		await sensors.tick(); // still dead — latched
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("infra_bot_down");
		expect(alerts[0]!.metadata?.infraBotDown).toMatchObject({
			provider: "claude",
			jobLabel: "com.flywheel.claw-infra",
		});
		expect(alerts[0]!.body).not.toContain("升级");
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
		// A FAILED restart is still an attempt, so the bounded two-attempt
		// contract gets its second try on reconcile.
		const failSensors = makeSensors(async () => ({
			ok: false,
			error: "nope",
		}));
		const failed = await failSensors.infraBotKickstartRepair(payload);
		expect(failed.outcome).toBe("attempted");
		expect(failed.detail).toContain("失败");
		expect(failed.detail).not.toContain("升级");
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
		expect(
			sensors.replayFreshness({
				eventType: "infra_bot_down",
				leadId: "infra-bot:claude",
				eventId: "infra-bot-down:claude",
			}),
		).toBe(false);
		probes = [{ ...probes[0]!, alive: true }];
		await sensors.tick();
		expect(await sensors.recoveryProbe(row)).toBe(true);
		expect(
			sensors.replayFreshness({
				eventType: "infra_bot_down",
				leadId: "infra-bot:claude",
				eventId: "infra-bot-down:claude",
			}),
		).toBe(true);
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
		expect(alerts[0]!.body).toContain("工单挂在频道等值守初审");
		expect(alerts[0]!.body).not.toContain("直接升级");
	});

	it("scan is throttled (~15 min): consecutive ticks do not rescan", async () => {
		const sensors = makeSensors();
		const scan = vi.fn(async () => [] as ZombieFinding[]);
		const throttled = new FleetSensors({
			store,
			alert: async () => ({ sent: true }),
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
