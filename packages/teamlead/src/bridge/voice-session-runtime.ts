import type { StateStore, VoiceSessionRow } from "../StateStore.js";
import type { BridgeConfig } from "./types.js";

type VoiceSessionTiming = NonNullable<BridgeConfig["voiceSessionTiming"]>;

export interface VoiceSessionRuntimeDeps {
	store: StateStore;
	timing: VoiceSessionTiming;
	now?: () => string;
	provision: (sessionId: string, signal: AbortSignal) => Promise<void>;
	poll: (session: VoiceSessionRow) => Promise<void>;
	reportPollFailure?: (
		session: VoiceSessionRow,
		reason: string,
	) => void | Promise<void>;
}

export class VoiceSessionRuntime {
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private readonly now: () => string;
	private readonly pollFailures = new Map<
		string,
		{ reason: string; nextAt: number; delayMs: number }
	>();

	constructor(private readonly deps: VoiceSessionRuntimeDeps) {
		this.now = deps.now ?? (() => new Date().toISOString());
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const at = this.now();
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
		} finally {
			this.ticking = false;
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
		this.timer = undefined;
	}
}
