/**
 * FLY-1006 S5b — VoiceRoomRuntime: the shared single-VC room state that
 * FLY-967 built privately inside the /gemini wiring. Two modes (/gemini,
 * /eleven) must contend for ONE slot and ONE resident-ears routing — a
 * second private copy would void the room mutex and double-subscribe the
 * receiver. These tests pin the shared semantics before the lift.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { wireRoomEars } from "../roomEars.js";
import { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";

describe("VoiceRoomRuntime (FLY-1006 S5b)", () => {
	it("slot mutex is cross-mode: gemini holds → eleven rejected, and reverse", () => {
		const room = new VoiceRoomRuntime();
		expect(room.slot.acquire("gemini", "s1").ok).toBe(true);
		const rejected = room.slot.acquire("eleven", "s2");
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.busy.mode).toBe("gemini");
		expect(room.slot.release("gemini", "s1")).toBe(true);
		expect(room.slot.acquire("eleven", "s2").ok).toBe(true);
		expect(room.slot.acquire("gemini", "s3").ok).toBe(false);
	});

	it("frame/speakingEnd/bargeIn reach ONLY the currently-registered session", () => {
		const room = new VoiceRoomRuntime();
		const a = { frames: 0, ends: 0, barges: 0 };
		const b = { frames: 0, ends: 0, barges: 0 };
		const unsubA = [
			room.onFrame(() => a.frames++),
			room.onSpeakingEnd(() => a.ends++),
			room.onBargeIn(() => a.barges++),
		];
		room.routeFrame(Buffer.alloc(4), { encoding: "pcm16" });
		room.routeSpeakingEnd();
		room.routeBargeIn();
		expect([a.frames, a.ends, a.barges]).toEqual([1, 1, 1]);

		// session B takes over (single-slot semantics, FLY-967 wiring parity)
		room.onFrame(() => b.frames++);
		room.onSpeakingEnd(() => b.ends++);
		room.onBargeIn(() => b.barges++);
		room.routeFrame(Buffer.alloc(4), { encoding: "pcm16" });
		room.routeSpeakingEnd();
		room.routeBargeIn();
		expect([a.frames, a.ends, a.barges]).toEqual([1, 1, 1]);
		expect([b.frames, b.ends, b.barges]).toEqual([1, 1, 1]);

		// A's STALE unsubscribes must not clear B's registration
		for (const u of unsubA) u();
		room.routeFrame(Buffer.alloc(4), { encoding: "pcm16" });
		expect(b.frames).toBe(2);
	});

	it("unregistered routing is a no-op; own unsub clears delivery", () => {
		const room = new VoiceRoomRuntime();
		expect(() => {
			room.routeFrame(Buffer.alloc(2), {});
			room.routeSpeakingEnd();
			room.routeBargeIn();
		}).not.toThrow();
		let n = 0;
		const unsub = room.onFrame(() => n++);
		room.routeFrame(Buffer.alloc(2), {});
		unsub();
		room.routeFrame(Buffer.alloc(2), {});
		expect(n).toBe(1);
	});

	it("down/up fan out to every subscriber (multi-sub, unlike frames)", () => {
		const room = new VoiceRoomRuntime();
		let d1 = 0;
		let d2 = 0;
		let u1 = 0;
		room.onDown(() => d1++);
		const unsub = room.onDown(() => d2++);
		room.onUp(() => u1++);
		room.fireDown();
		room.fireUp();
		expect([d1, d2, u1]).toEqual([1, 1, 1]);
		unsub();
		room.fireDown();
		expect([d1, d2]).toEqual([2, 1]);
	});
});

describe("wireRoomEars (FLY-1006 S5b)", () => {
	function makeEarsFakes() {
		const speaking = new EventEmitter();
		const decoders: EventEmitter[] = [];
		const deps = {
			speakingEvents: () => ({
				on: (ev: "start" | "end", cb: (id: string) => void) => {
					speaking.on(ev, cb);
				},
			}),
			subscribeManual: () => (_userId: string) =>
				({ on() {}, pipe() {}, destroy() {} }) as never,
			createDecoder: () => {
				const d = new EventEmitter() as never;
				(d as { pipe?: unknown; destroy?: unknown; on: unknown }).pipe =
					() => {};
				decoders.push(d as unknown as EventEmitter);
				return d as never;
			},
			isHumanFactory: () => () => true,
			connectionEvents: () => ({
				onDown: (cb: () => void) => {
					speaking.on("conn-down", cb);
					return () => speaking.off("conn-down", cb);
				},
				onUp: (cb: () => void) => {
					speaking.on("conn-up", cb);
					return () => speaking.off("conn-up", cb);
				},
			}),
		};
		return { speaking, decoders, deps };
	}

	it("routes decoded frames / speaking-end / barge-in / conn events into the room", async () => {
		vi.useFakeTimers();
		try {
			const { speaking, decoders, deps } = makeEarsFakes();
			const room = new VoiceRoomRuntime();
			const got = { frames: 0, ends: 0, barges: 0, downs: 0, ups: 0 };
			room.onFrame((_f, format) => {
				got.frames++;
				expect(format).toMatchObject({ sampleRateHz: 16_000 });
			});
			room.onSpeakingEnd(() => got.ends++);
			room.onBargeIn(() => got.barges++);
			room.onDown(() => got.downs++);
			room.onUp(() => got.ups++);

			const ears = wireRoomEars({
				room,
				deps: deps as never,
				earsConnection: {},
				earsClient: {},
				guildId: "g1",
				backchannelMs: 350,
				log: () => {},
			});

			// speaking start → subscription + decoder; 48k stereo data → 16k frame
			speaking.emit("start", "user-1");
			expect(decoders.length).toBe(1);
			// 48k stereo s16le: 6 samples of stereo (24 bytes) → 1 mono 16k sample+
			decoders[0].emit("data", Buffer.alloc(1152));
			expect(got.frames).toBeGreaterThan(0);

			// sustained speech past the backchannel gate → barge-in routed
			vi.advanceTimersByTime(400);
			expect(got.barges).toBe(1);

			// speaking end → routed
			speaking.emit("end", "user-1");
			expect(got.ends).toBe(1);

			speaking.emit("conn-down");
			speaking.emit("conn-up");
			expect([got.downs, got.ups]).toEqual([1, 1]);

			ears.dispose();
			speaking.emit("conn-down");
			expect(got.downs).toBe(1); // disposed = unsubscribed
		} finally {
			vi.useRealTimers();
		}
	});
});
