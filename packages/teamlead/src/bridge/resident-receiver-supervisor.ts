import type {
	IMailboxWatcher,
	RunnerSpawnContext,
} from "flywheel-agent-team-transport";
import type { PhaseWakeInput } from "flywheel-comm/db";

export const RECEIVER_STALL_MS = 180_000;
export const RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS = 300_000;
const RECEIVER_STALL_TICKS = 3;

export type ResidentReceiverWakeMode =
	| "builtin-receiver"
	| "external-watcher"
	| "push-only"
	| "none";

export type ResidentReceiverArmSource =
	| "admission"
	| "reown_watch"
	| "reown_revive"
	| "boot"
	| "rearm";

export type ResidentReceiverEvent =
	| "receiver_armed"
	| "receiver_heartbeat"
	| "receiver_stalled"
	| "receiver_unsupported";

export type ResidentReceiverVerdict =
	| "healthy"
	| "starting"
	| "receiver_missing"
	| "receiver_stalled"
	| "unsupported";

export interface ResidentReceiverCandidate {
	executionId: string;
	issueId: string;
	projectName: string;
	commDbPath: string;
	wakeMode: ResidentReceiverWakeMode;
	receiverContext: RunnerSpawnContext;
}

export interface ResidentReceiverSnapshot {
	candidate: boolean;
	wakeMode: ResidentReceiverWakeMode;
	armed: boolean;
	pendingRegistration: boolean;
	nowMs: number;
	armedAtMs: number;
	health?: {
		ok: boolean;
		lastEventTs?: number;
		pendingCount?: number;
	};
}

export function classifyReceiver(
	snapshot: ResidentReceiverSnapshot,
): ResidentReceiverVerdict {
	if (!snapshot.candidate || snapshot.wakeMode !== "external-watcher") {
		return "unsupported";
	}
	if (snapshot.pendingRegistration) return "starting";
	if (!snapshot.armed) return "receiver_missing";
	if (!snapshot.health) {
		return snapshot.nowMs - snapshot.armedAtMs <= RECEIVER_STALL_MS
			? "starting"
			: "receiver_stalled";
	}
	if (!snapshot.health.ok) return "receiver_stalled";
	if (snapshot.health.lastEventTs === undefined) {
		return snapshot.nowMs - snapshot.armedAtMs <= RECEIVER_STALL_MS
			? "starting"
			: "receiver_stalled";
	}
	return snapshot.nowMs - snapshot.health.lastEventTs > RECEIVER_STALL_MS
		? "receiver_stalled"
		: "healthy";
}

interface ResidentReceiverSupervisorDeps {
	listCandidates(): readonly ResidentReceiverCandidate[];
	hasCommSession(candidate: ResidentReceiverCandidate): boolean;
	createReceiver(candidate: ResidentReceiverCandidate): IMailboxWatcher | null;
	enqueueDelivery(
		executionId: string,
		message: PhaseWakeInput,
		candidate: ResidentReceiverCandidate,
	): boolean;
	record(
		candidate: ResidentReceiverCandidate,
		event: ResidentReceiverEvent,
		payload: Record<string, unknown>,
	): void;
	alert(
		candidate: ResidentReceiverCandidate,
		payload: Record<string, unknown>,
	): Promise<void> | void;
	nowMs(): number;
}

interface ReceiverEntry {
	candidate: ResidentReceiverCandidate;
	source: ResidentReceiverArmSource;
	watcher: IMailboxWatcher | null;
	armedAtMs: number;
	pendingRegistration: boolean;
}

interface ReceiverEpisode {
	stallCount: number;
	rearmed: boolean;
	alerted: boolean;
}

/** Bridge-owned mailbox watcher lifecycle for every eligible worker. */
export class ResidentReceiverSupervisor {
	private readonly entries = new Map<string, ReceiverEntry>();
	private readonly episodes = new Map<string, ReceiverEpisode>();
	private readonly lastHeartbeatEventAt = new Map<string, number>();
	private readonly unsupported = new Set<string>();
	private stopped = false;

	constructor(private readonly deps: ResidentReceiverSupervisorDeps) {}

	async arm(
		executionId: string,
		source: ResidentReceiverArmSource,
	): Promise<void> {
		if (this.stopped) return;
		const current = this.deps
			.listCandidates()
			.find((candidate) => candidate.executionId === executionId);
		if (!current) {
			await this.disarm(executionId);
			return;
		}
		if (current.wakeMode !== "external-watcher") {
			if (
				current.wakeMode !== "builtin-receiver" &&
				!this.unsupported.has(executionId)
			) {
				this.unsupported.add(executionId);
				this.deps.record(current, "receiver_unsupported", {
					wakeMode: current.wakeMode,
				});
			}
			return;
		}
		const existing = this.entries.get(executionId);
		if (existing?.watcher) return;
		if (!this.deps.hasCommSession(current)) {
			this.entries.set(executionId, {
				candidate: current,
				source: existing?.source ?? source,
				watcher: null,
				armedAtMs: existing?.armedAtMs ?? this.deps.nowMs(),
				pendingRegistration: true,
			});
			return;
		}
		const armSource = existing?.source ?? source;
		try {
			await this.startWatcher(current, armSource);
		} catch (error) {
			this.entries.set(executionId, {
				candidate: current,
				source: armSource,
				watcher: null,
				armedAtMs: existing?.armedAtMs ?? this.deps.nowMs(),
				pendingRegistration: true,
			});
			this.deps.record(current, "receiver_stalled", {
				operation: "arm",
				source: armSource,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async reconcile(source: ResidentReceiverArmSource): Promise<void> {
		if (this.stopped) return;
		const candidates = this.deps.listCandidates();
		const currentIds = new Set(
			candidates.map((candidate) => candidate.executionId),
		);
		for (const executionId of this.entries.keys()) {
			if (currentIds.has(executionId)) continue;
			const entry = this.entries.get(executionId);
			try {
				await this.disarm(executionId);
			} catch (error) {
				if (entry) {
					this.deps.record(entry.candidate, "receiver_stalled", {
						operation: "disarm",
						source,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		for (const candidate of candidates) {
			try {
				await this.arm(candidate.executionId, source);
			} catch (error) {
				this.deps.record(candidate, "receiver_stalled", {
					operation: "arm",
					source,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async healthTick(): Promise<void> {
		if (this.stopped) return;
		await this.reconcile("boot");
		for (const [executionId, entry] of [...this.entries]) {
			try {
				await this.checkHealth(executionId, entry);
			} catch (error) {
				this.deps.record(entry.candidate, "receiver_stalled", {
					operation: "health",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private async checkHealth(
		executionId: string,
		entry: ReceiverEntry,
	): Promise<void> {
		if (!entry.watcher) return;
		const nowMs = this.deps.nowMs();
		let health: Awaited<ReturnType<IMailboxWatcher["health"]>>;
		let healthError: string | undefined;
		try {
			health = await entry.watcher.health();
		} catch (error) {
			healthError = error instanceof Error ? error.message : String(error);
			health = { ok: false };
		}
		const previousHeartbeat = this.lastHeartbeatEventAt.get(executionId);
		if (
			previousHeartbeat === undefined ||
			nowMs - previousHeartbeat >= RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS
		) {
			this.lastHeartbeatEventAt.set(executionId, nowMs);
			this.deps.record(entry.candidate, "receiver_heartbeat", {
				ok: health.ok,
				lastEventTs: health.lastEventTs ?? null,
				pendingCount: health.pendingCount ?? null,
				...(healthError ? { error: healthError } : {}),
			});
		}
		const verdict = classifyReceiver({
			candidate: true,
			wakeMode: entry.candidate.wakeMode,
			armed: true,
			pendingRegistration: false,
			nowMs,
			armedAtMs: entry.armedAtMs,
			health,
		});
		if (verdict === "healthy") {
			this.episodes.delete(executionId);
			return;
		}
		if (verdict !== "receiver_stalled") return;
		const episode = this.episodes.get(executionId) ?? {
			stallCount: 0,
			rearmed: false,
			alerted: false,
		};
		episode.stallCount += 1;
		this.episodes.set(executionId, episode);
		if (episode.stallCount < RECEIVER_STALL_TICKS) return;
		if (!episode.rearmed) {
			this.entries.delete(executionId);
			await entry.watcher.stop();
			await this.startWatcher(entry.candidate, "rearm");
			episode.rearmed = true;
		}
		if (!episode.alerted) {
			this.deps.record(entry.candidate, "receiver_stalled", {
				consecutiveFailures: episode.stallCount,
				rearmed: episode.rearmed,
				episode: entry.armedAtMs,
			});
			await this.deps.alert(entry.candidate, {
				consecutiveFailures: episode.stallCount,
				rearmed: episode.rearmed,
				episode: entry.armedAtMs,
			});
			episode.alerted = true;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const executionId of [...this.entries.keys()]) {
			const entry = this.entries.get(executionId);
			try {
				await this.disarm(executionId);
			} catch (error) {
				if (entry) {
					this.deps.record(entry.candidate, "receiver_stalled", {
						operation: "stop",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}

	private async startWatcher(
		candidate: ResidentReceiverCandidate,
		source: ResidentReceiverArmSource,
	): Promise<void> {
		const watcher = this.deps.createReceiver(candidate);
		if (!watcher) {
			if (!this.unsupported.has(candidate.executionId)) {
				this.unsupported.add(candidate.executionId);
				this.deps.record(candidate, "receiver_unsupported", {
					wakeMode: candidate.wakeMode,
				});
			}
			return;
		}
		watcher.onDelivered = async (message) => {
			if (this.entries.get(candidate.executionId)?.watcher !== watcher) {
				throw new Error(
					`receiver ownership changed for ${candidate.executionId}`,
				);
			}
			if (message.to !== candidate.receiverContext.runnerName) {
				throw new Error(
					`receiver recipient mismatch: expected ${candidate.receiverContext.runnerName}, got ${message.to}`,
				);
			}
			if (
				!this.deps.enqueueDelivery(candidate.executionId, message, candidate)
			) {
				throw new Error(
					`receiver durable consumer unavailable for ${candidate.executionId}`,
				);
			}
		};
		const armedAtMs = this.deps.nowMs();
		this.entries.set(candidate.executionId, {
			candidate,
			source,
			watcher,
			armedAtMs,
			pendingRegistration: false,
		});
		try {
			await watcher.start();
		} catch (error) {
			if (this.entries.get(candidate.executionId)?.watcher === watcher) {
				this.entries.delete(candidate.executionId);
			}
			await watcher.stop();
			throw error;
		}
		this.deps.record(candidate, "receiver_armed", { source });
	}

	private async disarm(executionId: string): Promise<void> {
		const entry = this.entries.get(executionId);
		this.entries.delete(executionId);
		this.episodes.delete(executionId);
		this.lastHeartbeatEventAt.delete(executionId);
		this.unsupported.delete(executionId);
		await entry?.watcher?.stop();
	}
}
