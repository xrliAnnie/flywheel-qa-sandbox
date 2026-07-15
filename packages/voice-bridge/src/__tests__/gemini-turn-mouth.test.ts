/**
 * FLY-545 PR-2 P9′ — GeminiTurnMouth turn-stream contract.
 *
 * One PassThrough per turn (never a resource per chunk), a turn gate that
 * doubles as the one-mouth-at-a-time discipline (ungranted/late chunks are
 * counted, not played), flush() as the synchronous barge-in path, and
 * earcon/filler clips that must never cut a live turn stream.
 */
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiTurnMouth } from "../audio/GeminiTurnMouth.js";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";

class FakePlayer implements PlayerLike {
	played: unknown[] = [];
	stops = 0;
	play(resource: unknown): void {
		this.played.push(resource);
	}
	stop(): void {
		this.stops++;
	}
	on(): void {}
}

function setup(
	over: Partial<ConstructorParameters<typeof GeminiTurnMouth>[0]> = {},
) {
	const player = new FakePlayer();
	const resources: ResourceSource[] = [];
	const mouth = new GeminiTurnMouth({
		player,
		createResource: (src) => {
			resources.push(src);
			return src;
		},
		upsample: (chunk) => chunk, // identity for tests
		...over,
	});
	return { mouth, player, resources };
}

function readAll(stream: Readable): Buffer {
	const bufs: Buffer[] = [];
	let c = stream.read();
	while (c !== null) {
		bufs.push(c as Buffer);
		c = stream.read();
	}
	return Buffer.concat(bufs);
}

describe("turn streaming", () => {
	it("opens ONE stream resource per turn and writes every chunk into it", () => {
		const { mouth, player, resources } = setup();
		mouth.beginTurn();
		mouth.feed(Buffer.from("aa"));
		mouth.feed(Buffer.from("bb"));
		expect(player.played).toHaveLength(1);
		expect(resources[0]?.kind).toBe("raw-stream");
		const stream = (resources[0] as { stream: Readable }).stream;
		mouth.endTurn();
		expect(readAll(stream).toString()).toBe("aabb");
	});

	it("a new turn after endTurn opens a fresh stream", () => {
		const { mouth, player } = setup();
		mouth.beginTurn();
		mouth.feed(Buffer.from("x"));
		mouth.endTurn();
		mouth.beginTurn();
		mouth.feed(Buffer.from("y"));
		expect(player.played).toHaveLength(2);
	});

	it("runs chunks through the upsampler", () => {
		const upsample = vi.fn((c: Buffer) => Buffer.concat([c, c]));
		const { mouth, resources } = setup({ upsample });
		mouth.beginTurn();
		mouth.feed(Buffer.from("z"));
		mouth.endTurn();
		expect(upsample).toHaveBeenCalledOnce();
		const stream = (resources[0] as { stream: Readable }).stream;
		expect(readAll(stream).toString()).toBe("zz");
	});
});

describe("turn gate (one-mouth-at-a-time belt)", () => {
	it("drops and counts chunks fed without beginTurn (ungranted session)", () => {
		const { mouth, player } = setup();
		mouth.feed(Buffer.from("rogue"));
		mouth.feed(Buffer.from("rogue2"));
		expect(player.played).toHaveLength(0);
		expect(mouth.droppedChunks).toBe(2);
	});

	it("drops late chunks of a flushed turn", () => {
		const { mouth, player } = setup();
		mouth.beginTurn();
		mouth.feed(Buffer.from("live"));
		mouth.flush();
		mouth.feed(Buffer.from("late"));
		expect(mouth.droppedChunks).toBe(1);
		expect(player.played).toHaveLength(1); // no second resource
	});
});

describe("flush — the barge-in fast path", () => {
	it("destroys the live stream and stops the player synchronously", () => {
		const { mouth, player, resources } = setup();
		mouth.beginTurn();
		mouth.feed(Buffer.from("cut me"));
		const stream = (resources[0] as { stream: Readable }).stream;
		mouth.flush();
		expect(player.stops).toBe(1);
		expect(stream.destroyed).toBe(true);
	});

	it("is safe with no live stream (idle barge-in fan-out)", () => {
		const { mouth, player } = setup();
		mouth.flush();
		expect(player.stops).toBe(1);
	});
});

describe("earcon / filler clips", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("noteToolCall plays the earcon immediately and arms the filler", () => {
		const { mouth, player, resources } = setup({
			earconPath: "/clips/earcon.mp3",
			fillerPath: "/clips/filler.mp3",
			fillerDelayMs: 1500,
		});
		mouth.noteToolCall();
		expect(resources[0]).toEqual({ kind: "file", path: "/clips/earcon.mp3" });
		vi.advanceTimersByTime(1500);
		expect(resources[1]).toEqual({ kind: "file", path: "/clips/filler.mp3" });
		expect(player.played).toHaveLength(2);
	});

	it("noteToolResolved cancels the armed filler", () => {
		const { mouth, player } = setup({
			earconPath: "/clips/earcon.mp3",
			fillerPath: "/clips/filler.mp3",
			fillerDelayMs: 1500,
		});
		mouth.noteToolCall();
		mouth.noteToolResolved();
		vi.advanceTimersByTime(5000);
		expect(player.played).toHaveLength(1); // earcon only
	});

	it("a clip never cuts a live turn stream", () => {
		const log = vi.fn();
		const { mouth, player } = setup({ earconPath: "/clips/earcon.mp3", log });
		mouth.beginTurn();
		mouth.feed(Buffer.from("live audio"));
		mouth.noteToolCall();
		expect(player.played).toHaveLength(1); // the turn stream only
		expect(log).toHaveBeenCalledWith(expect.stringContaining("earcon skipped"));
	});
});
