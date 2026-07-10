/**
 * FLY-1082 (Tasks 2.2/2.5/2.6): the fleet sensor pack — piggybacked on the
 * LeadWatchdog `onPollComplete` tick (zero new timers, FLY-169 norm). Each
 * sensor is independently kill-switched (`FLYWHEEL_FLEET_SENSOR_<NAME>=0`) and
 * DEFAULT ON: a default-off fleet sensor would recreate the "enable window
 * that never comes" — the exact disease this issue treats.
 *
 * Sensors:
 *  - SWAP  (Task 2.2): watermark + hysteresis → `swap_pressure_high` ticket;
 *    ARC = reversible dispatch pressure-hold + per-Lead load-shed notify;
 *    watermark falls below LOW → hold lifted + quiet resolve.
 *  - BOT   (Task 2.5): infra-bot liveness (pane/launchctl probes, injected)
 *    → `infra_bot_down` ticket cross-owned by the OTHER side; ARC =
 *    `launchctl kickstart -k`.
 *  - ZOMBIE(Task 2.6): throttled (~15 min) CommDB↔StateStore reconcile scan
 *    → `zombie_session_backlog` (b)-type ticket with the sample list.
 *
 * The tmux server-loss coordinator is deliberately NOT here — it must run as
 * a HeartbeatService pre-reaper phase to beat orphan migration in the same
 * cycle (see server-loss.ts / plan Task 2.3).
 */

import { createHash } from "node:crypto";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import type { RepairResult } from "./AutoRepairBot.js";
import {
	readSwapUsage,
	SwapPressureMonitor,
	type SwapUsage,
	swapThresholdsFromEnv,
} from "./machine-watermark.js";
import { formatZombieSamples, type ZombieFinding } from "./zombie-scan.js";

export interface InfraBotProbe {
	provider: "claude" | "codex";
	alive: boolean;
	/** launchd job label (kickstart target), e.g. gui/501/com.flywheel... */
	jobLabel: string;
	probeSource: string;
}

export interface FleetSensorsDeps {
	store: StateStore;
	/** The routed alert sink (ticket enrichment + Hub threading included). */
	alert: (p: AlertPayload) => Promise<AlertResult>;
	/** Quiet-resolve an active ticket (hub.resolve); absent = reconcile-only. */
	resolveTicket?: (correlationKey: string) => Promise<void>;
	/** Bridge → Lead instruction (CommDB inbox). Returns delivered. */
	notifyLead?: (leadId: string, content: string) => Promise<boolean>;
	/** All configured Lead agent ids (the load-shed broadcast audience). */
	listLeadIds?: () => string[];
	/** Injection seams (defaults are the real probes). */
	readSwap?: () => Promise<SwapUsage | null>;
	probeBots?: () => Promise<InfraBotProbe[]>;
	scanZombies?: () => Promise<ZombieFinding[]>;
	kickstart?: (jobLabel: string) => Promise<{ ok: boolean; error?: string }>;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	logger?: (msg: string) => void;
}

const ZOMBIE_SCAN_INTERVAL_MS = 15 * 60_000;

function sensorOn(env: NodeJS.ProcessEnv, name: string): boolean {
	return env[`FLYWHEEL_FLEET_SENSOR_${name}`] !== "0";
}

export function fleetCorrelationKey(leadId: string, eventType: string): string {
	return `${FLEET_ALERT_PROJECT}|${leadId}|${eventType}|`;
}

export class FleetSensors {
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly log: (msg: string) => void;
	private readonly swapMonitor: SwapPressureMonitor;
	/** Per-provider dead latch: emit once per death episode. */
	private readonly botDeadSince = new Map<"claude" | "codex", number>();
	/** Last probe verdicts — the Hub recovery probe reads these. */
	private readonly botLastAlive = new Map<"claude" | "codex", boolean>();
	private lastZombieScanAt = 0;
	/**
	 * FLY-1082 (Task 2.4): flipped true once Bridge startup wiring completed —
	 * the boot self-check ticket's recovery condition ("boot 对账完成").
	 */
	bootReconcileDone = false;

	constructor(private readonly deps: FleetSensorsDeps) {
		this.env = deps.env ?? process.env;
		this.now = deps.now ?? (() => Date.now());
		this.log = deps.logger ?? ((m) => console.log(`[fleet-sensors] ${m}`));
		this.swapMonitor = new SwapPressureMonitor(swapThresholdsFromEnv(this.env));
	}

	/** One watchdog tick. Every sensor independently try/caught. */
	async tick(): Promise<void> {
		try {
			await this.swapTick();
		} catch (err) {
			this.log(`swap tick failed: ${(err as Error).message}`);
		}
		try {
			await this.botTick();
		} catch (err) {
			this.log(`bot tick failed: ${(err as Error).message}`);
		}
		try {
			await this.zombieTick();
		} catch (err) {
			this.log(`zombie tick failed: ${(err as Error).message}`);
		}
	}

	// ── SWAP (Task 2.2) ──────────────────────────────────────────────────────

	private lastSwapUsage: SwapUsage | null = null;

	/** Latest watermark summary (server-loss notifications ride it). */
	get lastWatermark(): string | null {
		return this.lastSwapUsage?.usedPct != null
			? `${this.lastSwapUsage.usedPct.toFixed(1)}%`
			: null;
	}

	private async swapTick(): Promise<void> {
		if (!sensorOn(this.env, "SWAP")) return;
		const usage = await (
			this.deps.readSwap ?? (() => readSwapUsage(this.env))
		)();
		this.lastSwapUsage = usage;
		const event = this.swapMonitor.tick(usage, this.now());
		if (event === "trigger") {
			const pct = usage?.usedPct?.toFixed(1) ?? "?";
			const th = swapThresholdsFromEnv(this.env);
			await this.deps.alert({
				leadId: "swap",
				projectName: FLEET_ALERT_PROJECT,
				eventId: `swap-pressure:${this.swapMonitor.episodeStart}`,
				eventType: "swap_pressure_high",
				title: "swap 水位越过高阈（OOM 预警）",
				body: `swap 已用 ${pct}%（阈值 ${th.highPct}%，连续 2 tick 确认）。自动动作：置 pressure-hold 暂停派新 runner + 通知各 Lead 降载；水位回落到 ${th.lowPct}% 以下自动解除并安静 resolve。`,
				severity: "severe",
			});
		} else if (event === "clear") {
			const hold = this.deps.store.getFleetPressureHold();
			if (hold?.set_by === "swap-sensor") {
				this.deps.store.clearFleetPressureHold();
				this.log("watermark fell below LOW — pressure-hold lifted");
			}
			await this.deps.resolveTicket?.(
				fleetCorrelationKey("swap", "swap_pressure_high"),
			);
		}
	}

	/**
	 * The AutoRepairBot's swap_pressure_high attempt (wired via
	 * deps.fleetRepair.swapPressure): place the hold (idempotent — a repeat
	 * ticket never re-places or re-broadcasts) + notify every Lead to shed
	 * load. Fully reversible: the sensor lifts the hold on watermark fall.
	 */
	async swapPressureRepair(_payload: AlertPayload): Promise<RepairResult> {
		const watermark = this.lastSwapUsage?.usedPct
			? `${this.lastSwapUsage.usedPct.toFixed(1)}%`
			: "unknown";
		const placed = this.deps.store.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark,
		});
		if (!placed) {
			return {
				outcome: "attempted",
				action: "pressure_hold",
				detail: `🔧 pressure-hold 已在生效中（幂等，不重复置位/广播）。当前 swap ${watermark}。`,
			};
		}
		const leadIds = this.deps.listLeadIds?.() ?? [];
		let notified = 0;
		for (const leadId of leadIds) {
			try {
				const ok = await this.deps.notifyLead?.(
					leadId,
					`[fleet-alert] swap 水位 ${watermark} 越过高阈（OOM 预警）。新 runner 派发已暂停（pressure-hold）。请降载：暂缓新任务、考虑收掉可暂停的 runner。水位回落后 hold 自动解除。`,
				);
				if (ok) notified++;
			} catch {
				// per-Lead best-effort; the hold itself is the load-bearing action
			}
		}
		return {
			outcome: "attempted",
			action: "pressure_hold",
			detail: `🔧 已置 pressure-hold（暂停派新 runner，水位回落自动解除）+ 通知 ${notified}/${leadIds.length} 个 Lead 降载。当前 swap ${watermark}。`,
		};
	}

	// ── BOT (Task 2.5) ───────────────────────────────────────────────────────

	private async botTick(): Promise<void> {
		if (!sensorOn(this.env, "BOT")) return;
		if (!this.deps.probeBots) return;
		const probes = await this.deps.probeBots();
		for (const probe of probes) {
			this.botLastAlive.set(probe.provider, probe.alive);
			if (!probe.alive) {
				if (this.botDeadSince.has(probe.provider)) continue; // latched episode
				const detectedAt = this.now();
				this.botDeadSince.set(probe.provider, detectedAt);
				await this.deps.alert({
					leadId: `infra-bot:${probe.provider}`,
					projectName: FLEET_ALERT_PROJECT,
					eventId: `infra-bot-down:${probe.provider}:${detectedAt}`,
					eventType: "infra_bot_down",
					title: `${probe.provider} infra bot 掉线`,
					body: `探测到 ${probe.provider} infra bot 不在岗（${probe.probeSource}）。自动动作：launchctl kickstart -k ${probe.jobLabel}；两次失败升级 Annie。按「谁都不救自己」由对侧 bot 认领。`,
					severity: "severe",
					metadata: {
						infraBotDown: {
							provider: probe.provider,
							jobLabel: probe.jobLabel,
							probeSource: probe.probeSource,
						},
					},
				});
			} else if (this.botDeadSince.has(probe.provider)) {
				// dead → alive edge: clear the latch; quiet resolve.
				this.botDeadSince.delete(probe.provider);
				await this.deps.resolveTicket?.(
					fleetCorrelationKey(`infra-bot:${probe.provider}`, "infra_bot_down"),
				);
			}
		}
	}

	/** The AutoRepairBot's infra_bot_down attempt: idempotent kickstart. */
	async infraBotKickstartRepair(payload: AlertPayload): Promise<RepairResult> {
		const meta = payload.metadata?.infraBotDown;
		if (!meta?.jobLabel) {
			return {
				outcome: "needs_human",
				action: "none",
				detail:
					"bot-down 工单缺少 launchd job label — 拒绝盲目 kickstart，需要人工确认哪个 job 死了。",
			};
		}
		const kick =
			this.deps.kickstart ?? (await import("./launchctl.js")).kickstartJob;
		const res = await kick(meta.jobLabel);
		if (res.ok) {
			return {
				outcome: "attempted",
				action: "launchctl_kickstart",
				detail: `🔧 已 launchctl kickstart -k ${meta.jobLabel}（幂等可逆）。bot 探针恢复后自动标记 ✅。`,
			};
		}
		return {
			outcome: "needs_human",
			action: "none",
			detail: `launchctl kickstart ${meta.jobLabel} 失败（${res.error ?? "unknown"}）— 需要你看一眼 launchd job。`,
		};
	}

	// ── ZOMBIE (Task 2.6) ────────────────────────────────────────────────────

	private async zombieTick(): Promise<void> {
		if (!sensorOn(this.env, "ZOMBIE")) return;
		if (!this.deps.scanZombies) return;
		const now = this.now();
		if (now - this.lastZombieScanAt < ZOMBIE_SCAN_INTERVAL_MS) return;
		this.lastZombieScanAt = now;
		const findings = await this.deps.scanZombies();
		const rawMin = Number(this.env.FLYWHEEL_ZOMBIE_BACKLOG_MIN);
		const min = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 3;
		if (findings.length < min) return;
		// Batch signature: the SAME backlog never re-opens a ticket (claims +
		// lead_events dedup on the eventId); a changed set is a new event.
		const signature = createHash("sha256")
			.update(
				findings
					.map((f) => `${f.shape}:${f.executionId}`)
					.sort()
					.join("|"),
			)
			.digest("hex")
			.slice(0, 16);
		await this.deps.alert({
			leadId: "zombie",
			projectName: FLEET_ALERT_PROJECT,
			eventId: `zombie-backlog:${signature}`,
			eventType: "zombie_session_backlog",
			title: `跨 Lead 僵尸 session 积压（${findings.length} 个）`,
			body: `CommDB↔StateStore 对账发现 ${findings.length} 个僵尸 session（阈值 ${min}）：\n${formatZombieSamples(findings)}\n\n设计上不自动收割（收割机制 = FLY-1066）——直接升级请你拍板是否人工清理。`,
			severity: "warning",
		});
	}

	// ── Hub reconcile recovery probe (all fleet kinds) ───────────────────────

	/**
	 * The AlertChannelHub `fleetRecovery` dep: true = the fleet condition
	 * cleared (quiet resolve), false = still broken, null = cannot tell.
	 */
	async recoveryProbe(row: AlertThreadRow): Promise<boolean | null> {
		switch (row.event_type) {
			case "swap_pressure_high":
				// Restart-safe: after a Bridge restart the monitor starts "normal",
				// so a stale ticket resolves; a genuinely-still-high watermark
				// re-triggers a fresh episode within 2 ticks.
				return !this.swapMonitor.inPressure;
			case "infra_bot_down": {
				const provider = row.lead_id.replace(/^infra-bot:/, "") as
					| "claude"
					| "codex";
				const alive = this.botLastAlive.get(provider);
				return alive === undefined ? null : alive;
			}
			case "bridge_abnormal_exit":
				// The revived Bridge opened this ticket; boot reconcile completion
				// is the recovery condition (plugin flips the flag post-wiring).
				return this.bootReconcileDone ? true : null;
			case "tmux_server_lost":
				// The coordinator resolves/escalates through its metadata evidence
				// (attempted iff all Leads notified) — recovery here = the ARC
				// completed, recorded on the row by the attempt path.
				return row.repair_status === "attempted" ? true : null;
			default:
				return null;
		}
	}
}
