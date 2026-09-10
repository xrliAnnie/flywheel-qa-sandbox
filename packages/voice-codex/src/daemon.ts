import type {
	VoiceOutboundItem,
	VoiceSessionProjection,
} from "./bridge-client.js";
import { BridgeVoiceHttpError, VoiceLease } from "./bridge-client.js";
import type { SavedVoiceSession } from "./session-state.js";
import { chunkForSpeech } from "./speech.js";

export type VoiceEnd =
	| { kind: "ended"; reason: "she-left" | "text-stop" | "voice-stop" }
	| { kind: "failed"; reason: string };

export interface ActiveVoiceSession {
	start(): Promise<{ founderPresent: boolean }>;
	waitForFounder(timeoutMs: number): Promise<boolean>;
	markLive(): Promise<void>;
	waitForEnd(): Promise<VoiceEnd>;
	requestEnd(outcome: VoiceEnd): void;
	speak(text: string): Promise<"confirmed" | "unconfirmed" | "failed">;
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
	list(): SavedVoiceSession[];
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
	createSession(context: VoiceSessionContext): ActiveVoiceSession;
	recoverSession(
		saved: SavedVoiceSession,
		authority?: VoiceLease,
	): Promise<number>;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	timing: {
		idlePollMs: number;
		leaseRenewMs: number;
		leaseMissMax: number;
		presenceGraceMs: number;
		speechChunkTokens: number;
	};
}

function authorityLost(error: unknown): boolean {
	return (
		(error instanceof Error && error.message === "voice_lease_fenced") ||
		(error instanceof BridgeVoiceHttpError && error.status === 409)
	);
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
		session: ActiveVoiceSession,
		private readonly options: VoiceDaemonOptions,
	) {
		void session.waitForEnd().then((outcome) => this.finish(outcome));
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
			);
			if (this.disposed || this.outcome) return;
			this.missed = 0;
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

	constructor(private readonly options: VoiceDaemonOptions) {}

	async run(): Promise<void> {
		await this.recover();
		while (!this.stopping) {
			try {
				await this.runOnce();
			} catch (error) {
				console.error(
					`[voice] daemon iteration failed: ${(error as Error).message}`,
				);
				await this.options.sleep(this.options.timing.idlePollMs);
			}
		}
	}

	shutdown(): void {
		this.stopping = true;
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
			const abandonedCount = await this.options.recoverSession(
				saved,
				authority,
			);
			try {
				await this.options.bridge.setState(
					saved.sessionId,
					saved.leaseToken,
					authority ?? new VoiceLease(() => Number.POSITIVE_INFINITY),
					"failed",
					"daemon_restart",
					abandonedCount,
				);
			} catch (error) {
				// A final rejection (including an already-swept lease) cannot be
				// retried with this saved authority. Preserve it only for retries.
				if (
					!(error instanceof BridgeVoiceHttpError) ||
					error.status < 400 ||
					error.status >= 500 ||
					error.status === 408 ||
					error.status === 429
				)
					throw error;
			}
			this.options.stateStore.remove(saved.sessionId);
		}
	}

	async runOnce(): Promise<string> {
		const desired = await this.options.bridge.desired();
		if (!desired) {
			await this.options.sleep(this.options.timing.idlePollMs);
			return "idle";
		}
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
		this.options.stateStore.save({
			sessionId: context.sessionId,
			leaseToken: context.leaseToken,
			projection: context.projection,
		});
		let session: ActiveVoiceSession;
		try {
			session = this.options.createSession(context);
		} catch (error) {
			const reason = (error as Error).message || "session_create_failed";
			await this.options.bridge.setState(
				context.sessionId,
				context.leaseToken,
				context.lease,
				"failed",
				reason,
			);
			this.options.stateStore.remove(context.sessionId);
			return reason;
		}
		this.current = session;
		let outcome: VoiceEnd = { kind: "failed", reason: "session_start_failed" };
		const lifetime = new SessionLifetime(context, session, this.options);
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
			if (error instanceof SessionEnded) outcome = error.outcome;
			else {
				context.lease.fence();
				outcome = {
					kind: "failed",
					reason: authorityLost(error)
						? "lease_lost"
						: (error as Error).message || "session_failed",
				};
			}
		} finally {
			lifetime.dispose();
			await session.stop(outcome).catch(() => undefined);
			try {
				await this.options.bridge.setState(
					context.sessionId,
					context.leaseToken,
					context.lease,
					outcome.kind === "ended" ? "ended" : "failed",
					outcome.reason,
				);
				this.options.stateStore.remove(context.sessionId);
			} finally {
				if (this.current === session) this.current = undefined;
			}
		}
		return outcome.reason;
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
			let status: "confirmed" | "unconfirmed" | "failed" | "dropped" =
				"confirmed";
			try {
				for (const chunk of chunkForSpeech(
					item.text,
					this.options.timing.speechChunkTokens,
				)) {
					context.lease.assert();
					const spoken = await lifetime.wait(() => session.speak(chunk));
					if (spoken === "failed") status = "failed";
					else if (spoken === "unconfirmed" && status === "confirmed") {
						status = "unconfirmed";
					}
				}
			} catch (error) {
				if (error instanceof SessionEnded || authorityLost(error)) throw error;
				status = "failed";
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
