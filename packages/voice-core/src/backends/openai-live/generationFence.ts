import { VoiceError } from "../../types.js";

/**
 * Connection generations are monotonic. Once a generation is tombstoned it
 * can never become current again, so late provider callbacks cannot revive an
 * interrupted turn.
 */
export class GenerationFence {
	private current: number | undefined;
	private highestSeen = 0;

	activate(generation: number): void {
		if (!Number.isSafeInteger(generation) || generation <= 0) {
			throw new VoiceError(
				"backend-protocol",
				`openai-live: generation must be a positive integer, got ${generation}`,
			);
		}
		if (generation <= this.highestSeen) {
			throw new VoiceError(
				"backend-protocol",
				`openai-live: generation must advance beyond ${this.highestSeen}`,
			);
		}
		this.highestSeen = generation;
		this.current = generation;
	}

	tombstone(generation: number): void {
		if (this.current === generation) this.current = undefined;
	}

	isCurrent(generation: number): boolean {
		return this.current === generation;
	}

	assertCurrent(generation: number): void {
		if (!this.isCurrent(generation)) {
			throw new VoiceError(
				"cancelled",
				`openai-live: generation ${generation} is fenced`,
			);
		}
	}

	async after<T>(generation: number, pending: Promise<T>): Promise<T> {
		this.assertCurrent(generation);
		const value = await pending;
		this.assertCurrent(generation);
		return value;
	}
}
