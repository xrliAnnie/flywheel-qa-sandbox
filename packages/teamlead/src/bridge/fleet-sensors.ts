import { createHash } from "node:crypto";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import type { RepairResult } from "./AutoRepairBot.js";
import type { PressureSnapshot } from "./machine-watermark.js";
import { pressureSnapshotDetail } from "./pressure-sampler.js";
import { formatZombieSamples, type ZombieFinding } from "./zombie-scan.js";

export interface InfraBotProbe {
	provider: "claude" | "codex";
	alive: boolean;
	/** launchd job label (kickstart target), e.g. gui/501/com.flywheel... */
	jobLabel: string;
	probeSource: string;
}

/** Narrow, synchronous input used while draining a delayed alert queue entry. */
export interface ReplayFreshnessInput {
	eventType: AlertPayload["eventType"];
	leadId: string;
	eventId: string;
	episodeId?: string;
}

export interface FleetSensorsDeps {
	store: StateStore;
	/** The routed alert sink (ticket enrichment + Hub threading included). */
	alert: (p: AlertPayload) => Promise<AlertResult>;
	/** Quiet-resolve an active ticket (hub.resolve); absent = reconcile-only. */
	resolveTicket?: (correlationKey: string) => Promise<void>;
	/** Injection seams (defaults are the real probes). */
	pressureSnapshot?: () => PressureSnapshot;
	probeBots?: () => Promise<InfraBotProbe[]>;
	scanZombies?: () => Promise<ZombieFinding[]>;
	kickstart?: (jobLabel: string) => Promise<{ ok: boolean; error?: string }>;
	/**
	 * Codex R2 HIGH: does the server-loss coordinator still hold UNMIGRATED
	 * casualties? Consulted by the tmux_server_lost recovery probe — a pending
	 * episode must never quietly resolve. Absent → probe stays conservative.
	 */
	serverLossPending?: () => boolean;
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
	}

	/** One reconcile tick. Every sensor independently try/caught. */
	async tick(): Promise<void> {
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

	// Pressure sampling is owned by the early independent sampler. These
	// consumers never probe, place a hold, or release an operator's hold.
	get lastWatermark(): string | null {
		const snapshot = this.deps.pressureSnapshot?.();
		return snapshot && snapshot.state !== "unknown" && snapshot.freePct !== null
			? `${snapshot.freePct.toFixed(1)}% free`
			: null;
	}

	async swapPressureRepair(payload: AlertPayload): Promise<RepairResult> {
		const eventId = payload.eventId ?? "";
		if (!/^(?:swap-pressure|swap-holdfail):\S/.test(eventId)) {
			return {
				outcome: "needs_human",
				action: "none",
				detail: "压力通知缺少可验证的事件标识；拒绝从历史通知修改准入。",
			};
		}
		const snapshot = this.deps.pressureSnapshot?.();
		return {
			outcome: "no_action",
			action: "none",
			detail: snapshot
				? `准入按当前压力快照自动判断；通知不设置暂停。${pressureSnapshotDetail(snapshot)}`
				: "压力采样尚不可用；不从历史告警重建暂停。",
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
				// Codex R2 (restart safety): the in-memory latch dies with the
				// Bridge — the durable ACTIVE ticket row is the episode's truth.
				// A still-dead bot after a restart re-latches instead of opening a
				// duplicate episode.
				const activeTicket = this.deps.store.getActiveAlertThread(
					fleetCorrelationKey(`infra-bot:${probe.provider}`, "infra_bot_down"),
				);
				if (activeTicket) {
					this.botDeadSince.set(probe.provider, this.now());
					continue;
				}
				const detectedAt = this.now();
				this.botDeadSince.set(probe.provider, detectedAt);
				await this.deps.alert({
					leadId: `infra-bot:${probe.provider}`,
					projectName: FLEET_ALERT_PROJECT,
					eventId: `infra-bot-down:${probe.provider}:${detectedAt}`,
					eventType: "infra_bot_down",
					title: `${probe.provider} infra bot 掉线`,
					body: `探测到 ${probe.provider} infra bot 不在岗（${probe.probeSource}）。自动动作：launchctl kickstart -k ${probe.jobLabel}；失败时按 T2 预算再试。按「谁都不救自己」由对侧 bot 认领。`,
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

	/** The AutoRepairBot's infra_bot_down attempt: idempotent job restart. */
	async infraBotKickstartRepair(payload: AlertPayload): Promise<RepairResult> {
		const meta = payload.metadata?.infraBotDown;
		// Codex R2 MEDIUM-3: the T2 reconcile retry reconstructs a MINIMAL
		// payload (no metadata) — the second contract-mandated attempt must not
		// die on a missing jobLabel. Fall back to the SAME env source the probe
		// used (provider from the fleet leadId "infra-bot:<provider>").
		let jobLabel = meta?.jobLabel;
		if (!jobLabel) {
			const provider =
				meta?.provider ??
				(payload.leadId.startsWith("infra-bot:")
					? (payload.leadId.slice("infra-bot:".length) as "claude" | "codex")
					: null);
			if (provider === "claude" || provider === "codex") {
				jobLabel =
					this.env[
						provider === "claude"
							? "FLYWHEEL_CLAUDE_INFRA_BOT_JOB"
							: "FLYWHEEL_CODEX_INFRA_BOT_JOB"
					]?.trim();
			}
		}
		if (!jobLabel) {
			return {
				outcome: "needs_human",
				action: "none",
				detail:
					"bot-down 工单缺少 launchd job label（metadata 与 env 都解析不到）— 拒绝盲目重启，需要人工确认哪个 job 死了。",
			};
		}
		const kick =
			this.deps.kickstart ?? (await import("./launchctl.js")).kickstartJob;
		const res = await kick(jobLabel);
		if (res.ok) {
			return {
				outcome: "attempted",
				action: "launchctl_kickstart",
				detail: `🔧 已对 ${jobLabel} 执行 launchd 原地重启（幂等可逆）。bot 探针恢复后自动标记 ✅。`,
			};
		}
		// Codex R1 MEDIUM-2: a FAILED job-restart is still an ATTEMPT — the
		// first failure must stay in the T2 retry loop (REPAIRING + attempt_count)
		// and get its second try on reconcile. The exhausted ticket remains visible
		// in the channel. Only the BLIND case
		// (no jobLabel, above) short-circuits to needs_human.
		return {
			outcome: "attempted",
			action: "launchctl_kickstart",
			detail: `⚠️ 对 ${jobLabel} 的 launchd 原地重启失败（${res.error ?? "unknown"}）。将按 T2 预算自动再试一次；预算耗尽后工单留在频道等值守处理。`,
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
		if (findings.length < min) return; // below threshold — nothing to report
		const signature = createHash("sha256")
			.update(
				findings
					.map((f) => `${f.shape}:${f.executionId}`)
					.sort()
					.join("|"),
			)
			.digest("hex")
			.slice(0, 16);
		// Codex R1 HIGH-5 + R2 restart safety: claims.db dedup is PERMANENT, so
		// a set-hash-only eventId would silently swallow the SAME backlog
		// re-appearing after its ticket resolved. Dedup is therefore DURABLE:
		// the active ticket's event_id embeds the batch signature — an
		// unchanged backlog with a still-ACTIVE ticket emits nothing (survives
		// Bridge restarts, no in-memory state); the eventId carries a timestamp
		// so any legitimate re-emission is a FRESH claims identity.
		const activeTicket = this.deps.store.getActiveAlertThread(
			fleetCorrelationKey("zombie", "zombie_session_backlog"),
		);
		if (activeTicket?.event_id.startsWith(`zombie-backlog:${signature}:`)) {
			return;
		}
		await this.deps.alert({
			leadId: "zombie",
			projectName: FLEET_ALERT_PROJECT,
			eventId: `zombie-backlog:${signature}:${this.now()}`,
			eventType: "zombie_session_backlog",
			title: `跨 Lead 僵尸 session 积压（${findings.length} 个）`,
			body: `CommDB↔StateStore 对账发现 ${findings.length} 个僵尸 session（阈值 ${min}）：\n${formatZombieSamples(findings)}\n\n设计上不自动收割（收割机制 = FLY-1066）——工单挂在频道等值守初审，需要人拍板是否人工清理。`,
			severity: "warning",
		});
	}

	// ── Hub reconcile recovery probe (all fleet kinds) ───────────────────────

	/**
	 * Synchronous delayed-replay verdict. true means this exact queued episode is
	 * proven over, false means it is proven live, and null means deliver because
	 * evidence is insufficient. It performs no probes or mutations.
	 */
	replayFreshness(input: ReplayFreshnessInput): boolean | null {
		switch (input.eventType) {
			case "swap_pressure_high": {
				if (!input.episodeId) return null;
				// Recovery/degraded notices are historical transitions. They must
				// survive queued replay even when current pressure has changed.
				if (
					input.eventId.endsWith(":resume") ||
					input.eventId.endsWith(":degraded") ||
					input.eventId.startsWith("swap-holdfail:")
				)
					return null;
				const snapshot = this.deps.pressureSnapshot?.();
				return snapshot?.state === "healthy" &&
					snapshot.reason !== "sensor_disabled"
					? true
					: snapshot?.state === "pressure"
						? false
						: null;
			}
			case "infra_bot_down": {
				const provider = input.leadId.replace(/^infra-bot:/, "");
				if (provider !== "claude" && provider !== "codex") return null;
				const alive = this.botLastAlive.get(provider);
				return alive === undefined ? null : alive;
			}
			case "bridge_abnormal_exit":
				// A crash is a point-in-time fact. The replacement Bridge completing
				// boot reconcile is a recovery condition for the ticket, but it does
				// not make the crash evidence stale for delayed delivery.
				return null;
			default:
				return null;
		}
	}

	/**
	 * The AlertChannelHub `fleetRecovery` dep: true = the fleet condition
	 * cleared (quiet resolve), false = still broken, null = cannot tell.
	 */
	async recoveryProbe(row: AlertThreadRow): Promise<boolean | null> {
		switch (row.event_type) {
			case "swap_pressure_high": {
				const snapshot = this.deps.pressureSnapshot?.();
				return snapshot?.state === "healthy" &&
					snapshot.reason !== "sensor_disabled"
					? true
					: snapshot?.state === "pressure"
						? false
						: null;
			}
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
			case "tmux_server_lost": {
				// Codex R2 HIGH: NEVER resolve while the coordinator still holds
				// unmigrated casualties — a pending episode reads as broken even if
				// the attempt path recorded "attempted" earlier. Only a fully-
				// migrated episode with the attempted evidence resolves quietly.
				if (this.deps.serverLossPending?.() === true) return false;
				return row.repair_status === "attempted" ? true : null;
			}
			default:
				return null;
		}
	}
}
