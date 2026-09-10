// Speaking epochs adapted from Raya 0f77e97 TranscriptLog.ts.
// FLY-2446 Lead ruling c4ba872b-6b0d-4b9c-8029-f39284d89ae7 removes
// expiry: retain unconsumed owners until a final, rejecting mixed owners.
// Each instance belongs to one room connection; reconnect starts fresh.
interface SpeakingEpoch {
	ownerUserId: string;
	startedAt: number;
	endedAt?: number;
}

function finiteTimestamp(value: number): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("timestamp must be non-negative and finite");
	}
}

export class SpeakerAttribution {
	private epochs: SpeakingEpoch[] = [];

	speakingStart(ownerUserId: string, startedAt: number): void {
		if (!ownerUserId) throw new Error("speaking owner is required");
		finiteTimestamp(startedAt);
		this.epochs.push({ ownerUserId, startedAt });
	}

	speakingEnd(ownerUserId: string, endedAt: number): void {
		finiteTimestamp(endedAt);
		for (let index = this.epochs.length - 1; index >= 0; index -= 1) {
			const epoch = this.epochs[index];
			if (epoch?.ownerUserId === ownerUserId && epoch.endedAt === undefined) {
				epoch.endedAt = Math.max(endedAt, epoch.startedAt);
				return;
			}
		}
	}

	consumeOwner(atMs: number): string | null {
		finiteTimestamp(atMs);
		const owners = new Set(
			this.epochs
				.filter((epoch) => epoch.startedAt <= atMs)
				.map((epoch) => epoch.ownerUserId),
		);
		// Final consumption clears ended epochs even when ownership is ambiguous.
		// Active speech can produce further finals before its speaking-end event.
		this.epochs = this.epochs.filter(
			(epoch) => epoch.endedAt === undefined || epoch.endedAt > atMs,
		);
		return owners.size === 1 ? (owners.values().next().value ?? null) : null;
	}
}
