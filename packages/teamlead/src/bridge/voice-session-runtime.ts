import type {
	StateStore,
	VoiceHealthDemandSnapshot,
	VoiceSessionRow,
} from "../StateStore.js";
import type { BridgeConfig } from "./types.js";

type VoiceSessionTiming = NonNullable<BridgeConfig["voiceSessionTiming"]>;

export interface VoiceSessionRuntimeDeps {
	store: StateStore;
	timing: VoiceSessionTiming;
	now?: () => string;
	provision: (sessionId: string, signal: AbortSignal) => Promise<void>;
	poll: (session: VoiceSessionRow) => Promise<void>;
	requestWake?: (
		session: VoiceSessionRow,
	) => Promise<"coalesced" | "unknown" | "accepted" | "unavailable" | "failed">;
	/** Attempt id minted per admitted wake; injected so tests stay deterministic. */
	newAttemptId?: () => string;
	validateSession?: (session: VoiceSessionRow) => void | Promise<void>;
	reportPollFailure?: (
		session: VoiceSessionRow,
		reason: string,
	) => void | Promise<void>;
	recordDemand?: (snapshot: VoiceHealthDemandSnapshot) => Promise<void>;
}

export class VoiceSessionRuntime {
	private timer?: ReturnType<typeof setInterval>;
	private wakeTimer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private wakeTicking = false;
	private readonly now: () => string;
	private readonly pollFailures = new Map<
		string,
		{ reason: string; nextAt: number; delayMs: number }
	>();
	private demandCursor = 0;
	private demandSourceId?: string;
	private lastDemandProjectionKey?: string;
	private lastDemandProjectionAtMs?: number;

	constructor(private readonly deps: VoiceSessionRuntimeDeps) {
		this.now = deps.now ?? (() => new Date().toISOString());
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const at = this.now();
			if (this.deps.validateSession) {
				for (const session of this.deps.store.listVoiceSessions([
					"provisioning",
					"desired",
					"claimed",
					"warming",
					"live",
					"ending",
				])) {
					try {
						await this.deps.validateSession(session);
					} catch (error) {
						const reason =
							error instanceof Error &&
							new Set([
								"identity_binding_missing",
								"voice_session_registry_drift",
								"self_filter_unverified",
							]).has(error.message)
								? error.message
								: "voice_session_admission_failed";
						this.deps.store.failVoiceSessionAdmission(
							session.sessionId,
							reason,
							this.now(),
						);
					}
				}
			}
			this.deps.store.sweepVoiceSessions({
				now: at,
				clockSkewGraceMs: this.deps.timing.clockSkewGraceMs,
				endingTimeoutMs: this.deps.timing.endingTimeoutMs,
			});
			const staleBefore = new Date(
				Date.parse(at) - this.deps.timing.provisioningStaleMs,
			).toISOString();
			for (const session of this.deps.store.listRecoverableVoiceProvisioning(
				staleBefore,
			)) {
				try {
					await this.provisionWithDeadline(session.sessionId);
				} catch (error) {
					console.warn(
						`[voice-session] provision ${session.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			const activeSessionIds = new Set<string>();
			for (const session of this.deps.store.listVoiceSessions([
				"claimed",
				"warming",
				"live",
				"ending",
			])) {
				if (
					!session.leaseToken ||
					!this.deps.store.getActiveVoiceLease(
						session.sessionId,
						session.leaseToken,
						at,
					)
				) {
					continue;
				}
				activeSessionIds.add(session.sessionId);
				try {
					await this.deps.poll(session);
					this.pollFailures.delete(session.sessionId);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					const failure = this.pollFailures.get(session.sessionId) ?? {
						reason,
						nextAt: 0,
						delayMs: 30_000,
					};
					// All reasons render the same status, so a changed error must not
					// bypass the session's cooldown.
					failure.reason = reason;
					const failedAt = Date.parse(this.now());
					if (failedAt < failure.nextAt) continue;
					failure.nextAt = failedAt + failure.delayMs;
					failure.delayMs = Math.min(failure.delayMs * 2, 300_000);
					this.pollFailures.set(session.sessionId, failure);
					try {
						await this.deps.reportPollFailure?.(session, reason);
					} catch (reportError) {
						console.warn(
							`[voice-session] poll status ${session.sessionId} failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
						);
					}
				}
			}
			for (const sessionId of this.pollFailures.keys()) {
				if (!activeSessionIds.has(sessionId))
					this.pollFailures.delete(sessionId);
			}
			await this.projectVoiceDemand();
		} finally {
			this.ticking = false;
		}
	}

	async wakeTick(): Promise<void> {
		if (this.wakeTicking || !this.deps.requestWake) return;
		this.wakeTicking = true;
		try {
			for (const session of this.deps.store.listVoiceSessions(["desired"])) {
				const at = this.now();
				const attemptId =
					this.deps.newAttemptId?.() ?? `${session.sessionId}:${at}`;
				// FLY-2701: an unclaimed demand is a standing to-do, but asking a
				// host that never answers is a restart storm by another name. The
				// budget decides when to stop asking and say so out loud.
				const admission = this.deps.store.admitVoiceLaunchAttempt({
					sessionId: session.sessionId,
					attemptId,
					now: at,
				});
				if (admission.status === "deferred") continue;
				if (admission.status === "exhausted") {
					this.deps.store.failVoiceSessionAdmission(
						session.sessionId,
						admission.failureClass ?? "startup_retry_exhausted",
						at,
					);
					continue;
				}
				// The outcome is the *settled* command result. A request that was
				// coalesced away proves nothing and must not spend budget; a
				// configuration fault stops the retries on the first observation.
				let outcome: "accepted" | "failed" | "unavailable" | "unknown" =
					"unknown";
				try {
					const settled = await this.deps.requestWake(session);
					if (settled !== "coalesced" && settled !== "unknown")
						outcome = settled;
				} catch {
					outcome = "failed";
					console.warn(
						`[voice-session] wake request ${session.sessionId} failed`,
					);
				}
				this.deps.store.recordVoiceLaunchResult({
					attemptId,
					commandResult: outcome,
					observedAt: at,
					...(outcome === "unavailable"
						? { failureClass: "startup_config_invalid" }
						: {}),
				});
			}
		} finally {
			this.wakeTicking = false;
		}
	}

	private async projectVoiceDemand(): Promise<void> {
		if (!this.deps.recordDemand) return;
		let snapshot = this.deps.store.getVoiceDemandSnapshot(this.demandCursor);
		if (
			this.demandSourceId !== undefined &&
			this.demandSourceId !== snapshot.demandSourceId
		) {
			this.demandCursor = 0;
			this.lastDemandProjectionKey = undefined;
			this.lastDemandProjectionAtMs = undefined;
			snapshot = this.deps.store.getVoiceDemandSnapshot(0);
		}
		this.demandSourceId = snapshot.demandSourceId;
		const projectionKey = [
			snapshot.demandSourceId,
			snapshot.revision,
			snapshot.digest,
			snapshot.state,
			snapshot.sourceStatus,
		].join(":");
		const projectionAtMs = Date.parse(this.now());
		const unchangedWithinRefreshWindow =
			snapshot.events.length === 0 &&
			!snapshot.hasMore &&
			projectionKey === this.lastDemandProjectionKey &&
			this.lastDemandProjectionAtMs !== undefined &&
			Number.isFinite(projectionAtMs) &&
			projectionAtMs - this.lastDemandProjectionAtMs < 20_000;
		if (unchangedWithinRefreshWindow) {
			return;
		}
		try {
			// FLY-2693 review R5: the snapshot's row/source timestamps describe the
			// data, not this observation. The helper stamps demand_observed_at and
			// the change row from observedAt, and the fixed page's 90s stale gate
			// reads that value, so it must be the Bridge observation clock or a
			// dormant host reads as stale forever.
			await this.deps.recordDemand({ ...snapshot, observedAt: this.now() });
		} catch {
			// Helper failures are externally supplied and may contain paths/tokens.
			// Keep stderr on the closed diagnostic contract; the adapter records the
			// bounded health_store failure separately.
			console.warn("[voice-session] demand projection failed");
			return;
		}
		this.demandCursor = snapshot.nextCursor;
		if (!snapshot.hasMore) {
			this.lastDemandProjectionKey = projectionKey;
			this.lastDemandProjectionAtMs = projectionAtMs;
		}
	}

	private async provisionWithDeadline(sessionId: string): Promise<void> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error("voice_provision_timeout");
				reject(error);
				controller.abort(error);
			}, 30_000);
		});
		try {
			// The race releases the tick even if an injected effect ignores abort.
			// Promise.race also observes any rejection arriving after the deadline.
			await Promise.race([
				this.deps.provision(sessionId, controller.signal),
				deadline,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	start(): void {
		if (this.timer) return;
		if (this.deps.requestWake) {
			void this.wakeTick();
			this.wakeTimer = setInterval(() => {
				void this.wakeTick();
			}, this.deps.timing.pollIntervalMs);
			this.wakeTimer.unref?.();
		}
		void this.tick().catch((error) =>
			console.warn(
				`[voice-session] runtime tick failed: ${(error as Error).message}`,
			),
		);
		this.timer = setInterval(() => {
			void this.tick().catch((error) =>
				console.warn(
					`[voice-session] runtime tick failed: ${(error as Error).message}`,
				),
			);
		}, this.deps.timing.pollIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.wakeTimer) clearInterval(this.wakeTimer);
		this.timer = undefined;
		this.wakeTimer = undefined;
	}
}
