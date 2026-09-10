import { describe, expect, it, vi } from "vitest";
import { Uplink } from "./Uplink.js";
import { UplinkSpeechGate } from "./UplinkSpeechGate.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function stereoFrame(value: number): Buffer {
	const frame = Buffer.alloc(3_840);
	for (let offset = 0; offset < frame.length; offset += 4) {
		frame.writeInt16LE(value, offset);
		frame.writeInt16LE(value, offset + 2);
	}
	return frame;
}

describe("Uplink", () => {
	it("D-GATE4 preserves passthrough bytes without invoking inference", () => {
		const baselineSent: Buffer[] = [];
		const gatedSent: Buffer[] = [];
		const input = stereoFrame(2_000);
		const baseline = new Uplink({
			appendAudio: (frame) => {
				baselineSent.push(Buffer.from(frame));
				return "sent";
			},
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 4,
			record: () => {},
		});
		const score = vi.fn(async () => ({ probability: 0.9, next: {} }));
		const speechGate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 200,
			threshold: 0.5,
		});
		const gated = new Uplink({
			appendAudio: (frame) => {
				gatedSent.push(Buffer.from(frame));
				return "sent";
			},
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 4,
			record: () => {},
			speechGate,
		});

		baseline.speakingStart("founder", true);
		baseline.pushPcm48Stereo("founder", input);
		baseline.tick();
		gated.speakingStart("founder", true);
		gated.beginUtterance("passthrough", 0);
		gated.pushPcm48Stereo("founder", input);
		gated.tick();

		expect(score).not.toHaveBeenCalled();
		expect(gatedSent).toEqual(baselineSent);
	});

	it("D-GATE5 drops delayed frames and stale inference when the mic closes", async () => {
		const decision = deferred<{ probability: number; next: unknown }>();
		const score = vi.fn(() => decision.promise);
		const speechGate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		const sent: Buffer[] = [];
		const uplink = new Uplink({
			appendAudio: (frame) => {
				sent.push(Buffer.from(frame));
				return "sent";
			},
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 16,
			record: () => {},
			speechGate,
		});
		uplink.speakingStart("founder", true);
		uplink.beginUtterance("gated", 0);
		uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
		uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
		await vi.waitFor(() => expect(score).toHaveBeenCalledOnce());

		uplink.setMicOpen(false);
		decision.resolve({ probability: 0.9, next: { stale: true } });
		await settle();
		uplink.setMicOpen(true);
		uplink.tick();

		expect(speechGate.token).toBe(1);
		expect(speechGate.takeCompleted()).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("D-GATE5 restarts an active gated utterance when the mic reopens", () => {
		const speechGate = new UplinkSpeechGate({
			score: vi.fn(async () => ({ probability: 0.9, next: {} })),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		const uplink = new Uplink({
			appendAudio: () => "sent",
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 16,
			record: () => {},
			now: () => 40,
			speechGate,
		});
		uplink.speakingStart("founder", true);
		uplink.beginUtterance("gated", 0);
		uplink.pushPcm48Stereo("founder", stereoFrame(2_000));

		uplink.setMicOpen(false);
		uplink.setMicOpen(true);

		expect(speechGate.mode).toBe("gated");
		expect(() =>
			uplink.pushPcm48Stereo("founder", stereoFrame(2_000)),
		).not.toThrow();
	});

	it.each([
		{
			name: "next epoch starts before an empty tick",
			emptyTickBeforeNext: false,
			expectedNew: [1_000, 2_000, 3_000, 4_000, 5_000],
			expectedLegacy: [1_000, 4_000, 5_000],
		},
		{
			name: "next epoch starts after an empty tick",
			emptyTickBeforeNext: true,
			expectedNew: [1_000, 2_000, 3_000, 0, 4_000, 5_000],
			expectedLegacy: [1_000, 2_000, 3_000, 0, 4_000, 5_000],
		},
	])(
		"D-BYTES confines the intentional epoch-boundary diff when $name",
		({ emptyTickBeforeNext, expectedNew, expectedLegacy }) => {
			const score = vi.fn(async () => ({ probability: 0.9, next: {} }));
			const speechGate = new UplinkSpeechGate({
				score,
				initialState: () => ({}),
				minSpeechMs: 200,
				threshold: 0.5,
			});
			const sent: Buffer[] = [];
			const uplink = new Uplink({
				appendAudio: (frame) => {
					sent.push(Buffer.from(frame));
					return "sent";
				},
				sessionGeneration: 1,
				prebufferFrames: 2,
				maxQueueFrames: 8,
				record: () => {},
				speechGate,
			});

			uplink.speakingStart("founder", true);
			uplink.beginUtterance("passthrough", 0);
			for (const value of [1_000, 2_000, 3_000]) {
				uplink.pushPcm48Stereo("founder", stereoFrame(value));
			}
			uplink.tick();
			if (emptyTickBeforeNext) {
				uplink.tick();
				uplink.tick();
				uplink.tick();
			}
			uplink.endUtterance(100);
			uplink.speakingEnd("founder");

			uplink.speakingStart("founder", true);
			uplink.beginUtterance("passthrough", 120);
			for (const value of [4_000, 5_000]) {
				uplink.pushPcm48Stereo("founder", stereoFrame(value));
			}
			for (let index = 0; index < (emptyTickBeforeNext ? 2 : 4); index += 1) {
				uplink.tick();
			}

			const actual = sent.map((frame) => frame.readInt16LE(0));
			expect(actual).toEqual(expectedNew);
			expect(actual.filter(Boolean)).toEqual(expectedNew.filter(Boolean));
			const legacyNonSilence = expectedLegacy.filter(Boolean);
			expect(legacyNonSilence).toEqual(
				expectedNew.filter(
					(value) => value !== 0 && legacyNonSilence.includes(value),
				),
			);
			expect(score).not.toHaveBeenCalled();
		},
	);

	it("D-GATE2 sends only silence downstream for a negative gated chain", async () => {
		const speechGate = new UplinkSpeechGate({
			score: vi.fn(async () => ({ probability: 0.2, next: {} })),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		const summaries: Array<{ opened: boolean; framesSilenced: number }> = [];
		const sent: Buffer[] = [];
		const uplink = new Uplink({
			appendAudio: (frame) => {
				sent.push(Buffer.from(frame));
				return "sent";
			},
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 16,
			record: () => {},
			speechGate,
			onGateSummary: (summary) => summaries.push(summary),
		});
		uplink.speakingStart("founder", true);
		uplink.beginUtterance("gated", 0);
		for (let index = 0; index < 14; index += 1) {
			uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
			await settle();
			uplink.tick();
		}
		uplink.endUtterance(280);
		for (let index = 0; index < speechGate.delayFrames; index += 1) {
			uplink.tick();
		}

		expect(sent.every((frame) => frame.every((byte) => byte === 0))).toBe(true);
		expect(summaries).toEqual([
			expect.objectContaining({ opened: false, framesSilenced: 14 }),
		]);
	});

	it("keeps first-speaker ownership until that speaker ends", () => {
		const outcomes: string[] = [];
		const sent: Buffer[] = [];
		const uplink = new Uplink({
			appendAudio: (frame) => {
				sent.push(frame);
				return "sent";
			},
			sessionGeneration: 2,
			prebufferFrames: 1,
			maxQueueFrames: 4,
			record: (row) => outcomes.push(row.outcome),
		});
		uplink.speakingStart("founder", true);
		uplink.pushPcm48Stereo("founder", stereoFrame(1_000));
		uplink.speakingStart("other", true);
		uplink.pushPcm48Stereo("other", stereoFrame(2_000));
		uplink.speakingEnd("other");
		expect(uplink.owner).toBe("founder");
		uplink.tick();
		uplink.speakingEnd("founder");
		uplink.speakingStart("other", true);
		uplink.pushPcm48Stereo("other", stereoFrame(2_000));
		uplink.tick();
		expect(uplink.droppedOtherSpeaker).toBe(1);
		expect(sent).toHaveLength(2);
		expect(outcomes).toEqual(["sent", "sent"]);
	});

	it("accounts the accepted high-watermark frame once, then drops blocked ticks", () => {
		const appendAudio = vi
			.fn()
			.mockReturnValueOnce("sent:need-drain")
			.mockReturnValueOnce("dropped:backpressure");
		const rows: string[] = [];
		const uplink = new Uplink({
			appendAudio,
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 2,
			record: (row) => rows.push(row.outcome),
		});
		uplink.tick();
		uplink.tick();
		expect(appendAudio).toHaveBeenCalledTimes(2);
		expect(rows).toEqual(["sent:need-drain", "dropped:backpressure"]);
	});

	it("exposes cumulative jitter overflow for live room instrumentation", () => {
		const uplink = new Uplink({
			appendAudio: () => "sent",
			sessionGeneration: 1,
			prebufferFrames: 1,
			maxQueueFrames: 2,
			record: () => {},
		});
		uplink.speakingStart("founder", true);
		for (let index = 0; index < 4; index += 1) {
			uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
		}

		expect(uplink.droppedOverflow).toBe(2);
	});

	it("drops muted input instead of replaying it after the mic gate reopens", () => {
		const sent: Buffer[] = [];
		const uplink = new Uplink({
			appendAudio: (frame) => {
				sent.push(Buffer.from(frame));
				return "sent";
			},
			sessionGeneration: 3,
			prebufferFrames: 1,
			maxQueueFrames: 2,
			record: () => {},
		});
		uplink.speakingStart("founder", true);
		uplink.setMicOpen(false);
		uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
		uplink.tick();
		uplink.setMicOpen(true);
		uplink.tick();

		expect(sent).toHaveLength(2);
		expect(sent.every((frame) => frame.every((byte) => byte === 0))).toBe(true);
	});

	it("taps only complete owner/mic raw frames for speech classification", () => {
		const onVoiceFrame = vi.fn();
		const uplink = new Uplink({
			appendAudio: () => "sent",
			sessionGeneration: 3,
			prebufferFrames: 1,
			maxQueueFrames: 2,
			record: () => {},
			now: () => 123,
			onVoiceFrame,
		});
		uplink.speakingStart("founder", true);
		uplink.pushPcm48Stereo("other", stereoFrame(2_000));
		uplink.setMicOpen(false);
		uplink.pushPcm48Stereo("founder", stereoFrame(2_000));
		uplink.setMicOpen(true);
		const accepted = stereoFrame(2_000);
		uplink.pushPcm48Stereo("founder", accepted);

		expect(onVoiceFrame).toHaveBeenCalledOnce();
		expect(onVoiceFrame).toHaveBeenCalledWith(accepted, 123);
	});
});
