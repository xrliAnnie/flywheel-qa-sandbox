import type { VoiceUtterance, VoiceV1Session } from "flywheel-voice-core";

export interface LiveCaption {
	label: "🤖 前台" | "💬 Lead";
	renderedText: string;
	text: string;
	source: string;
	timestamp: string;
	generation: number;
	sequence: number;
	final: boolean;
	interrupted: boolean;
}

export interface CaptionSink {
	caption(value: LiveCaption): void;
}

export interface LiveCaptionProjectionOptions {
	session: Pick<VoiceV1Session, "onUtterance">;
	sink: CaptionSink;
	record(event: Record<string, unknown>): void;
}

// TODO(FLY-2796): production composition injects the HeadphoneSession
// utterance stream and the room TIV CaptionSink at this seam.

/** Maps trusted Engine A assistant origins to explicit founder-visible labels.
 * The source field, never the text, decides whether a line is Frontend or Lead. */
export class LiveCaptionProjection {
	private unsubscribe?: () => void;
	private started = false;
	private closed = false;

	constructor(private readonly options: LiveCaptionProjectionOptions) {}

	start(): void {
		if (this.started || this.closed)
			throw new Error("live_caption_already_started");
		this.started = true;
		this.unsubscribe = this.options.session.onUtterance((utterance) =>
			this.project(utterance),
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private project(utterance: VoiceUtterance): void {
		if (this.closed || utterance.role !== "assistant") return;
		let label: LiveCaption["label"] | undefined;
		if (utterance.source === "frontend") {
			label = "🤖 前台";
		} else if (utterance.source.startsWith("lead:")) {
			const leadId = utterance.source.slice("lead:".length);
			if (
				leadId &&
				utterance.attribution.kind === "known" &&
				utterance.attribution.speakerUserId === leadId
			) {
				label = "💬 Lead";
			}
		}
		if (!label) {
			this.options.record({
				kind: "live_caption_source_rejected",
				source: utterance.source,
				transcriptId: utterance.transcriptId,
			});
			return;
		}
		try {
			this.options.sink.caption({
				label,
				renderedText: `${label}：${utterance.text}`,
				text: utterance.text,
				source: utterance.source,
				timestamp: utterance.timestamp,
				generation: utterance.generation,
				sequence: utterance.sequence,
				final: utterance.final,
				interrupted: utterance.interrupted === true,
			});
		} catch (error) {
			this.options.record({
				kind: "live_caption_sink_failed",
				transcriptId: utterance.transcriptId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
