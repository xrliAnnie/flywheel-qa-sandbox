import type { VoiceUtterance, VoiceV1Session } from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import { LiveCaptionProjection } from "../live-caption-projection.js";

function utterance(
	source: string,
	overrides: Partial<VoiceUtterance> = {},
): VoiceUtterance {
	return {
		ts: "2026-09-24T09:00:00.000Z",
		timestamp: "2026-09-24T09:00:00.000Z",
		sessionId: "voice-session",
		generation: 9,
		sequence: 3,
		transcriptId: "transcript-3",
		utteranceId: "utterance-3",
		backendId: "openai-live",
		source,
		face: "converse",
		role: "assistant",
		text: "马上处理",
		final: true,
		attribution: { kind: "unknown", reason: "assistant_output" },
		...overrides,
	};
}

function session() {
	let listener: ((value: VoiceUtterance) => void) | undefined;
	const unsubscribe = vi.fn();
	return {
		session: {
			onUtterance: vi.fn((next: (value: VoiceUtterance) => void) => {
				listener = next;
				return unsubscribe;
			}),
		} as Pick<VoiceV1Session, "onUtterance">,
		emit(value: VoiceUtterance) {
			listener?.(value);
		},
		unsubscribe,
	};
}

describe("LiveCaptionProjection", () => {
	it("renders frontend and authoritative Lead utterances with distinct literal labels", () => {
		const source = session();
		const caption = vi.fn();
		const projection = new LiveCaptionProjection({
			session: source.session,
			sink: { caption },
			record: vi.fn(),
		});

		projection.start();
		source.emit(utterance("frontend", { final: false }));
		source.emit(
			utterance("lead:flywheel-eng-lead", {
				face: "announce",
				sequence: 4,
				text: "已经查到结果",
				attribution: {
					kind: "known",
					speakerUserId: "flywheel-eng-lead",
				},
			}),
		);

		expect(caption.mock.calls.map(([value]) => value)).toEqual([
			expect.objectContaining({
				label: "🤖 前台",
				renderedText: "🤖 前台：马上处理",
				source: "frontend",
				generation: 9,
				sequence: 3,
				final: false,
			}),
			expect.objectContaining({
				label: "💬 Lead",
				renderedText: "💬 Lead：已经查到结果",
				source: "lead:flywheel-eng-lead",
				generation: 9,
				sequence: 4,
				final: true,
			}),
		]);
	});

	it("rejects untrusted Lead labels and stops projecting after close", () => {
		const source = session();
		const caption = vi.fn();
		const record = vi.fn();
		const projection = new LiveCaptionProjection({
			session: source.session,
			sink: { caption },
			record,
		});

		projection.start();
		source.emit(
			utterance("lead:flywheel-eng-lead", {
				attribution: { kind: "unknown", reason: "unverified" },
			}),
		);
		source.emit(utterance("discord:untrusted"));
		projection.close();
		source.emit(utterance("frontend"));

		expect(caption).not.toHaveBeenCalled();
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_caption_source_rejected" }),
		);
		expect(source.unsubscribe).toHaveBeenCalledOnce();
	});
});
