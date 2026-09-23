import type {
	DiscordReceivePolicy,
	DiscordReceiveRuntimeDiagnostic,
} from "../bots/discordWiring.js";
import type { ReceiveHealth, ReceiveReason } from "flywheel-voice-core";

const PCM_FRAMES_FOR_HEALTH = 10;

export const VOICE_CODEX_RECEIVE_POLICY = {
	daveEncryption: true,
	decryptionFailureTolerance: 36,
	debug: true,
} as const satisfies DiscordReceivePolicy;

export function voiceReceiveRuntimeEvidence(input: {
	observedAt: string;
	buildSha: string | null;
	runtime: DiscordReceiveRuntimeDiagnostic;
}) {
	return {
		ts: input.observedAt,
		kind: "voice_receive_runtime",
		buildSha: input.buildSha,
		...input.runtime,
	};
}

export function classifyReceiveFailure(error: Error): ReceiveReason {
	return /^(?:Failed to decrypt:|DecryptionFailed\()/u.test(error.message)
		? "dave_decrypt"
		: "receive_packet";
}

function increment(value: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

export class ReceiveHealthTracker {
	private snapshot: ReceiveHealth = {
		version: 1,
		sequence: 1,
		state: "unknown",
		reason: "awaiting_audio",
		failures: 0,
		retries: 0,
		lastPcmAt: null,
	};
	private consecutivePcmFrames = 0;
	private readonly now: () => Date;

	constructor(
		private readonly options: {
			now?: () => Date;
			onChange?(snapshot: ReceiveHealth): void;
		} = {},
	) {
		this.now = options.now ?? (() => new Date());
	}

	current(): ReceiveHealth {
		return { ...this.snapshot };
	}

	fail(channel: "packet" | "decoder", error: Error): ReceiveHealth {
		this.consecutivePcmFrames = 0;
		return this.update({
			state: "degraded",
			reason:
				channel === "decoder" ? "opus_decode" : classifyReceiveFailure(error),
			failures: increment(this.snapshot.failures),
		});
	}

	noPcm(): ReceiveHealth {
		this.consecutivePcmFrames = 0;
		return this.update({
			state: "degraded",
			reason: "receive_no_pcm",
			failures: increment(this.snapshot.failures),
		});
	}

	retryAttempt(): ReceiveHealth {
		return this.update({ retries: increment(this.snapshot.retries) });
	}

	exhausted(): ReceiveHealth {
		this.consecutivePcmFrames = 0;
		return this.update({ state: "degraded", reason: "retry_exhausted" });
	}

	pcmFrame(): ReceiveHealth | undefined {
		this.consecutivePcmFrames += 1;
		if (this.consecutivePcmFrames !== PCM_FRAMES_FOR_HEALTH) return undefined;
		return this.update({
			state: "receiving",
			reason: "audio_observed",
			lastPcmAt: this.now().toISOString(),
		});
	}

	private update(changes: Partial<ReceiveHealth>): ReceiveHealth {
		this.snapshot = {
			...this.snapshot,
			...changes,
			sequence: increment(this.snapshot.sequence),
		};
		const next = this.current();
		this.options.onChange?.(next);
		return next;
	}
}
