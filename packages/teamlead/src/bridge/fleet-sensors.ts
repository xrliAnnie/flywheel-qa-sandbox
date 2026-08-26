/**
 * FLY-1082 (Tasks 2.2/2.5/2.6): the fleet sensor pack — piggybacked on the
 * GatePoller lead-reconcile tick (zero new timers, FLY-169 norm). Each
 * sensor is independently kill-switched (`FLYWHEEL_FLEET_SENSOR_<NAME>=0`) and
 * DEFAULT ON: a default-off fleet sensor would recreate the "enable window
 * that never comes" — the exact disease this issue treats.
 *
 * Sensors:
 *  - SWAP  (Task 2.2): watermark + hysteresis → `swap_pressure_high` ticket;
 *    ARC = reversible dispatch pressure-hold; the owner-routed alert ticket is
 *    the sole human notification path.
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
	type MemoryEvaluation,
	type MemoryPressure,
	MemoryPressureMonitor,
	memPressureThresholdsFromEnv,
	readMemoryPressure,
} from "./machine-watermark.js";
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
	readPressure?: () => Promise<MemoryPressure | null>;
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

/**
 * FLY-1193: page debounce seconds. An explicit finite non-negative number is
 * taken verbatim (explicit "0" = disable the page DELAY only — the trigger tick
 * pages immediately; the hold-at-trigger and per-episode page latch semantics
 * are NOT rolled back). Unset / empty / whitespace /
 * negative / NaN / Infinity / non-numeric → default 120. A dedicated validator:
 * the `Number("") === 0` trap must be explicitly excluded.
 */
export function pageDebounceSecFromEnv(env: NodeJS.ProcessEnv): number {
	const raw = env.FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC?.trim();
	if (!raw) return 120;
	const v = Number(raw);
	return Number.isFinite(v) && v >= 0 ? v : 120;
}

/** Who owns the live pressure-hold this tick (drives copy + episode identity). */
type HoldState =
	| "placed_by_sensor"
	| "existing_sensor"
	| "existing_manual"
	| "unconfirmed";
interface HoldSnapshot {
	state: HoldState;
	/** The durable `fleet_pressure_hold.set_at` — null when unconfirmed. */
	setAt: string | null;
}

/**
 * FLY-1193: has this alert result landed in a DURABLE handler (so the in-memory
 * optimization latch may safely be set)? A `throw` never reaches here → the next
 * tick retries. `skipped:"duplicate"` counts: the cross-restart dedup layer
 * (claims / lead_events) already owns that identity.
 */
function isDurablyHandled(r: AlertResult): boolean {
	return !!(r.sent || r.queued || r.deadLettered || r.skipped === "duplicate");
}

export class FleetSensors {
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly log: (msg: string) => void;
	private readonly memMonitor: MemoryPressureMonitor;
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
		this.memMonitor = new MemoryPressureMonitor(
			memPressureThresholdsFromEnv(this.env),
		);
	}

	/** One reconcile tick. Every sensor independently try/caught. */
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

	// ── SWAP (Task 2.2 / FLY-1142: real memory pressure) ────────────────────

	private lastPressure: MemoryPressure | null = null;

	/**
	 * Single-process page / fail-loud optimization latches
	 * — they stop the SAME process from re-firing every tick. They are NOT the
	 * cross-restart correctness source (§1 contract): the deterministic
	 * eventId makes "a repeat call while a caller exists" idempotent;
	 * cross-restart root-page dedup rides the existing alert dedup layer (claims /
	 * lead_events) inside its window (worst case one re-open). On restart the
	 * latches reset to null;
	 * no durable re-hydration. Stored as episodeId (not bool) so "a new episode
	 * after a clear" is handled for free — a new id ≠ the old value → re-pageable.
	 * R3-1: a latch is set ONLY after its side-effect landed durable (see
	 * maybePage); a throw before that → next-tick retry.
	 */
	private episodePagedFor: string | null = null;
	private holdFailurePagedFor: string | null = null;

	/** Latest watermark summary (server-loss notifications ride it). */
	get lastWatermark(): string | null {
		return this.lastPressure != null
			? `${this.lastPressure.freePct.toFixed(1)}% free`
			: null;
	}

	private async swapTick(): Promise<void> {
		if (!sensorOn(this.env, "SWAP")) return;
		const reading = await (
			this.deps.readPressure ?? (() => readMemoryPressure(this.env))
		)();
		this.lastPressure = reading;
		const now = this.now();
		const ev = this.memMonitor.tick(reading, now);
		const debounceSec = pageDebounceSecFromEnv(this.env);

		// FLY-1193: the pressure-hold (machine-facing protection) is DECOUPLED
		// from the page (human-facing alert). On the very tick the episode is
		// confirmed — and every in-pressure tick after — place/confirm the hold
		// SILENTLY (earlier than the old alert→AutoRepairBot round-trip). The page
		// is debounced separately (see maybePage).
		let hold: HoldSnapshot | null = null;
		if (ev.event === "trigger" || this.memMonitor.inPressure) {
			hold = this.ensureSensorHold();
		}
		if (ev.event === "clear") {
			this.liftSensorHold();
			// Unconditional resolve: an un-paged episode makes hub.resolve a safe
			// no-op (AlertChannelHub `if (!active) return`); it also sweeps up any
			// ACTIVE ticket left over across a deploy / restart.
			await this.deps.resolveTicket?.(
				fleetCorrelationKey("swap", "swap_pressure_high"),
			);
		} else if (!this.memMonitor.inPressure && ev.healthy === true) {
			// Codex R1 HIGH-1 (restart safety) + FLY-1142 three-state re-judge:
			// the hold row is DURABLE but the monitor state is not — after a
			// Bridge restart the fresh monitor sits in "normal" and never emits
			// "clear", stranding the hold (the 2026-07-10 8-hour dispatch
			// blackout). Lift the sensor's own stale hold ONLY when the live
			// reading PROVES health (free% ≥ HIGH and swapout-delta ≤ MIN with a
			// computable delta). The first post-restart sample has no Swapouts
			// baseline (healthy=null) and never lifts — a restart mid-thrash
			// cannot fail-open on one flattering free% sample. Probe failures
			// (null) never lift either. FLY-1142 restart-safety kept verbatim.
			this.liftSensorHold();
		}

		if (this.memMonitor.inPressure && hold) {
			await this.maybePage(now, debounceSec, ev, hold);
		}
	}

	/**
	 * FLY-1193: place/confirm the sensor hold, never letting any exception escape
	 * (the swapTick outer catch would swallow the whole tick, page included).
	 * Returns the {state, setAt} snapshot from THIS confirmed read — owner /
	 * copy / episode identity all come from one read, so maybePage never issues a
	 * second `getFleetPressureHold`. Cannot confirm any live hold → "unconfirmed"
	 * → maybePage pages fail-loud.
	 */
	private ensureSensorHold(): HoldSnapshot {
		const classify = (
			hold: { set_by: string; set_at: string } | undefined,
			placed: boolean,
		): HoldSnapshot => {
			if (!hold) return { state: "unconfirmed", setAt: null };
			if (hold.set_by === "swap-sensor")
				return {
					state: placed ? "placed_by_sensor" : "existing_sensor",
					setAt: hold.set_at,
				};
			// R3-3: the catch branch reaches here too — classify by owner, so a
			// still-live sensor hold is never mislabelled a manual one.
			return { state: "existing_manual", setAt: hold.set_at };
		};
		try {
			const placed = this.deps.store.setFleetPressureHold({
				setBy: "swap-sensor",
				watermark: this.lastWatermark ?? "unknown",
			});
			const snap = classify(this.deps.store.getFleetPressureHold(), placed);
			if (snap.state === "placed_by_sensor")
				this.log("pressure-hold placed on trigger (silent)");
			return snap;
		} catch (err) {
			let snap: HoldSnapshot;
			try {
				snap = classify(this.deps.store.getFleetPressureHold(), false);
			} catch {
				snap = { state: "unconfirmed", setAt: null };
			}
			this.log(
				`pressure-hold placement FAILED (${(err as Error).message}) — holdState=${snap.state}`,
			);
			return snap;
		}
	}

	/** Lift the hold IFF the swap sensor placed it (never a manual hold). */
	private liftSensorHold(): void {
		const hold = this.deps.store.getFleetPressureHold();
		if (hold?.set_by === "swap-sensor") {
			this.deps.store.clearFleetPressureHold();
			this.log("memory pressure proven healthy — pressure-hold lifted");
		}
	}

	/**
	 * FLY-1193: the debounce gate. The episode has been confirmed (hold placed);
	 * page the owner-routed alert only once it has PERSISTED ≥ N seconds
	 * (N=0 → the trigger tick qualifies). A spike that self-heals in < N never
	 * reaches here with a due elapsed → zero page (the whole
	 * point of this issue). Episode identity is owner-tiered (R3-2): a
	 * sensor-owned hold anchors the DURABLE `set_at` (identity stable across
	 * restarts, dedup complete inside the alert layer's window); a manual /
	 * unconfirmed hold anchors the in-memory episodeStart (each physical episode
	 * gets a fresh id from the monitor's new trigger → a later episode is never
	 * permanently silenced; cross-restart dedup is best-effort, §1).
	 */
	private async maybePage(
		now: number,
		debounceSec: number,
		ev: MemoryEvaluation,
		hold: HoldSnapshot,
	): Promise<void> {
		const start = this.memMonitor.episodeStart;
		if (start == null) return;
		const elapsedMs = now - start;
		const sensorOwned =
			hold.state === "placed_by_sensor" || hold.state === "existing_sensor";
		const episodeId = sensorOwned && hold.setAt ? hold.setAt : String(start);

		// ── hold-failure fail-loud: independent eventId, never masked by a normal
		//    page's claims (R2-2). Pages even inside the debounce window — a
		//    protection that never engaged must not be silenced. ──
		if (hold.state === "unconfirmed") {
			if (this.holdFailurePagedFor === episodeId) return; // no in-process re-spam
			const r = await this.deps.alert(
				this.buildAlert({
					kind: "hold_failure",
					episodeId,
					elapsedMs,
					ev,
					hold,
				}),
			);
			if (isDurablyHandled(r)) this.holdFailurePagedFor = episodeId;
			return;
		}

		if (elapsedMs < debounceSec * 1000) return; // still within debounce

		// ── normal page: episode persisted ≥ N seconds ──
		if (this.episodePagedFor !== episodeId) {
			const r = await this.deps.alert(
				this.buildAlert({ kind: "sustained", episodeId, elapsedMs, ev, hold }),
			);
			if (isDurablyHandled(r)) this.episodePagedFor = episodeId;
		}
	}

	/**
	 * The AutoRepairBot's swap_pressure_high attempt (wired via
	 * deps.fleetRepair.swapPressure). The sensor already places the hold at trigger;
	 * this callback is the belt-and-suspenders "repair action" narrative. It
	 * consumes the payload's ORIGINAL episode identity and is
	 * prefix-aware (R5-4) + episode-precise (R4-2): it NEVER rebuilds identity or
	 * unconditionally re-places the hold — a queued alert drained after the sensor
	 * cleared would otherwise re-pause dispatch on a healthy machine.
	 */
	async swapPressureRepair(payload: AlertPayload): Promise<RepairResult> {
		const eventId = payload.eventId ?? "";
		try {
			// hold-failure retry: only while the monitor is STILL in that exact
			// episode and the hold is STILL unconfirmed.
			if (eventId.startsWith("swap-holdfail:")) {
				const anchor = eventId.slice("swap-holdfail:".length);
				// R6-2: an empty/whitespace anchor is a malformed identity we cannot
				// prove safe — fail-closed to needs_human, never a silent no-op.
				if (!anchor.trim()) {
					return {
						outcome: "needs_human",
						action: "none",
						detail: `swap 压力工单的 hold-failure eventId 缺少 episode 锚（${eventId}）— 无法确认目标 episode，需要人工核对。`,
					};
				}
				if (
					this.memMonitor.inPressure &&
					String(this.memMonitor.episodeStart) === anchor
				) {
					const snap = this.ensureSensorHold();
					return snap.state === "unconfirmed"
						? {
								outcome: "attempted",
								action: "pressure_hold",
								detail:
									"⚠️ pressure-hold 置位仍失败（StateStore 未恢复）— 派发未暂停，按 T2 预算再试；预算耗尽后工单留在频道等值守处理。",
							}
						: {
								outcome: "attempted",
								action: "pressure_hold",
								detail: `🔧 pressure-hold 现已置位（${this.lastWatermark ?? "unknown"}）。新 runner 派发已暂停，真实压力解除后自动解除。`,
							};
				}
				return {
					outcome: "no_action",
					action: "none",
					detail:
						"该 hold-failure episode 已过去（压力已解除或已切换）— 无需再动作，继续监测。",
				};
			}

			// unknown / malformed prefix → fail-closed, the ONLY contract (R6-2):
			// an unrecognized identity is an internal contract violation we cannot
			// prove safe → return needs_human, never a silent no-op.
			if (!eventId.startsWith("swap-pressure:")) {
				return {
					outcome: "needs_human",
					action: "none",
					detail: `swap 压力工单的 eventId 前缀无法识别（${eventId || "空"}）— 拒绝盲目动作，需要人工核对。`,
				};
			}

			const payloadEpisodeId = eventId.slice("swap-pressure:".length);
			// R6-2: an empty/whitespace episode id is a malformed identity — a
			// non-empty holdSetAt/episodeStart could never match it anyway, so a
			// silent "already recovered" no-op would hide a contract violation.
			if (!payloadEpisodeId.trim()) {
				return {
					outcome: "needs_human",
					action: "none",
					detail: `swap 压力工单的 eventId 缺少 episode 标识（${eventId}）— 拒绝盲目动作，需要人工核对。`,
				};
			}
			const currentHold = this.deps.store.getFleetPressureHold();
			const sensorHoldMatches =
				currentHold?.set_by === "swap-sensor" &&
				currentHold.set_at === payloadEpisodeId;
			const monitorMatches =
				this.memMonitor.inPressure &&
				String(this.memMonitor.episodeStart) === payloadEpisodeId;

			if (sensorHoldMatches) {
				this.ensureSensorHold(); // idempotent re-confirm
				return {
					outcome: "attempted",
					action: "pressure_hold",
					detail: `🔧 pressure-hold 已在生效（sensor 于压力确认时置位，${this.lastWatermark ?? "unknown"}）。新 runner 派发已暂停，继续监测真实压力。`,
				};
			}
			if (monitorMatches) {
				if (!currentHold) {
					return {
						outcome: "needs_human",
						action: "none",
						detail:
							"该内存压力 episode 仍在持续，但当前没有 pressure-hold，派发尚未暂停，需要人工立即核对。",
					};
				}
				return {
					outcome: "no_action",
					action: "none",
					detail:
						"该内存压力 episode 仍在持续，但已有 pressure-hold 生效；不重复动作，继续监测。",
				};
			}
			return {
				outcome: "no_action",
				action: "none",
				detail:
					"该 pressure episode 已恢复或已切换到新 episode — 无需动作，不重新暂停派发。",
			};
		} catch (err) {
			return {
				outcome: "needs_human",
				action: "none",
				detail: `swap 压力修复遇到异常（${(err as Error).message}）— 需要人工核对内存状态与 pressure-hold。`,
			};
		}
	}

	/**
	 * The alert copy's shared hold clause. A manual hold must NOT claim
	 * "sensor 已置、恢复后自动解除"
	 * (liftSensorHold does not clear a manual hold).
	 */
	private holdClause(hold: HoldSnapshot): string {
		const th = memPressureThresholdsFromEnv(this.env);
		switch (hold.state) {
			case "placed_by_sensor":
			case "existing_sensor":
				return `pressure-hold 已于压力确认时刻置位（新 runner 派发已暂停），free 回到 ${th.freeHighPct}% 且 swapout 增量回到校准噪声线（≤ ${th.swapoutMinPages} 页/tick）后自动解除并安静 resolve。`;
			case "existing_manual":
				return "已有人工 pressure-hold 生效（非本传感器置，不会自动解除）。";
			default:
				return "⚠️ 保护动作置位失败，派发未被暂停 —— 需要人工关注（注：若 StateStore 整体故障，本告警可能也无法送达，best-effort）。";
		}
	}

	/**
	 * FLY-1193: render the OOM page — four honest classes (R2-3), each keyed off
	 * THIS tick's live evaluation so the copy never says something false about the
	 * cause / recovery / who holds the hold.
	 */
	private buildAlert(args: {
		kind: "sustained" | "hold_failure";
		episodeId: string;
		elapsedMs: number;
		ev: MemoryEvaluation;
		hold: HoldSnapshot;
	}): AlertPayload {
		const { kind, episodeId, elapsedMs, ev, hold } = args;
		const th = memPressureThresholdsFromEnv(this.env);
		const debounceSec = pageDebounceSecFromEnv(this.env);
		const freePct = ev.freePct?.toFixed(1) ?? "?";
		const elapsedSec = Math.round(elapsedMs / 1000);

		// Cause body — the actual live branch, never a fixed template.
		let cause: string;
		if (ev.danger) {
			cause =
				ev.swapoutDelta != null && ev.swapoutDelta > th.swapoutMinPages
					? `正在持续 swapout（${ev.swapoutDelta} 页/tick，超过校准噪声线 ${th.swapoutMinPages}）`
					: `可用内存告急（free ${freePct}% < ${th.freeLowPct}%）`;
		} else if (ev.healthy === null) {
			cause = "最近一次采样失败/不可判，无法证明已恢复";
		} else {
			cause = `压力尚未回到恢复线（需 free ≥ ${th.freeHighPct}% 且 swapout 增量 ≤ ${th.swapoutMinPages} 页/tick）`;
		}

		if (kind === "hold_failure") {
			return {
				leadId: "swap",
				projectName: FLEET_ALERT_PROJECT,
				eventId: `swap-holdfail:${episodeId}`,
				episodeId,
				eventType: "swap_pressure_high",
				title: "⚠️ 内存保护未能启用（pressure-hold 置位失败）",
				body: `检测到内存压力（${cause}，当前 free ${freePct}%），但 pressure-hold 置位失败 —— 新 runner 派发未被暂停。${this.holdClause(hold)}`,
				severity: "severe",
			};
		}

		// sustained page — three sub-titles.
		const title =
			debounceSec === 0
				? "内存压力已确认（page 延迟已关闭）"
				: ev.danger
					? "内存压力持续越阈（OOM 预警）"
					: "内存压力事件持续中（尚未满足恢复条件）";
		const persisted =
			elapsedSec > 0 ? `已持续约 ${elapsedSec} 秒。` : "刚刚确认。";
		return {
			leadId: "swap",
			projectName: FLEET_ALERT_PROJECT,
			eventId: `swap-pressure:${episodeId}`,
			episodeId,
			eventType: "swap_pressure_high",
			title,
			body: `真实内存压力：${cause}，当前 free ${freePct}%。${persisted}${this.holdClause(hold)}`,
			severity: "severe",
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
				// A failed hold write is durable protection-path evidence, not an
				// episodic pressure reading. Recovery (or a later hold) must never
				// erase the only signal that dispatch was left unprotected.
				if (input.eventId.startsWith("swap-holdfail:")) return null;
				if (this.memMonitor.lastEvaluation?.healthy === true) return true;
				let hold: ReturnType<StateStore["getFleetPressureHold"]>;
				try {
					hold = this.deps.store.getFleetPressureHold();
				} catch {
					return null;
				}
				if (hold?.set_by !== "swap-sensor") return null;
				return hold.set_at !== input.episodeId;
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
			case "swap_pressure_high":
				// FLY-1142 three-state: resolve ONLY on PROVEN health (free% ≥ HIGH
				// and swapout-delta ≤ MIN). null = no evidence yet (fresh monitor /
				// first sample / probe failure) → cannot tell; false = provably
				// still unhealthy. A genuinely-still-thrashing machine re-triggers
				// a fresh episode within 2 ticks either way.
				return this.memMonitor.lastEvaluation?.healthy ?? null;
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
