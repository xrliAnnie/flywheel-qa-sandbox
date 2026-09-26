import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { getProcessStart } from "flywheel-comm/lead-lease";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import {
	type MemoryPressure,
	MemoryPressureMonitor,
	memPressureThresholdsFromEnv,
	PRESSURE_READ_TIMEOUT_MS,
	PRESSURE_SAMPLE_INTERVAL_MS,
	type PressureMonitorState,
	type PressureSnapshot,
	readMemoryPressure,
} from "./machine-watermark.js";

export interface PressureSamplerRecord {
	hostBootId: string;
	warmupUntilMs: number;
	cacheJson: string;
}
interface Notice {
	id: string;
	episodeId: string;
	kind: "pause" | "resume" | "degraded";
	snapshot: PressureSnapshot;
}
interface Notifications {
	episodeId: string | null;
	danger: number;
	healthy: number;
	degraded: boolean;
	degradedEpisodeId: string | null;
	degradedSequence: number;
	pending: Notice[];
}
interface Cache {
	version: 1;
	/** Missing in older version 1 records, whose host identity was always verified. */
	evidenceHostVerified?: boolean;
	source: "vm_stat";
	thresholds: { freeLowPct: number; swapoutMinPages: number };
	monitor: PressureMonitorState;
	notifications: Notifications;
}
export interface PressureSamplerOptions {
	store: {
		getPressureSamplerState(): PressureSamplerRecord | undefined;
		setPressureSamplerState(record: PressureSamplerRecord): void;
	};
	enabled?: boolean | (() => boolean);
	env?: NodeJS.ProcessEnv;
	platform?: string;
	hostBootId?: string | null;
	readPressure?: (signal: AbortSignal) => Promise<MemoryPressure | null>;
	now?: () => number;
	monotonicNow?: () => number;
	/** Composition seam for short real-clock CI; production always uses the exported constants. */
	intervalMs?: number;
	readTimeoutMs?: number;
	logger?: (message: string) => void;
}
export function pressureSensorEnabled(
	env: NodeJS.ProcessEnv,
	platform: string = process.platform,
	injected = false,
): boolean {
	if (injected || env.FLYWHEEL_SWAP_SENSOR_CMD?.trim()) return true;
	return platform === "darwin" && env.NODE_ENV !== "test" && !env.VITEST;
}
function hostBootId(): string | null {
	try {
		const start = getProcessStart(1);
		return start?.trim() ? `${hostname()}:${start}` : null;
	} catch {
		return null;
	}
}
const finiteTime = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The sole vm_stat owner. Admission reads synchronously; notifications never hold its probe. */
export class PressureSampler {
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly mono: () => number;
	private readonly interval: number;
	private readonly timeout: number;
	private readonly available: boolean;
	private requested = false;
	private controlUnavailable = false;
	private readonly bootId: string | null;
	private readonly thresholds: ReturnType<typeof memPressureThresholdsFromEnv>;
	private readonly log: (s: string) => void;
	private monitor: MemoryPressureMonitor;
	private warmupUntilMs: number;
	private cacheUnavailable = false;
	private liveSamples = 0;
	private storageRead = true;
	private running = false;
	private stopping = false;
	private unverifiedEnvelope = { hostBootId: "", warmupUntilMs: 0 };
	private anchor = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private deadline?: ReturnType<typeof setTimeout>;
	private abort?: AbortController;
	private inFlight = false;
	private generation = 0;
	private notifications: Notifications = {
		episodeId: null,
		danger: 0,
		healthy: 0,
		degraded: false,
		degradedEpisodeId: null,
		degradedSequence: 0,
		pending: [],
	};
	private sink?: (
		notice: Notice,
		snapshot: PressureSnapshot,
	) => Promise<boolean>;
	private notificationFlight?: Promise<void>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private retryMs = 1000;
	constructor(private readonly options: PressureSamplerOptions) {
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
		this.mono = options.monotonicNow ?? (() => performance.now());
		this.interval = options.intervalMs ?? PRESSURE_SAMPLE_INTERVAL_MS;
		this.timeout = options.readTimeoutMs ?? PRESSURE_READ_TIMEOUT_MS;
		this.available = pressureSensorEnabled(
			this.env,
			options.platform,
			!!options.readPressure,
		);
		this.bootId =
			options.hostBootId === undefined
				? this.available
					? hostBootId()
					: null
				: options.hostBootId;
		this.thresholds = memPressureThresholdsFromEnv(this.env);
		this.log =
			options.logger ??
			((message) => console.warn(`[pressure-sampler] ${message}`));
		const now = this.now();
		this.warmupUntilMs = now + 2 * this.interval;
		let restored: PressureMonitorState | undefined;
		if (this.available) {
			try {
				const row = options.store.getPressureSamplerState();
				// Notification history describes delivered/pending transitions, not current
				// machine evidence. Host reboot/config changes must not erase that outbox.
				if (row) {
					try {
						const history = JSON.parse(row.cacheJson);
						if (validNotifications(history.notifications))
							this.notifications = normalizeNotifications(
								history.notifications,
								row,
							);
					} catch {
						/* Invalid history cannot claim delivery. */
					}
				}
				if (!this.bootId) {
					if (row) this.preserveUnverifiedEnvelope(row);
					this.cacheUnavailable = true;
				} else if (row?.hostBootId === this.bootId) {
					// A separately typed envelope survives invalid JSON/config changes. Never renew this boot's deadline.
					if (
						!finiteTime(row.warmupUntilMs) ||
						row.warmupUntilMs > now + 2 * this.interval
					) {
						this.cacheUnavailable = true;
						this.warmupUntilMs = 0;
					} else this.warmupUntilMs = row.warmupUntilMs;
					try {
						const cache: Cache = JSON.parse(row.cacheJson);
						if (
							cache.version === 1 &&
							cache.evidenceHostVerified !== false &&
							cache.source === "vm_stat" &&
							cache.thresholds.freeLowPct === this.thresholds.freeLowPct &&
							cache.thresholds.swapoutMinPages ===
								this.thresholds.swapoutMinPages
						) {
							const m = cache.monitor;
							if (
								Array.isArray(m.samples) &&
								m.samples.length <= 2 &&
								typeof m.established === "boolean" &&
								Number.isInteger(m.consecutiveDanger) &&
								m.consecutiveDanger >= 0 &&
								m.consecutiveDanger <= 2 &&
								m.samples.every(
									(s, i, all) =>
										finiteTime(s.sampledAtMs) &&
										s.sampledAtMs <= now &&
										now - s.sampledAtMs <= 3 * this.interval &&
										Number.isFinite(s.freePct) &&
										s.freePct >= 0 &&
										s.freePct <= 100 &&
										Number.isFinite(s.swapoutsTotal) &&
										s.swapoutsTotal >= 0 &&
										(i === 0 || s.sampledAtMs >= all[i - 1]!.sampledAtMs),
								) &&
								(m.pressureEvidenceAtMs === null ||
									(finiteTime(m.pressureEvidenceAtMs) &&
										m.pressureEvidenceAtMs <= now &&
										m.pressureEvidenceAtMs === m.samples.at(-1)?.sampledAtMs &&
										finiteTime(m.pressureValidUntilMs)))
							) {
								restored = m;
							}
						}
					} catch {
						/* Keep the original envelope deadline; invalid evidence is not pressure. */
					}
				}
			} catch {
				this.cacheUnavailable = true;
				this.storageRead = false;
			}
		}
		this.monitor = new MemoryPressureMonitor(this.thresholds, 2, {
			warmupUntilMs: this.warmupUntilMs,
			maxAgeMs: 3 * this.interval,
			restored,
		});
		// Freeze BEFORE the first admission/async read. A failed freeze is explicit unknown.
		if (this.isEnabled() && !this.persist()) this.cacheUnavailable = true;
	}
	private isEnabled(): boolean {
		if (!this.available) return false;
		try {
			this.controlUnavailable = false;
			return typeof this.options.enabled === "function"
				? this.options.enabled()
				: this.options.enabled !== false;
		} catch {
			this.controlUnavailable = true;
			return true;
		}
	}
	private syncControl(): boolean {
		const enabled = this.isEnabled();
		if (!enabled && this.running) this.suspend();
		if (enabled && this.requested && !this.running && !this.stopping)
			this.begin();
		return enabled;
	}
	evaluatePressure(now = this.now()): PressureSnapshot {
		const enabled = this.syncControl();
		const snapshot = this.monitor.evaluatePressure(now);
		if (!enabled)
			return {
				...snapshot,
				state: "healthy",
				reason: "sensor_disabled",
				evidenceValidUntilMs: null,
			};
		if (this.controlUnavailable)
			return {
				...snapshot,
				state: "unknown",
				reason: "sensor_control_unavailable",
				evidenceValidUntilMs: null,
			};
		if (
			(this.cacheUnavailable || !this.bootId) &&
			!(
				this.liveSamples >= 2 &&
				snapshot.state === "healthy" &&
				snapshot.swapoutDeltaPages !== null
			)
		)
			return {
				...snapshot,
				state: "unknown",
				reason: "cache_unavailable",
				evidenceValidUntilMs: null,
			};
		return snapshot;
	}
	start(): void {
		if (this.stopping) return;
		this.requested = true;
		this.syncControl();
	}
	private begin(): void {
		this.running = true;
		this.anchor = this.mono();
		this.generation++;
		this.sample();
		this.schedule();
		this.flushNotifications();
	}
	private schedule(): void {
		if (!this.running) return;
		const next =
			this.anchor +
			(Math.floor((this.mono() - this.anchor) / this.interval) + 1) *
				this.interval;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				if (!this.running) return;
				this.sample();
				this.schedule();
			},
			Math.max(1, next - this.mono()),
		);
		this.timer.unref?.();
	}
	private sample(): void {
		if (!this.syncControl() || !this.running) return;
		if (this.inFlight) {
			this.observeDegraded();
			return;
		}
		this.inFlight = true;
		const generation = this.generation;
		const controller = new AbortController();
		this.abort = controller;
		let expired = false;
		this.deadline = setTimeout(() => {
			expired = true;
			controller.abort();
			if (this.syncControl() && this.running && generation === this.generation)
				this.accept(null);
		}, this.timeout);
		this.deadline.unref?.();
		const read =
			this.options.readPressure ??
			((signal: AbortSignal) => readMemoryPressure(this.env, signal));
		void Promise.resolve()
			.then(() => read(controller.signal))
			.then(
				(p) => {
					if (
						this.syncControl() &&
						this.running &&
						generation === this.generation &&
						!expired
					)
						this.accept(p);
				},
				() => {
					if (
						this.syncControl() &&
						this.running &&
						generation === this.generation &&
						!expired
					)
						this.accept(null);
				},
			)
			.finally(() => {
				if (this.abort !== controller) return;
				if (this.deadline) clearTimeout(this.deadline);
				this.deadline = undefined;
				this.abort = undefined;
				this.inFlight = false;
			});
	}
	private accept(reading: MemoryPressure | null): void {
		const now = this.now();
		if (reading) this.liveSamples++;
		const ev = this.monitor.tick(reading, now);
		const snapshot = this.monitor.evaluatePressure(now);
		// Successful persistence after an outage restores only real readings, never an invented healthy verdict.
		if (this.bootId && this.persist()) this.cacheUnavailable = false;
		if (ev.danger) {
			this.notifications.danger = Math.min(2, this.notifications.danger + 1);
			this.notifications.healthy = 0;
			if (this.notifications.danger >= 2 && !this.notifications.episodeId) {
				this.notifications.episodeId = `${this.bootId ?? "unknown"}:${now}`;
				this.enqueue("pause", this.notifications.episodeId, snapshot);
			}
		} else if (ev.healthy === null) {
			this.notifications.danger = 0;
			this.notifications.healthy = 0;
		} else {
			this.notifications.healthy = Math.min(2, this.notifications.healthy + 1);
			this.notifications.danger = 0;
			if (
				this.notifications.healthy >= 2 &&
				(this.notifications.episodeId || this.notifications.degraded)
			) {
				this.enqueue(
					"resume",
					this.notifications.episodeId ?? this.notifications.degradedEpisodeId!,
					snapshot,
				);
				this.notifications.episodeId = null;
				this.notifications.degraded = false;
				this.notifications.degradedEpisodeId = null;
			}
		}
		this.observeDegraded();
		this.persist();
		this.flushNotifications();
	}
	private observeDegraded(): void {
		const snap = this.evaluatePressure();
		if (snap.state === "unknown" && !this.notifications.degraded) {
			this.notifications.degraded = true;
			this.notifications.degradedSequence++;
			this.notifications.degradedEpisodeId = `${this.bootId ?? "unknown"}:degraded:${this.notifications.degradedSequence}:${this.now()}`;
			this.enqueue("degraded", this.notifications.degradedEpisodeId, snap);
			this.persist();
			this.flushNotifications();
		}
	}
	private enqueue(
		kind: Notice["kind"],
		episodeId: string,
		snapshot: PressureSnapshot,
	): void {
		const id = `swap-pressure:${episodeId}:${kind}`;
		if (!this.notifications.pending.some((n) => n.id === id))
			this.notifications.pending.push({ id, episodeId, kind, snapshot });
	}
	private preserveUnverifiedEnvelope(row: PressureSamplerRecord): void {
		// Keep a previously verified boot/deadline as an envelope only. The cache
		// explicitly marks new readings unverified, so that identity grants no reuse.
		this.unverifiedEnvelope = {
			hostBootId: row.hostBootId,
			warmupUntilMs: finiteTime(row.warmupUntilMs) ? row.warmupUntilMs : 0,
		};
	}
	private persist(): boolean {
		try {
			if (!this.storageRead) {
				const row = this.options.store.getPressureSamplerState();
				if (!this.bootId && row) this.preserveUnverifiedEnvelope(row);
				if (row) {
					try {
						const history = JSON.parse(row.cacheJson).notifications;
						if (validNotifications(history)) {
							// During a read outage keep durable incident identity; merge only distinct pending transitions.
							const pending = [
								...history.pending,
								...this.notifications.pending,
							];
							this.notifications = {
								...normalizeNotifications(history, row),
								pending: pending.filter(
									(n, i) => pending.findIndex((p) => p.id === n.id) === i,
								),
							};
						}
					} catch {
						/* Invalid persisted notification history has no authority. */
					}
				}
				if (row?.hostBootId === this.bootId) {
					if (!finiteTime(row.warmupUntilMs)) return false;
					this.warmupUntilMs = Math.min(row.warmupUntilMs, this.warmupUntilMs);
					this.monitor = new MemoryPressureMonitor(this.thresholds, 2, {
						warmupUntilMs: this.warmupUntilMs,
						maxAgeMs: 3 * this.interval,
						restored: this.monitor.exportState(),
					});
				}
				this.storageRead = true;
			}
			const cache: Cache = {
				version: 1,
				evidenceHostVerified: this.bootId !== null,
				source: "vm_stat",
				thresholds: {
					freeLowPct: this.thresholds.freeLowPct,
					swapoutMinPages: this.thresholds.swapoutMinPages,
				},
				monitor: this.monitor.exportState(),
				notifications: this.notifications,
			};
			this.options.store.setPressureSamplerState({
				hostBootId: this.bootId ?? this.unverifiedEnvelope.hostBootId,
				warmupUntilMs: this.bootId
					? this.warmupUntilMs
					: this.unverifiedEnvelope.warmupUntilMs,
				cacheJson: JSON.stringify(cache),
			});
			return true;
		} catch (error) {
			this.log(`cache persistence failed: ${String(error)}`);
			return false;
		}
	}
	attachAlertSink(sink: {
		alert: (payload: AlertPayload) => Promise<AlertResult>;
		resolve?: () => Promise<void>;
	}): void {
		this.attachNotifications(async (notice, current) => {
			const generation = this.generation;
			const result = await sink.alert(
				pressureNotificationPayload(notice, current),
			);
			if (!this.running || generation !== this.generation || !this.isEnabled())
				return false;
			const fresh = this.evaluatePressure();
			if (
				pressureNoticeDurable(result) &&
				notice.kind === "resume" &&
				fresh.state === "healthy" &&
				fresh.reason !== "sensor_disabled" &&
				fresh.swapoutDeltaPages !== null
			) {
				await sink.resolve?.();
			}
			return pressureNoticeDurable(result);
		});
	}
	attachNotifications(
		sink: (notice: Notice, snapshot: PressureSnapshot) => Promise<boolean>,
	): void {
		this.sink = sink;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.flushNotifications();
	}
	private flushNotifications(): void {
		if (!this.syncControl()) return;
		if (
			!this.running ||
			!this.sink ||
			this.notificationFlight ||
			this.retryTimer ||
			!this.notifications.pending.length
		)
			return;
		if (!this.persist()) return;
		const generation = this.generation;
		this.notificationFlight = (async () => {
			const notice = this.notifications.pending[0]!;
			try {
				// Revalidate NOW, but retain honest historical event copy if the episode has already passed.
				if (await this.sink!(notice, this.evaluatePressure())) {
					if (
						!this.syncControl() ||
						!this.running ||
						generation !== this.generation
					)
						return;
					this.notifications.pending.shift();
					if (!this.persist()) this.notifications.pending.unshift(notice);
					else this.retryMs = 1000;
				}
			} catch (error) {
				this.log(`notification deferred: ${String(error)}`);
			}
		})().finally(() => {
			this.notificationFlight = undefined;
			if (
				!this.syncControl() ||
				!this.running ||
				generation !== this.generation ||
				!this.notifications.pending.length
			)
				return;
			this.retryTimer = setTimeout(() => {
				this.retryTimer = undefined;
				this.flushNotifications();
			}, this.retryMs);
			this.retryTimer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, this.interval);
		});
	}
	private suspend(): void {
		this.running = false;
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		if (this.deadline) clearTimeout(this.deadline);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.timer = this.deadline = this.retryTimer = undefined;
		this.abort?.abort();
		// Generation fencing prevents late probe/HTTP store writes.
	}
	async stop(): Promise<void> {
		this.stopping = true;
		this.requested = false;
		this.suspend();
		try {
			// Alert delivery and ticket resolution can write storage after their I/O.
			// Bridge must keep StateStore open until this already-started work settles.
			await this.notificationFlight;
		} finally {
			this.stopping = false;
		}
	}
}
function validNotifications(n: Notifications): boolean {
	return (
		!!n &&
		(n.episodeId === null || typeof n.episodeId === "string") &&
		Number.isInteger(n.danger) &&
		n.danger >= 0 &&
		n.danger <= 2 &&
		Number.isInteger(n.healthy) &&
		n.healthy >= 0 &&
		n.healthy <= 2 &&
		typeof n.degraded === "boolean" &&
		(n.degradedEpisodeId === undefined ||
			n.degradedEpisodeId === null ||
			typeof n.degradedEpisodeId === "string") &&
		(n.degradedSequence === undefined ||
			(Number.isSafeInteger(n.degradedSequence) && n.degradedSequence >= 0)) &&
		Array.isArray(n.pending) &&
		n.pending.every(
			(p) =>
				typeof p.id === "string" &&
				typeof p.episodeId === "string" &&
				["pause", "resume", "degraded"].includes(p.kind) &&
				!!p.snapshot,
		)
	);
}
/** Version 1 records predate independent degradation IDs. Preserve any old
 * active transition identity while making every future outage distinct. */
function normalizeNotifications(
	history: Notifications,
	row: PressureSamplerRecord,
): Notifications {
	return {
		...history,
		degradedSequence: history.degradedSequence ?? 0,
		degradedEpisodeId: history.degraded
			? (history.degradedEpisodeId ??
				history.pending.find((n) => n.kind === "degraded")?.episodeId ??
				history.episodeId ??
				`${row.hostBootId}:degraded:${row.warmupUntilMs}`)
			: null,
	};
}
export function createPressureSampler(
	options: PressureSamplerOptions,
): PressureSampler {
	return new PressureSampler(options);
}
export function pressureSnapshotDetail(s: PressureSnapshot): string {
	return `memory ${s.state}: ${s.reason}; source=${s.source}; sampledAtMs=${s.sampledAtMs ?? "unknown"}; freePct=${s.freePct ?? "unknown"}; swapoutDeltaPages=${s.swapoutDeltaPages ?? "unknown"}; evidenceValidUntilMs=${s.evidenceValidUntilMs ?? "unknown"}`;
}
export function pressureNotificationPayload(
	notice: Notice,
	current: PressureSnapshot,
): AlertPayload {
	const title =
		notice.kind === "pause"
			? "内存压力确认：派发暂停"
			: notice.kind === "resume"
				? "内存压力监测：派发条件已恢复"
				: "内存压力监测降级：暂停派发，等待有效采样";
	return {
		leadId: "swap",
		projectName: FLEET_ALERT_PROJECT,
		eventId: notice.id,
		episodeId: notice.episodeId,
		eventType: "swap_pressure_high",
		title,
		body: `kind=${notice.kind}; reason=${notice.snapshot.reason}. 事件采样：${pressureSnapshotDetail(notice.snapshot)}。当前：${pressureSnapshotDetail(current)}。${notice.kind === "resume" ? "连续两次有效读数无压力；人工暂停仍需人工解除。" : "准入独立按当前证据判断；历史通知不会设置暂停。"}`,
		metadata: {
			pressureSampler: {
				kind: notice.kind,
				reason: notice.snapshot.reason,
				sampledAtMs: notice.snapshot.sampledAtMs,
			},
		},
		severity: notice.kind === "pause" ? "severe" : "warning",
	};
}
export function pressureNoticeDurable(result: AlertResult): boolean {
	return !!(
		result.sent ||
		result.queued ||
		result.deadLettered ||
		result.skipped === "duplicate"
	);
}

const samplersByStore = new WeakMap<object, PressureSampler>();
export function pressureSnapshotForStore(
	store: object,
): PressureSnapshot | undefined {
	return samplersByStore.get(store)?.evaluatePressure();
}

/** Production boot seam: freeze/start before binding every admission consumer. */
export function startPressureSampling(
	options: PressureSamplerOptions & {
		admission?: {
			setPressureSnapshotProvider(provider: () => PressureSnapshot): void;
			setPressureHoldProbe(provider: () => string | null): void;
		};
		manualHold?: () =>
			| { set_by: string; set_at: string; watermark: string | null }
			| undefined;
	},
): PressureSampler {
	const sampler = createPressureSampler(options);
	samplersByStore.set(options.store, sampler);
	sampler.start();
	options.admission?.setPressureSnapshotProvider(() =>
		sampler.evaluatePressure(),
	);
	options.admission?.setPressureHoldProbe(() => {
		const hold = options.manualHold?.();
		return hold && hold.set_by !== "swap-sensor"
			? `manual pressure hold since ${hold.set_at} by ${hold.set_by}: ${hold.watermark ?? "manual pause"}`
			: null;
	});
	return sampler;
}

/** Stop only this early resource when a later Bridge bootstrap step fails. */
export async function withPressureSamplerBoot<T>(
	boot: (register: (sampler: PressureSampler) => void) => Promise<T>,
): Promise<T> {
	let sampler: PressureSampler | undefined;
	try {
		return await boot((value) => {
			sampler = value;
		});
	} catch (error) {
		await sampler?.stop();
		throw error;
	}
}
