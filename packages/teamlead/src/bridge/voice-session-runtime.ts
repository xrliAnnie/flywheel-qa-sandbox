import type { StateStore, VoiceSessionRow } from "../StateStore.js";
import type { BridgeConfig } from "./types.js";

type VoiceSessionTiming = NonNullable<BridgeConfig["voiceSessionTiming"]>;

export interface VoiceSessionRuntimeDeps {
	store: StateStore;
	timing: VoiceSessionTiming;
	now?: () => string;
	provision: (sessionId: string) => Promise<void>;
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
				await this.deps.provision(session.sessionId);
			}
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
				try {
					await this.deps.poll(session);
				} catch (error) {
					await this.deps.reportPollFailure?.(
						session,
						(error as Error).message,
					);
				}
			}
		} finally {
			this.ticking = false;
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
