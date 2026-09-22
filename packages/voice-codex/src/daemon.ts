import type { ReceiveHealth } from "flywheel-voice-core";
import type {
	VoiceBridgeRequestDiagnostic,
	VoiceOutboundItem,
	VoiceSessionProjection,
} from "./bridge-client.js";
import {
	BridgeVoiceHttpError,
	BridgeVoiceRequestError,
	type VoiceLease,
} from "./bridge-client.js";
import type {
	VoiceHealthObservation,
	VoiceHealthObserver,
	VoiceHealthOperation,
	VoiceHealthReasonClass,
} from "./health.js";
import type {
	SavedVoiceSession,
	VoiceRecoveryRecord,
} from "./session-state.js";
import { type PreparedSpeech, prepareReplySpeech } from "./speech.js";

export type VoiceEnd =
	| {
			kind: "ended";
			reason:
				| "she-left"
				| "text-stop"
				| "voice-stop"
				| "realtime_session_expiring"
				| "realtime_capacity";
	  }
	| { kind: "failed"; reason: string };

export type VoiceDaemonIterationResult =
	| { kind: "idle_success" }
	| {
			kind: "daemon_stopped";
			sessionId: string;
			reason: "daemon_shutdown";
	  }
	| {
			kind: "session_ended";
			sessionId: string;
			reason: Extract<VoiceEnd, { kind: "ended" }>["reason"];
	  }
	| {
			kind: "session_failed";
			sessionId: string;
			reason: string;
	  };

export interface ActiveVoiceSession {
	receiveHealth(): ReceiveHealth | undefined;
	start(): Promise<{ founderPresent: boolean }>;
	waitForFounder(timeoutMs: number): Promise<boolean>;
	markLive(): Promise<void>;
	waitForEnd(): Promise<VoiceEnd>;
	requestEnd(outcome: VoiceEnd): void;
	speak(
		speech: PreparedSpeech,
	): Promise<"confirmed" | "unconfirmed" | "failed">;
	notify?(text: string): void | Promise<void>;
	stop(outcome?: VoiceEnd): Promise<void>;
}

interface VoiceDaemonBridge {
	desired(): Promise<{ sessionId: string } | null>;
	claim(
		sessionId: string,
		daemonBootId: string,
	): Promise<{
		lease: VoiceLease;
		leaseToken: string;
		leaseExpiresAt: string;
		projection: VoiceSessionProjection;
	}>;
	renew(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
		receiveHealth?: ReceiveHealth,
	): Promise<{
		state: string;
		leaseExpiresAt: string;
	}>;
	renewRecovered(
		sessionId: string,
		leaseToken: string,
	): Promise<{
		state: string;
		leaseExpiresAt: string;
		lease: VoiceLease;
	}>;
	setState(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
		state: "warming" | "live" | "ended" | "failed",
		reason?: string,
		abandonedCount?: number,
	): Promise<void>;
	outbound(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<VoiceOutboundItem[]>;
	claimOutbound(
		sessionId: string,
		seq: number,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<string>;
	receipt(
		sessionId: string,
		seq: number,
		leaseToken: string,
		lease: VoiceLease,
		attemptToken: string,
		status: "confirmed" | "unconfirmed" | "failed" | "dropped",
	): Promise<void>;
}

interface VoiceSessionStore {
	save(session: SavedVoiceSession): void;
	list(): VoiceRecoveryRecord[];
	quarantine(sessionId: string): void;
	remove(sessionId: string): void;
}

export interface VoiceSessionContext {
	sessionId: string;
	leaseToken: string;
	lease: VoiceLease;
	projection: VoiceSessionProjection;
}

export interface VoiceDaemonOptions {
	bridge: VoiceDaemonBridge;
	stateStore: VoiceSessionStore;
	bootId: string;
	createSession(
		context: VoiceSessionContext,
	): ActiveVoiceSession | Promise<ActiveVoiceSession>;
	recoverSession(
		saved: VoiceRecoveryRecord,
		authority?: VoiceLease,
	): Promise<number>;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	health?: VoiceHealthObserver;
	now?: () => Date;
	monotonicNow?: () => number;
	timing: {
		idlePollMs: number;
		leaseRenewMs: number;
		leaseMissMax: number;
		presenceGraceMs: number;
		speechChunkTokens: number;
	};
}

function safelyObserveHealth(
	options: VoiceDaemonOptions,
	observation: VoiceHealthObservation,
): void {
	try {
		options.health?.observe(observation);
	} catch {
		console.error(
			"[voice] health observation unavailable reasonClass=health_observation_unavailable operation=health_store",
		);
	}
}

function authorityLost(error: unknown): boolean {
	const diagnostic = bridgeRequestDiagnostic(error);
	return (
		(error instanceof Error && error.message === "voice_lease_fenced") ||
		(error instanceof BridgeVoiceHttpError && error.status === 409) ||
		diagnostic?.status === 409
	);
}

function bridgeRequestDiagnostic(
	error: unknown,
): VoiceBridgeRequestDiagnostic | undefined {
	if (error instanceof BridgeVoiceRequestError) return error.diagnostic;
	if (error instanceof BridgeVoiceHttpError) return error.diagnostic;
	return undefined;
}

class SessionEnded extends Error {
	constructor(readonly outcome: VoiceEnd) {
		super(outcome.reason);
	}
}

/** One supervisor spans warming, presence, outbound IO and live idle time. */
class SessionLifetime {
	private outcome?: VoiceEnd;
	private resolveEnd!: (outcome: VoiceEnd) => void;
	private readonly ended = new Promise<VoiceEnd>((resolve) => {
		this.resolveEnd = resolve;
	});
	private renewTimer?: ReturnType<typeof setTimeout>;
	private deadlineTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private missed = 0;

	constructor(
		private readonly context: VoiceSessionContext,
		private readonly session: ActiveVoiceSession,
		private readonly options: VoiceDaemonOptions,
		private readonly onRenewProgress?: (observedAt: string) => void,
	) {
		void this.session.waitForEnd().then((outcome) => this.finish(outcome));
		this.armDeadline();
		this.scheduleRenew();
	}

	private finish(outcome: VoiceEnd): void {
		if (this.outcome || this.disposed) return;
		this.outcome = outcome;
		if (outcome.kind === "failed") this.context.lease.fence();
		this.resolveEnd(outcome);
	}

	private armDeadline(): void {
		if (this.disposed || this.outcome) return;
		try {
			this.context.lease.assert();
		} catch {
			this.finish({ kind: "failed", reason: "lease_lost" });
			return;
		}
		this.deadlineTimer = setTimeout(
			() => this.armDeadline(),
			this.context.lease.remainingMs,
		);
		this.deadlineTimer.unref?.();
	}

	private scheduleRenew(): void {
		if (this.disposed || this.outcome) return;
		this.renewTimer = setTimeout(() => {
			void this.renew();
		}, this.options.timing.leaseRenewMs);
		this.renewTimer.unref?.();
	}

	private async renew(): Promise<void> {
		try {
			const result = await this.options.bridge.renew(
				this.context.sessionId,
				this.context.leaseToken,
				this.context.lease,
				this.session.receiveHealth(),
			);
			if (this.disposed || this.outcome) return;
			this.missed = 0;
			if (["claimed", "warming", "live"].includes(result.state)) {
				const observedAt = (this.options.now?.() ?? new Date()).toISOString();
				safelyObserveHealth(this.options, {
					kind: "progress",
					observedAt,
				});
				if (result.state === "live") {
					try {
						this.onRenewProgress?.(observedAt);
					} catch {
						// Proof observations cannot block renewal or session work.
					}
				}
			}
			if (result.state === "ending")
				this.finish({ kind: "ended", reason: "text-stop" });
			else if (!["claimed", "warming", "live"].includes(result.state))
				this.finish({ kind: "failed", reason: "lease_lost" });
		} catch (error) {
			if (
				authorityLost(error) ||
				++this.missed >= this.options.timing.leaseMissMax
			)
				this.finish({ kind: "failed", reason: "lease_lost" });
		}
		this.scheduleRenew();
	}

	assert(): void {
		if (this.outcome) throw new SessionEnded(this.outcome);
		this.context.lease.assert();
	}

	async wait<T>(operation: () => Promise<T>): Promise<T> {
		this.assert();
		const result = await Promise.race([
			operation(),
			this.ended.then((outcome) => {
				throw new SessionEnded(outcome);
			}),
		]);
		this.assert();
		return result;
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.renewTimer);
		clearTimeout(this.deadlineTimer);
	}
}

export class VoiceDaemon {
	private stopping = false;
	private current?: ActiveVoiceSession;
	private readonly sleepController = new AbortController();

	constructor(private readonly options: VoiceDaemonOptions) {}

	async run(): Promise<void> {
		await this.recover();
		let consecutivePollFailures = 0;
		let stoppedObserved = false;
		while (!this.stopping) {
			const startedAt = this.monotonicNow();
			try {
				const result = await this.runOnce();
				if (result.kind === "idle_success") {
					consecutivePollFailures = 0;
					this.observeHealth({
						kind: "idle_success",
						observedAt: this.nowIso(),
						durationMs: Math.max(
							0,
							Math.round(this.monotonicNow() - startedAt),
						),
					});
					await this.options.sleep(
						this.options.timing.idlePollMs,
						this.sleepController.signal,
					);
				} else if (result.kind === "daemon_stopped") {
					this.observeHealth({
						kind: "daemon_stopped",
						observedAt: this.nowIso(),
					});
					stoppedObserved = true;
				} else {
					consecutivePollFailures = 0;
				}
			} catch (error) {
				consecutivePollFailures += 1;
				const failure = this.pollFailure(error, startedAt);
				this.observeHealth(failure);
				console.error(
					`[voice] daemon iteration failed reasonClass=${failure.reasonClass} operation=${failure.operation}`,
				);
				await this.options.sleep(
					[5_000, 10_000, 20_000, 30_000][
						Math.min(consecutivePollFailures - 1, 3)
					]!,
					this.sleepController.signal,
				);
			}
		}
		if (!stoppedObserved)
			this.observeHealth({
				kind: "daemon_stopped",
				observedAt: this.nowIso(),
			});
	}

	shutdown(): void {
		this.stopping = true;
		this.sleepController.abort();
		this.current?.requestEnd({ kind: "failed", reason: "daemon_shutdown" });
	}

	async recover(): Promise<void> {
		for (const saved of this.options.stateStore.list()) {
			let authority: VoiceLease | undefined;
			try {
				const recovered = await this.options.bridge.renewRecovered(
					saved.sessionId,
					saved.leaseToken,
				);
				if (["claimed", "warming", "live"].includes(recovered.state)) {
					authority = recovered.lease;
				} else {
					recovered.lease.fence();
				}
			} catch {
				// A rejected stale lease carries no delivery authority.
			}
			let abandonedCount: number | undefined;
			let reason = "daemon_restart";
			try {
				abandonedCount = await this.options.recoverSession(saved, authority);
			} catch {
				reason = "voice_recovery_failed";
				console.error(
					"[voice] local recovery failed; retaining quarantined evidence",
				);
			}
			if (authority) {
				try {
					authority.assert();
					await this.options.bridge.setState(
						saved.sessionId,
						saved.leaseToken,
						authority,
						"failed",
						reason,
						abandonedCount,
					);
				} catch {
					// No delivery retries on restart. The exact Bridge row expires normally.
					console.error(
						"[voice] recovery terminal receipt unavailable; awaiting lease expiry",
					);
				}
			}
			try {
				this.options.stateStore.quarantine(saved.sessionId);
			} catch {
				console.error("[voice] recovery quarantine failed; evidence retained");
			}
		}
	}

	async runOnce(): Promise<VoiceDaemonIterationResult> {
		const desired = await this.options.bridge.desired();
		if (!desired) return { kind: "idle_success" };
		const claimed = await this.options.bridge.claim(
			desired.sessionId,
			this.options.bootId,
		);
		const context: VoiceSessionContext = {
			sessionId: desired.sessionId,
			leaseToken: claimed.leaseToken,
			lease: claimed.lease,
			projection: claimed.projection,
		};
		let session: ActiveVoiceSession;
		try {
			this.options.stateStore.save({
				sessionId: context.sessionId,
				leaseToken: context.leaseToken,
				projection: context.projection,
			});
			session = await this.options.createSession(context);
			if (this.stopping) {
				await session.stop();
				throw new Error("daemon_shutdown");
			}
		} catch {
			const reason = this.stopping
				? "daemon_shutdown"
				: "session_create_failed";
			if (reason === "session_create_failed")
				this.observeSessionFailure(context, reason, "session_create");
			let terminalConfirmed = false;
			try {
				await this.options.bridge.setState(
					context.sessionId,
					context.leaseToken,
					context.lease,
					"failed",
					reason,
				);
				terminalConfirmed = true;
			} catch {
				console.error(
					"[voice] session terminal receipt unavailable; recovery state retained",
				);
			}
			if (terminalConfirmed) this.options.stateStore.remove(context.sessionId);
			return this.stopping && reason === "daemon_shutdown"
				? {
						kind: "daemon_stopped",
						sessionId: context.sessionId,
						reason,
					}
				: {
						kind: "session_failed",
						sessionId: context.sessionId,
						reason,
					};
		}
		this.current = session;
		let outcome: VoiceEnd = { kind: "failed", reason: "session_start_failed" };
		let failureClassification:
			| {
					reasonClass: VoiceHealthReasonClass;
					operation: VoiceHealthOperation;
			  }
			| undefined;
		let liveAt: string | undefined;
		let renewAt: string | undefined;
		let recoveryObserved = false;
		const lifetime = new SessionLifetime(
			context,
			session,
			this.options,
			(observedAt) => {
				if (
					!liveAt ||
					recoveryObserved ||
					Date.parse(observedAt) <= Date.parse(liveAt)
				)
					return;
				renewAt = observedAt;
				recoveryObserved = true;
				this.observeHealth({
					kind: "session_recovered",
					observedAt,
					demandId: this.demandId(context),
					successorAttemptId: context.sessionId,
					liveAt,
					renewAt,
				});
			},
		);
		try {
			await lifetime.wait(() =>
				this.options.bridge.setState(
					context.sessionId,
					context.leaseToken,
					context.lease,
					"warming",
				),
			);
			context.lease.assert();
			const started = await lifetime.wait(() => session.start());
			const founderPresent =
				started.founderPresent ||
				(await lifetime.wait(() =>
					session.waitForFounder(this.options.timing.presenceGraceMs),
				));
			if (!founderPresent) {
				outcome = { kind: "failed", reason: "no_human" };
			} else {
				await lifetime.wait(() =>
					this.options.bridge.setState(
						context.sessionId,
						context.leaseToken,
						context.lease,
						"live",
					),
				);
				await lifetime.wait(() => session.markLive());
				liveAt = this.nowIso();
				for (;;) {
					await this.deliverOutbound(context, session, lifetime);
					await lifetime.wait(
						() =>
							new Promise<void>((resolve) => {
								const timer = setTimeout(
									resolve,
									this.options.timing.leaseRenewMs,
								);
								timer.unref?.();
							}),
					);
				}
			}
		} catch (error) {
			if (error instanceof SessionEnded) {
				outcome = error.outcome;
			} else if (authorityLost(error)) {
				context.lease.fence();
				const diagnostic = bridgeRequestDiagnostic(error);
				outcome = {
					kind: "failed",
					reason: "lease_lost",
				};
				failureClassification = {
					reasonClass: "lease_lost",
					operation: diagnostic?.operation ?? "renew",
				};
			} else {
				context.lease.fence();
				const diagnostic = bridgeRequestDiagnostic(error);
				if (diagnostic) {
					outcome = { kind: "failed", reason: diagnostic.reasonClass };
					failureClassification = {
						reasonClass: diagnostic.reasonClass,
						operation: diagnostic.operation,
					};
				} else {
					outcome = {
						kind: "failed",
						reason: (error as Error).message || "session_failed",
					};
				}
			}
			if (outcome.kind === "failed" && !failureClassification) {
				outcome = {
					kind: "failed",
					reason: this.safeRuntimeReason(outcome.reason),
				};
				if (outcome.reason !== "daemon_shutdown")
					failureClassification = {
						reasonClass:
							outcome.reason === "lease_lost"
								? "lease_lost"
								: "session_runtime_failed",
						operation:
							outcome.reason === "lease_lost" ? "renew" : "session_runtime",
					};
			}
		} finally {
			lifetime.dispose();
		}
		const result: VoiceDaemonIterationResult =
			this.stopping &&
			outcome.kind === "failed" &&
			outcome.reason === "daemon_shutdown"
				? {
						kind: "daemon_stopped",
						sessionId: context.sessionId,
						reason: "daemon_shutdown",
					}
				: outcome.kind === "ended"
					? {
							kind: "session_ended",
							sessionId: context.sessionId,
							reason: outcome.reason,
						}
					: {
							kind: "session_failed",
							sessionId: context.sessionId,
							reason: outcome.reason,
						};
		if (result.kind === "session_failed" && result.reason !== "no_human")
			this.observeSessionFailure(
				context,
				failureClassification?.reasonClass ?? "session_runtime_failed",
				failureClassification?.operation ?? "session_runtime",
			);
		if (result.kind === "session_ended" && liveAt && renewAt)
			this.observeHealth({
				kind: "session_ended",
				observedAt: this.nowIso(),
				demandId: this.demandId(context),
				successorAttemptId: context.sessionId,
				liveAt,
				renewAt,
			});

		await session.stop(outcome).catch(() => undefined);
		let terminalConfirmed = false;
		try {
			await this.options.bridge.setState(
				context.sessionId,
				context.leaseToken,
				context.lease,
				outcome.kind === "ended" ? "ended" : "failed",
				outcome.reason,
			);
			terminalConfirmed = true;
		} catch {
			console.error(
				"[voice] session terminal receipt unavailable; recovery state retained",
			);
		} finally {
			if (this.current === session) this.current = undefined;
		}
		if (terminalConfirmed) this.options.stateStore.remove(context.sessionId);
		return result;
	}

	private nowIso(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}

	private monotonicNow(): number {
		return this.options.monotonicNow?.() ?? performance.now();
	}

	private safeRuntimeReason(reason: string): string {
		if (["daemon_shutdown", "lease_lost", "no_human"].includes(reason))
			return reason;
		return "session_runtime_failed";
	}

	private observeSessionFailure(
		context: VoiceSessionContext,
		reasonClass: VoiceHealthReasonClass,
		operation: VoiceHealthOperation,
	): void {
		this.observeHealth({
			kind: "session_failed",
			observedAt: this.nowIso(),
			reasonClass,
			operation,
			demandId: this.demandId(context),
			attemptId: context.sessionId,
		});
	}

	private demandId(context: VoiceSessionContext): string {
		return context.projection.mode === "meeting" && context.projection.meetingId
			? context.projection.meetingId
			: context.sessionId;
	}

	private observeHealth(observation: VoiceHealthObservation): void {
		safelyObserveHealth(this.options, observation);
	}

	private pollFailure(
		error: unknown,
		startedAt: number,
	): Extract<VoiceHealthObservation, { kind: "poll_failed" }> {
		const diagnostic = bridgeRequestDiagnostic(error);
		if (diagnostic)
			return {
				kind: "poll_failed",
				observedAt: this.nowIso(),
				durationMs: diagnostic.elapsedMs,
				reasonClass: diagnostic.reasonClass,
				operation: diagnostic.operation,
			};
		return {
			kind: "poll_failed",
			observedAt: this.nowIso(),
			durationMs: Math.max(0, Math.round(this.monotonicNow() - startedAt)),
			reasonClass: "unknown_failure",
			operation: "desired",
		};
	}

	private async deliverOutbound(
		context: VoiceSessionContext,
		session: ActiveVoiceSession,
		lifetime: SessionLifetime,
	): Promise<void> {
		let items: VoiceOutboundItem[];
		try {
			items = await lifetime.wait(() =>
				this.options.bridge.outbound(
					context.sessionId,
					context.leaseToken,
					context.lease,
				),
			);
		} catch (error) {
			if (error instanceof SessionEnded || authorityLost(error)) throw error;
			return;
		}
		for (const item of items) {
			let attemptToken: string;
			try {
				attemptToken = await lifetime.wait(() =>
					this.options.bridge.claimOutbound(
						context.sessionId,
						item.seq,
						context.leaseToken,
						context.lease,
					),
				);
			} catch (error) {
				if (error instanceof SessionEnded || authorityLost(error)) throw error;
				continue;
			}
			const speeches = prepareReplySpeech(
				item.text,
				this.options.timing.speechChunkTokens,
			);
			let status: "confirmed" | "unconfirmed" | "failed" | "dropped" =
				speeches.length === 0 ? "dropped" : "confirmed";
			try {
				if (speeches.length === 0) {
					context.lease.assert();
					await lifetime.wait(() =>
						Promise.resolve(session.notify?.("📻 没有可朗读内容，请看文字")),
					);
				}
				for (const speech of speeches) {
					context.lease.assert();
					const spoken = await lifetime.wait(() => session.speak(speech));
					if (spoken === "failed") status = "failed";
					else if (spoken === "unconfirmed" && status === "confirmed") {
						status = "unconfirmed";
					}
				}
			} catch (error) {
				if (error instanceof SessionEnded || authorityLost(error)) throw error;
				status = speeches.length === 0 ? "dropped" : "failed";
			}
			for (let receiptAttempt = 0; receiptAttempt < 2; receiptAttempt += 1) {
				try {
					await lifetime.wait(() =>
						this.options.bridge.receipt(
							context.sessionId,
							item.seq,
							context.leaseToken,
							context.lease,
							attemptToken,
							status,
						),
					);
					break;
				} catch (error) {
					if (error instanceof SessionEnded || authorityLost(error))
						throw error;
				}
			}
		}
	}
}
