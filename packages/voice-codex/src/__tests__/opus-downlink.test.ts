import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	OPUS_SILENCE_FRAME,
	OpusDownlink,
	type OpusDownlinkConsumption,
} from "../audio/OpusDownlink.js";

/**
 * Mirrors @discordjs/voice for an Opus resource with no transformers: the
 * resource reads the stream it was given, one packet per 20 ms cycle, and a
 * resource switch destroys the old stream and reads it once more.
 */
function fakePlayer() {
	type Resource = { stream: Readable; read(): Buffer | null };
	let current: Resource | undefined;
	const heard: Array<Buffer | null> = [];
	const idle: Array<() => void> = [];
	const resources: Resource[] = [];
	const player = {
		play: vi.fn((resource: unknown) => {
			const previous = current;
			current = resource as Resource;
			if (previous && previous !== current) {
				previous.stream.destroy();
				previous.stream.read();
			}
		}),
		stop: vi.fn(() => {
			current = undefined;
		}),
		on: vi.fn((event: string, callback: () => void) => {
			if (event === "idle") idle.push(callback);
		}),
	};
	return {
		player,
		heard,
		resources,
		createResource: (source: { kind: "opus-stream"; stream: Readable }) => {
			expect(source.kind).toBe("opus-stream");
			const resource = {
				stream: source.stream,
				read: () => source.stream.read() as Buffer | null,
			};
			resources.push(resource);
			return resource;
		},
		/** One audio cycle. */
		tick: () => heard.push(current ? current.read() : null),
		goIdle: () => {
			current = undefined;
			for (const callback of idle) callback();
		},
	};
}

function packet(value: number): Buffer {
	return Buffer.from([0xf8, value, value]);
}

function harness(overrides: { assertLease?: () => void } = {}) {
	let now = 0;
	const fake = fakePlayer();
	const diagnostics: Record<string, unknown>[] = [];
	const consumed: OpusDownlinkConsumption[] = [];
	const errors: Error[] = [];
	const downlink = new OpusDownlink({
		player: fake.player,
		createResource: fake.createResource,
		now: () => now,
		onDiagnostic: (record) => diagnostics.push(record),
		onConsumed: (record) => consumed.push(record),
		onError: (error) => errors.push(error),
		...overrides,
	});
	downlink.start();
	return {
		...fake,
		downlink,
		diagnostics,
		consumed,
		errors,
		advance: (ms: number) => {
			now += ms;
		},
		tickFor: (cycles: number) => {
			for (let index = 0; index < cycles; index += 1) {
				now += 20;
				fake.tick();
			}
		},
	};
}

describe("Opus downlink", () => {
	it("hands the first packet to the player synchronously, untouched", () => {
		const h = harness();
		const first = packet(1);
		expect(h.downlink.push(first, { voiced: true })).toBe(true);
		// No timer in between: the very next audio cycle plays it.
		h.tick();
		expect(h.heard).toEqual([first]);
		expect(h.consumed).toEqual([
			expect.objectContaining({
				voiced: true,
				replay: false,
				silenceFill: false,
			}),
		]);
	});

	it("keeps playing packets in order and reports each one the player took", () => {
		const h = harness();
		for (let index = 1; index <= 3; index += 1)
			h.downlink.push(packet(index), { voiced: index !== 2 });
		h.tickFor(4);
		expect(h.heard).toEqual([packet(1), packet(2), packet(3), null]);
		expect(h.consumed.map((record) => record.voiced)).toEqual([
			true,
			false,
			true,
		]);
		expect(h.downlink.stats()).toEqual({ consumedVoiced: 2, trims: 0 });
	});

	it.each([10, 25])(
		"cut() drops everything queued (%i packets, some already taken) and the next packet plays at once",
		(queued) => {
			const h = harness();
			for (let index = 0; index < queued; index += 1)
				h.downlink.push(packet(index), { voiced: true });
			h.tickFor(4);
			const consumedBefore = h.consumed.length;
			expect(h.downlink.cut()).toBe(queued - 4);
			expect(h.diagnostics).toContainEqual({
				kind: "downlink_flushed",
				droppedPackets: queued - 4,
				droppedVoiced: queued - 4,
			});
			// The player's own read of the retired stream is not a consumption.
			expect(h.consumed).toHaveLength(consumedBefore);
			h.tickFor(3);
			expect(h.heard.slice(-3)).toEqual([null, null, null]);
			const next = packet(99);
			h.downlink.push(next, { voiced: true });
			h.tick();
			expect(h.heard.at(-1)).toEqual(next);
			expect(h.consumed).toHaveLength(consumedBefore + 1);
		},
	);

	it("is audible while voiced packets wait or were taken within 300 ms", () => {
		const h = harness();
		expect(h.downlink.audible()).toBe(false);
		h.downlink.push(packet(1), { voiced: false });
		expect(h.downlink.audible()).toBe(false);
		h.downlink.push(packet(2), { voiced: true });
		expect(h.downlink.audible()).toBe(true);
		h.tickFor(2);
		expect(h.downlink.audible()).toBe(true);
		h.advance(299);
		expect(h.downlink.audible()).toBe(true);
		h.advance(2);
		expect(h.downlink.audible()).toBe(false);
		h.downlink.push(packet(3), { voiced: true });
		h.downlink.cut();
		expect(h.downlink.audible()).toBe(false);
	});

	it("trims a live backlog over 25 packets to 3 but never a replay backlog", () => {
		const h = harness();
		for (let index = 0; index < 26; index += 1)
			h.downlink.push(packet(index), { voiced: true });
		expect(h.downlink.queued().total).toBe(3);
		expect(h.downlink.stats().trims).toBe(1);
		expect(h.diagnostics).toContainEqual({
			kind: "downlink_queue_trim",
			from: 26,
			to: 3,
			droppedVoiced: 23,
		});
		h.downlink.cut();
		for (let index = 0; index < 40; index += 1)
			h.downlink.push(packet(index), { voiced: true, replay: true });
		h.downlink.push(packet(100), { voiced: true });
		expect(h.downlink.queued().total).toBe(41);
	});

	it("stops, cuts and reports when the lease is gone before a push", () => {
		let leased = true;
		const h = harness({
			assertLease: () => {
				if (!leased) throw new Error("voice_lease_fenced");
			},
		});
		h.downlink.push(packet(1), { voiced: true });
		leased = false;
		expect(h.downlink.push(packet(2), { voiced: true })).toBe(false);
		expect(h.errors.map((error) => error.message)).toEqual([
			"voice_lease_fenced",
		]);
		expect(h.player.stop).toHaveBeenCalled();
		expect(h.downlink.push(packet(3), { voiced: true })).toBe(false);
	});

	it("rebuilds the resource when the player goes idle and keeps playing", () => {
		const h = harness();
		expect(h.resources).toHaveLength(1);
		h.goIdle();
		expect(h.resources).toHaveLength(2);
		expect(h.diagnostics).toContainEqual({
			kind: "downlink_player_idle_rebuilt",
		});
		h.downlink.push(packet(7), { voiced: true });
		h.tick();
		expect(h.heard.at(-1)).toEqual(packet(7));
	});

	it("exposes a pre-encoded 20 ms Opus silence frame", () => {
		expect([...OPUS_SILENCE_FRAME]).toEqual([0xf8, 0xff, 0xfe]);
	});
});
