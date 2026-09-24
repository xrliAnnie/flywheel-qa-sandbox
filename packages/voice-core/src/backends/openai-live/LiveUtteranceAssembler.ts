import type { RoomUtteranceEvent } from "../../room-io.js";
import type { VoiceAttribution, VoiceUtterance } from "../../types.js";
import { VoiceError } from "../../types.js";

export interface LiveInputTranscriptDelta {
	generation: number;
	eventId?: string;
	startMs: number;
	endMs: number;
	delta: string;
}

export interface LiveDelegationSeal {
	generation: number;
	delegationId: string;
	offsetMs: number;
}

export interface LiveUtteranceAssemblerOptions {
	sessionId: string;
	generation: number;
	backendId: string;
}

interface ProviderGeneration {
	startedAt: number;
	deltas: LiveInputTranscriptDelta[];
	seenEventIds: Set<string>;
}

interface RoomWindow {
	utteranceId: string;
	attribution: VoiceAttribution;
	startedAt: number;
	endedAt?: number;
}

function validTime(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function overlaps(
	startA: number,
	endA: number,
	startB: number,
	endB: number,
): boolean {
	return startA <= endB && endA >= startB;
}

/**
 * Strictly binds OpenAI Live's connection-relative transcript offsets to the
 * RoomIO timeline. Provider ids remain metadata: the durable transcript id is
 * scoped by the voice session, resident generation, provider generation, and
 * RoomIO utterance id.
 */
export class LiveUtteranceAssembler {
	private readonly providers = new Map<number, ProviderGeneration>();
	private readonly windows = new Map<string, RoomWindow>();
	private readonly sealedWindows = new Set<string>();
	private sequence = 0;

	constructor(private readonly options: LiveUtteranceAssemblerOptions) {
		if (
			!options.sessionId ||
			!options.backendId ||
			!Number.isSafeInteger(options.generation) ||
			options.generation < 1
		) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: utterance assembler identity is invalid",
			);
		}
	}

	startProviderGeneration(generation: number, startedAt: number): void {
		if (
			!Number.isSafeInteger(generation) ||
			generation < 1 ||
			!validTime(startedAt)
		) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: provider generation timeline is invalid",
			);
		}
		const prior = this.providers.get(generation);
		if (prior) {
			if (prior.startedAt !== startedAt) {
				throw new VoiceError(
					"backend-protocol",
					`openai-live: provider generation ${generation} timeline changed`,
				);
			}
			return;
		}
		this.providers.set(generation, {
			startedAt,
			deltas: [],
			seenEventIds: new Set(),
		});
	}

	observeRoom(event: RoomUtteranceEvent): void {
		if (
			event.sessionId !== this.options.sessionId ||
			event.generation !== this.options.generation ||
			!event.utteranceId ||
			!validTime(event.observedAt)
		) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: RoomIO utterance identity is invalid",
			);
		}
		if (event.phase === "start") {
			if (this.windows.has(event.utteranceId)) {
				throw new VoiceError(
					"backend-protocol",
					`openai-live: duplicate RoomIO utterance ${event.utteranceId}`,
				);
			}
			// RoomIO owns a single active capture. A later start therefore proves
			// that any older open window was abandoned by a capture/lease failure
			// whose recovery path could not emit its matching end event.
			for (const [utteranceId, window] of this.windows) {
				if (window.endedAt === undefined) this.windows.delete(utteranceId);
			}
			this.windows.set(event.utteranceId, {
				utteranceId: event.utteranceId,
				attribution: event.attribution,
				startedAt: event.observedAt,
			});
			return;
		}
		const window = this.windows.get(event.utteranceId);
		if (
			!window ||
			window.endedAt !== undefined ||
			event.observedAt < window.startedAt
		) {
			throw new VoiceError(
				"backend-protocol",
				`openai-live: unmatched RoomIO utterance end ${event.utteranceId}`,
			);
		}
		window.endedAt = event.observedAt;
		if (
			JSON.stringify(window.attribution) !== JSON.stringify(event.attribution)
		) {
			window.attribution = {
				kind: "unknown",
				reason: "room_attribution_changed",
			};
		}
	}

	appendInput(delta: LiveInputTranscriptDelta): void {
		const provider = this.providers.get(delta.generation);
		if (
			!provider ||
			!validTime(delta.startMs) ||
			!validTime(delta.endMs) ||
			delta.endMs < delta.startMs ||
			!delta.delta
		) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: input transcript delta is invalid",
			);
		}
		if (delta.eventId) {
			if (provider.seenEventIds.has(delta.eventId)) return;
			provider.seenEventIds.add(delta.eventId);
		}
		provider.deltas.push({ ...delta });
	}

	delegationWindowState(
		input: LiveDelegationSeal,
	): "waiting" | "ready" | "unbound" {
		const { delegationAt } = this.delegationPoint(input);
		const containing = [...this.windows.values()].filter(
			(window) =>
				delegationAt >= window.startedAt &&
				(window.endedAt === undefined || delegationAt <= window.endedAt),
		);
		if (containing.some((window) => window.endedAt === undefined))
			return "waiting";
		return containing.length > 0 ? "ready" : "unbound";
	}

	sealDelegation(input: LiveDelegationSeal): VoiceUtterance {
		const { provider, delegationAt } = this.delegationPoint(input);
		const containing = [...this.windows.values()].filter(
			(window) =>
				delegationAt >= window.startedAt &&
				(window.endedAt === undefined || delegationAt <= window.endedAt),
		);
		const candidates = containing.filter(
			(window): window is RoomWindow & { endedAt: number } =>
				window.endedAt !== undefined,
		);
		const candidate =
			containing.length === 1 && candidates.length === 1
				? candidates[0]
				: undefined;
		const incomplete =
			containing.length === 1 && containing[0]?.endedAt === undefined
				? containing[0]
				: undefined;
		const relevantDeltas = provider.deltas.filter((delta) => {
			const absoluteStart = provider.startedAt + delta.startMs;
			const absoluteEnd = provider.startedAt + delta.endMs;
			if (candidate) {
				return overlaps(
					absoluteStart,
					absoluteEnd,
					candidate.startedAt,
					candidate.endedAt,
				);
			}
			if (incomplete) return absoluteEnd >= incomplete.startedAt;
			return absoluteStart <= delegationAt;
		});
		const intersectedWindows = new Set<string>();
		for (const delta of relevantDeltas) {
			const absoluteStart = provider.startedAt + delta.startMs;
			const absoluteEnd = provider.startedAt + delta.endMs;
			for (const window of this.windows.values()) {
				if (
					overlaps(
						absoluteStart,
						absoluteEnd,
						window.startedAt,
						window.endedAt ?? Number.POSITIVE_INFINITY,
					)
				) {
					intersectedWindows.add(window.utteranceId);
				}
			}
		}
		const uniquelyBound =
			candidate !== undefined &&
			intersectedWindows.size === 1 &&
			intersectedWindows.has(candidate.utteranceId);
		const attribution: VoiceAttribution = uniquelyBound
			? candidate.attribution
			: {
					kind: "unknown",
					reason:
						incomplete && intersectedWindows.size === 1
							? "room_utterance_incomplete"
							: containing.length > 1 || intersectedWindows.size > 1
								? "overlapping_room_utterances"
								: "delegation_not_uniquely_attributed",
				};
		if (candidate) this.sealedWindows.add(candidate.utteranceId);
		const utteranceId = uniquelyBound
			? candidate.utteranceId
			: `unknown:${input.generation}:${input.delegationId}`;
		const observedAt = uniquelyBound
			? candidate.endedAt
			: provider.startedAt +
				Math.max(input.offsetMs, ...relevantDeltas.map((delta) => delta.endMs));
		const timestamp = new Date(observedAt).toISOString();
		return {
			ts: timestamp,
			timestamp,
			sessionId: this.options.sessionId,
			generation: this.options.generation,
			sequence: ++this.sequence,
			transcriptId: `live:${this.options.sessionId}:${this.options.generation}:${input.generation}:${utteranceId}`,
			utteranceId,
			backendId: this.options.backendId,
			source: attribution.kind === "known" ? "founder" : "room",
			face: "converse",
			role: "user",
			text: relevantDeltas.map((delta) => delta.delta).join(""),
			final: true,
			attribution,
		};
	}

	/**
	 * Seal every ended RoomIO window that has provider input transcript and was
	 * not sealed before, oldest first. Non-delegated turns need this so the V1
	 * utterance stream carries the founder's own words (e.g. a spoken exit
	 * request) ahead of the frontend's answer. Attribution stays strict: a window
	 * is known only when none of its transcript also overlaps another window.
	 */
	sealEndedRoomUtterances(): VoiceUtterance[] {
		const sealed: VoiceUtterance[] = [];
		const ended = [...this.windows.values()]
			.filter(
				(window): window is RoomWindow & { endedAt: number } =>
					window.endedAt !== undefined &&
					!this.sealedWindows.has(window.utteranceId),
			)
			.sort((a, b) => a.startedAt - b.startedAt);
		for (const window of ended) {
			const relevant: Array<{
				generation: number;
				start: number;
				end: number;
				delta: string;
			}> = [];
			for (const [generation, provider] of this.providers) {
				for (const delta of provider.deltas) {
					const start = provider.startedAt + delta.startMs;
					const end = provider.startedAt + delta.endMs;
					if (overlaps(start, end, window.startedAt, window.endedAt)) {
						relevant.push({ generation, start, end, delta: delta.delta });
					}
				}
			}
			if (relevant.length === 0) continue;
			relevant.sort((a, b) => a.start - b.start);
			this.sealedWindows.add(window.utteranceId);
			const shared = relevant.some((delta) =>
				[...this.windows.values()].some(
					(other) =>
						other.utteranceId !== window.utteranceId &&
						overlaps(
							delta.start,
							delta.end,
							other.startedAt,
							other.endedAt ?? Number.POSITIVE_INFINITY,
						),
				),
			);
			const attribution: VoiceAttribution = shared
				? { kind: "unknown", reason: "overlapping_room_utterances" }
				: window.attribution;
			const timestamp = new Date(window.endedAt).toISOString();
			sealed.push({
				ts: timestamp,
				timestamp,
				sessionId: this.options.sessionId,
				generation: this.options.generation,
				sequence: ++this.sequence,
				transcriptId: `live:${this.options.sessionId}:${this.options.generation}:${relevant[0]?.generation}:${window.utteranceId}`,
				utteranceId: window.utteranceId,
				backendId: this.options.backendId,
				source: attribution.kind === "known" ? "founder" : "room",
				face: "converse",
				role: "user",
				text: relevant.map((delta) => delta.delta).join(""),
				final: true,
				attribution,
			});
		}
		return sealed;
	}

	private delegationPoint(input: LiveDelegationSeal): {
		provider: ProviderGeneration;
		delegationAt: number;
	} {
		const provider = this.providers.get(input.generation);
		if (!provider || !input.delegationId || !validTime(input.offsetMs)) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: delegation seal is invalid",
			);
		}
		return {
			provider,
			delegationAt: provider.startedAt + input.offsetMs,
		};
	}
}
