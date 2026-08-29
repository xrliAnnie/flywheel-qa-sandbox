/**
 * FLY-967 P3 — AssistantSpeaker: the /live mouth. A model turn is a CONTINUOUS
 * 24k PCM chunk stream (not discrete utterances): first chunk opens ONE raw
 * stream resource on the player; endTurn() closes it; flush() (barge-in /
 * response-cancelled) destroys it synchronously and gates late chunks out.
 * Earcon plays the moment a tool-call lands; a pre-synthesized filler clip
 * fires if the tool hasn't answered within the delay (sync function calling —
 * the model is silent while it waits).
 */
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSpeaker } from "../assistant/AssistantSpeaker.js";
import type { ResourceSource } from "../audio/LeadSpeaker.js";

class FakePlayer {
	played: ResourceSource[] = [];
	stopped = 0;
	play(resource: unknown): void {
		this.played.push(resource as ResourceSource);
	}
	stop(): void {
		this.stopped++;
	}
	on(): void {}
}

function makeSpeaker(over: Record<string, unknown> = {}) {
	const player = new FakePlayer();
	const created: ResourceSource[] = [];
	const speaker = new AssistantSpeaker({
		player,
		createResource: (src: ResourceSource) => {
			created.push(src);
			return src;
		},
		// marker upsample: prefix so tests can assert the chunk went through it
		upsample: (c: Buffer) => Buffer.concat([Buffer.from("UP:"), c]),
		earconPath: "/assets/earcon.ogg",
		fillerPath: "/assets/filler.ogg",
		fillerDelayMs: 2000,
		...over,
	});
	return { speaker, player, created };
}

function collect(stream: Readable): Buffer[] {
	const out: Buffer[] = [];
	stream.on("data", (c: Buffer) => out.push(c));
	return out;
}

describe("AssistantSpeaker (FLY-967 P3)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("streams a turn through ONE resource: first feed opens, endTurn closes", async () => {
		const { speaker, player, created } = makeSpeaker();
		speaker.beginTurn();
		speaker.feed(Buffer.from("aa"));
		speaker.feed(Buffer.from("bb"));
		expect(player.played).toHaveLength(1);
		expect(created[0].kind).toBe("stream");
		const chunks = collect((created[0] as { stream: Readable }).stream);
		speaker.feed(Buffer.from("cc"));
		speaker.endTurn();
		await vi.advanceTimersByTimeAsync(0);
		const joined = Buffer.concat(chunks).toString();
		expect(joined).toBe("UP:aaUP:bbUP:cc");
		expect(player.played).toHaveLength(1); // still one resource for the turn
	});

	it("flush(): destroys the stream, stops the player, and gates late chunks", () => {
		const { speaker, player, created } = makeSpeaker();
		speaker.beginTurn();
		speaker.feed(Buffer.from("aa"));
		const stream = (created[0] as { stream: Readable }).stream;
		speaker.flush();
		expect(player.stopped).toBe(1);
		expect(stream.destroyed).toBe(true);
		// late chunk from the dead turn: dropped, no new resource
		speaker.feed(Buffer.from("late"));
		expect(player.played).toHaveLength(1);
		expect(speaker.droppedChunks).toBe(1);
	});

	it("recovers after flush: the next turn opens a fresh resource", () => {
		const { speaker, player } = makeSpeaker();
		speaker.beginTurn();
		speaker.feed(Buffer.from("aa"));
		speaker.flush();
		speaker.beginTurn();
		speaker.feed(Buffer.from("bb"));
		expect(player.played).toHaveLength(2);
	});

	it("warns once per turn when the stream buffer exceeds highWaterMark", () => {
		const log = vi.fn();
		const { speaker } = makeSpeaker({ highWaterMark: 4, log });
		speaker.beginTurn();
		speaker.feed(Buffer.alloc(64)); // 67 bytes after marker > 4 hwm
		speaker.feed(Buffer.alloc(64));
		const warns = log.mock.calls.filter(([l]) =>
			String(l).includes("backpressure"),
		);
		expect(warns).toHaveLength(1);
	});

	it("plays the earcon immediately on a tool call when the mouth is free", () => {
		const { speaker, player } = makeSpeaker();
		speaker.noteToolCall();
		expect(player.played).toHaveLength(1);
		expect(player.played[0]).toMatchObject({
			kind: "file",
			path: "/assets/earcon.ogg",
		});
	});

	it("does NOT let the earcon cut a live turn stream", () => {
		const log = vi.fn();
		const { speaker, player } = makeSpeaker({ log });
		speaker.beginTurn();
		speaker.feed(Buffer.from("aa")); // live stream on the player
		speaker.noteToolCall();
		expect(player.played).toHaveLength(1); // stream only — earcon skipped
		expect(log).toHaveBeenCalledWith(expect.stringContaining("earcon"));
	});

	it("fires the filler clip when the tool stays silent past the delay", async () => {
		const { speaker, player } = makeSpeaker();
		speaker.noteToolCall(); // earcon
		await vi.advanceTimersByTimeAsync(2000);
		expect(player.played).toHaveLength(2);
		expect(player.played[1]).toMatchObject({
			kind: "file",
			path: "/assets/filler.ogg",
		});
	});

	it("a resolved tool cancels the pending filler", async () => {
		const { speaker, player } = makeSpeaker();
		speaker.noteToolCall();
		speaker.noteToolResolved();
		await vi.advanceTimersByTimeAsync(5000);
		expect(player.played).toHaveLength(1); // earcon only
	});

	it("flush() also cancels a pending filler (the turn is dead)", async () => {
		const { speaker, player } = makeSpeaker();
		speaker.noteToolCall();
		speaker.flush();
		await vi.advanceTimersByTimeAsync(5000);
		expect(player.played).toHaveLength(1);
	});

	it("without earcon/filler paths tool notes are safe no-ops", async () => {
		const { speaker, player } = makeSpeaker({
			earconPath: undefined,
			fillerPath: undefined,
		});
		speaker.noteToolCall();
		await vi.advanceTimersByTimeAsync(3000);
		expect(player.played).toHaveLength(0);
	});
});
