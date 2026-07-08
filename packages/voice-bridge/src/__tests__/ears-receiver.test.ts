/**
 * FLY-545 P3 — EarsReceiver: the single receive pipeline of the huddle.
 *
 * Contract under test (plan §7 P3):
 *  - subscribes HUMAN members only (bot filter is the structural echo guard);
 *    `allowUserIds` additionally admits named ids (QA test-injection seam —
 *    lets a sender bot stand in for a human on the test guild).
 *  - speaking-start dedup: VAD flutter re-fires start; one subscription only.
 *  - decoded 48k stereo flows through the 3:1 downmixer → onFrame(16k mono).
 *  - backchannel gate (Codex R1 #6 signal source = receiver.speaking
 *    start/end pairs): start arms a 350ms timer; end first → backchannel, no
 *    action; timer fires while still speaking → onBargeIn exactly once per
 *    burst; a new burst re-arms.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarsReceiver } from "../audio/EarsReceiver.js";

type SpeakingCb = (userId: string) => void;

class FakeSpeaking {
	private handlers: Record<"start" | "end", SpeakingCb[]> = {
		start: [],
		end: [],
	};
	on(event: "start" | "end", cb: SpeakingCb): void {
		this.handlers[event].push(cb);
	}
	fire(event: "start" | "end", userId: string): void {
		for (const cb of this.handlers[event]) cb(userId);
	}
}

function makeRig(
	over: Partial<ConstructorParameters<typeof EarsReceiver>[0]> = {},
) {
	const speaking = new FakeSpeaking();
	const subscriptions: { userId: string; stream: PassThrough }[] = [];
	const frames: { userId: string; frame: Buffer }[] = [];
	const bargeIns: string[] = [];
	const receiver = new EarsReceiver({
		speaking,
		subscribe: (userId: string) => {
			const stream = new PassThrough();
			subscriptions.push({ userId, stream });
			return stream;
		},
		// identity "decoder": tests feed PCM directly (decode is prism's job,
		// verified on the real machine); the unit contract is the wiring.
		createDecoder: () => new PassThrough(),
		isHuman: (userId: string) => userId.startsWith("human"),
		onFrame: (frame: Buffer, userId: string) => frames.push({ userId, frame }),
		onBargeIn: (userId: string) => bargeIns.push(userId),
		...over,
	});
	receiver.attach();
	return { speaking, subscriptions, frames, bargeIns, receiver };
}

/** s16le helper */
function s16(...samples: number[]): Buffer {
	const buf = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
	return buf;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("member filter", () => {
	it("subscribes a human on speaking start", () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		expect(rig.subscriptions.map((s) => s.userId)).toEqual(["human-annie"]);
	});

	it("ignores a bot member (structural echo guard)", () => {
		const rig = makeRig();
		rig.speaking.fire("start", "bot-lead");
		expect(rig.subscriptions).toHaveLength(0);
	});

	it("admits an explicitly allowlisted non-human id (QA seam)", () => {
		const rig = makeRig({ allowUserIds: ["bot-sender"] });
		rig.speaking.fire("start", "bot-sender");
		expect(rig.subscriptions.map((s) => s.userId)).toEqual(["bot-sender"]);
	});
});

describe("subscription dedup", () => {
	it("subscribes once despite VAD-flutter re-starts", () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		rig.speaking.fire("end", "human-annie");
		rig.speaking.fire("start", "human-annie");
		rig.speaking.fire("start", "human-annie");
		expect(rig.subscriptions).toHaveLength(1);
	});
});

describe("frame pipeline", () => {
	it("feeds decoded 48k stereo through the downmixer to 16k mono onFrame", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		// 3 stereo frames (100,200)×3 → one mono sample 150
		rig.subscriptions[0]!.stream.write(s16(100, 200, 100, 200, 100, 200));
		await vi.advanceTimersByTimeAsync(0);
		expect(rig.frames).toHaveLength(1);
		expect(rig.frames[0]!.userId).toBe("human-annie");
		expect(rig.frames[0]!.frame.readInt16LE(0)).toBe(150);
	});
});

describe("backchannel gate (350ms speaking start/end pairs)", () => {
	it("a short burst (end before 350ms) is a backchannel — no barge-in", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(200);
		rig.speaking.fire("end", "human-annie");
		await vi.advanceTimersByTimeAsync(1000);
		expect(rig.bargeIns).toEqual([]);
	});

	it("sustained speech (≥350ms, no end) fires onBargeIn exactly once", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(349);
		expect(rig.bargeIns).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(rig.bargeIns).toEqual(["human-annie"]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(rig.bargeIns).toEqual(["human-annie"]);
	});

	it("a new burst re-arms the gate after a backchannel", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(100);
		rig.speaking.fire("end", "human-annie"); // backchannel
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(350);
		expect(rig.bargeIns).toEqual(["human-annie"]);
	});

	it("a new burst re-arms the gate after a barge-in burst ends", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(350);
		rig.speaking.fire("end", "human-annie");
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(350);
		expect(rig.bargeIns).toEqual(["human-annie", "human-annie"]);
	});

	it("honors a configured backchannelMs", async () => {
		const rig = makeRig({ backchannelMs: 500 });
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(400);
		rig.speaking.fire("end", "human-annie");
		await vi.advanceTimersByTimeAsync(1000);
		expect(rig.bargeIns).toEqual([]);
		rig.speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(500);
		expect(rig.bargeIns).toEqual(["human-annie"]);
	});

	it("gate does not fire for filtered (bot) members", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "bot-lead");
		await vi.advanceTimersByTimeAsync(1000);
		expect(rig.bargeIns).toEqual([]);
	});
});

describe("speaking observers + detach", () => {
	it("reports speaking start/end for admitted members", () => {
		const events: string[] = [];
		const rig = makeRig({
			onSpeakingStart: (u: string) => events.push(`start:${u}`),
			onSpeakingEnd: (u: string) => events.push(`end:${u}`),
		});
		rig.speaking.fire("start", "human-annie");
		rig.speaking.fire("end", "human-annie");
		rig.speaking.fire("start", "bot-x"); // filtered — not reported
		expect(events).toEqual(["start:human-annie", "end:human-annie"]);
	});

	it("detach() destroys subscriptions and cancels pending gates", async () => {
		const rig = makeRig();
		rig.speaking.fire("start", "human-annie");
		rig.receiver.detach();
		await vi.advanceTimersByTimeAsync(1000);
		expect(rig.bargeIns).toEqual([]);
		expect(rig.subscriptions[0]!.stream.destroyed).toBe(true);
	});
});
