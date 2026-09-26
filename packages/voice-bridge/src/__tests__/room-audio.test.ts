import { describe, expect, it, vi } from "vitest";
import { WaitingMouth } from "../room/audio.js";

// FLY-2796/2798: the RoomIO mouth (engine A). voice-codex keeps its own
// WaitingMouth for the legacy and Codex engines (FLY-2799).
describe("RoomIO WaitingMouth", () => {
	it("queues a proactive line behind in-flight conversation speech", async () => {
		let tick!: () => void;
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		const first = mouth.playSpeech("conversation", Buffer.alloc(960, 1));
		const proactive = mouth.playSpeech("proactive", Buffer.alloc(960, 2));

		tick();
		await first;
		await Promise.resolve();
		tick();
		await proactive;

		expect(frames.map((frame) => frame.readUInt8(0))).toEqual([1, 2]);
		mouth.stop();
	});
});
