import { describe, expect, it } from "vitest";
import {
	OPUS_SILENCE_FRAME,
	type OpusDownlinkPacketMeta,
} from "../audio/OpusDownlink.js";
import { DownlinkController } from "../codex/DownlinkController.js";

/** Records exactly what reached the player queue, in order. */
function recordingSink() {
	const pushed: Array<{ id: number | "fill"; meta: OpusDownlinkPacketMeta }> =
		[];
	let cuts = 0;
	let queue = 0;
	return {
		pushed,
		get cuts() {
			return cuts;
		},
		setQueued(value: number) {
			queue = value;
		},
		sink: {
			push: (payload: Buffer, meta: OpusDownlinkPacketMeta) => {
				pushed.push({
					id: payload.equals(OPUS_SILENCE_FRAME)
						? "fill"
						: payload.readUInt16BE(1),
					meta,
				});
				return true;
			},
			cut: () => {
				cuts += 1;
				return 0;
			},
			audible: () => false,
			queued: () => ({ total: queue, voiced: 0 }),
			stats: () => ({ consumedVoiced: 0, trims: 0 }),
		},
	};
}

function packet(id: number): Buffer {
	const buffer = Buffer.alloc(3);
	buffer[0] = 0xf8;
	buffer.writeUInt16BE(id, 1);
	return buffer;
}

function harness() {
	let now = 0;
	let next = 1;
	const sink = recordingSink();
	const evidence: Record<string, unknown>[] = [];
	const forced: string[] = [];
	const controller = new DownlinkController({
		sink: () => sink.sink,
		now: () => now,
		evidence: (record) => evidence.push(record),
		forceReconnect: (reason) => forced.push(reason),
	});
	/** Feeds packets 20 ms apart; returns their ids. */
	const feed = (pattern: string) => {
		const ids: number[] = [];
		for (const char of pattern) {
			const id = next++;
			ids.push(id);
			controller.packet({ payload: packet(id), voiced: char === "v" });
			now += 20;
		}
		return ids;
	};
	const heard = () =>
		sink.pushed.filter((entry) => entry.id !== "fill").map((entry) => entry.id);
	return {
		controller,
		sink,
		evidence,
		forced,
		feed,
		heard,
		advance: (ms: number) => {
			now += ms;
		},
		resumed: () =>
			evidence.filter((record) => record.kind === "codex_barge_in_resumed"),
	};
}

const v = (count: number) => "v".repeat(count);
const s = (count: number) => "s".repeat(count);

describe("downlink controller: local barge-in (FLY-2885 T5)", () => {
	it("passes live packets through untouched while playing", () => {
		const h = harness();
		const ids = h.feed(`${v(3)}${s(2)}`);
		expect(h.heard()).toEqual(ids);
		expect(h.controller.state).toBe("playing");
	});

	it("cuts at once, feeds the player silence, and stays muted while the founder speaks", () => {
		const h = harness();
		h.feed(v(5));
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		expect(h.sink.cuts).toBe(1);
		const muted = h.feed(`${v(40)}${s(800)}`);
		expect(h.controller.state).toBe("muted");
		// Founder talking >15 s: nothing of the old answer is heard, but the
		// player is never starved either.
		expect(h.heard().filter((id) => muted.includes(id))).toEqual([]);
		expect(h.sink.pushed.filter((entry) => entry.id === "fill")).toHaveLength(
			840,
		);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({ kind: "codex_barge_in_local_cut" }),
		);
	});

	it("replays the new answer from the end of the qualifying gap when the user-turn evidence comes late (R3: 16-packet gap, 35-packet answer)", () => {
		const h = harness();
		h.feed(v(5));
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.feed(v(10)); // old answer keeps coming ~200 ms
		h.controller.founderSpeaking(false);
		h.feed(s(16));
		const answer = h.feed(v(35));
		expect(h.controller.state).toBe("muted");
		h.controller.userTurnEvidence();
		expect(h.controller.state).toBe("playing");
		// Every packet of the new answer is heard, in order, none of the old.
		expect(h.heard().slice(-35)).toEqual(answer);
		expect(h.resumed()).toEqual([
			expect.objectContaining({
				trigger: "user_turn",
				boundary: "replay",
				gapMs: 320,
				replayMs: 700,
			}),
		]);
		expect(
			h.sink.pushed.slice(-35).every((entry) => entry.meta.replay === true),
		).toBe(true);
	});

	it("replays all 40 packets of an answer that starts 1.8 s after the cut (R2 counterexample)", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.feed(v(20));
		h.controller.founderSpeaking(false);
		h.feed(s(70)); // 1.8 s after the cut the new answer starts
		const answer = h.feed(v(40));
		h.controller.userTurnEvidence();
		expect(h.heard().slice(-40)).toEqual(answer);
		expect(h.resumed()[0]).toMatchObject({ boundary: "replay" });
	});

	it("waits for a qualifying gap after the evidence and releases the next answer with no extra delay", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.feed(v(10));
		h.controller.userTurnEvidence();
		h.controller.founderSpeaking(false);
		// Old answer still trailing: no qualifying gap yet.
		h.feed(v(5));
		expect(h.controller.state).toBe("waitGap");
		h.feed(s(12));
		const answer = h.feed(v(20));
		expect(h.heard().slice(-20)).toEqual(answer);
		expect(h.resumed()[0]).toMatchObject({
			boundary: "live",
			gapMs: 240,
			replayMs: 0,
		});
	});

	it("releases live after 2 s without a qualifying gap and records boundary_unknown", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.controller.userTurnEvidence();
		h.controller.founderSpeaking(false);
		// One continuous answer with only short pauses.
		h.feed(`${v(40)}${s(5)}${v(40)}${s(5)}${v(40)}`);
		expect(h.controller.state).toBe("playing");
		expect(h.resumed()[0]).toMatchObject({ boundary: "boundary_unknown" });
		expect(h.heard().length).toBeGreaterThan(0);
	});

	it("reports head_lost when the qualifying gap was pushed out of the 1.5 s buffer", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.controller.founderSpeaking(false);
		h.feed(`${v(5)}${s(15)}`);
		h.feed(v(80)); // new answer longer than the buffer before evidence
		h.controller.userTurnEvidence();
		expect(h.resumed()[0]).toMatchObject({ boundary: "head_lost" });
		expect(h.controller.state).toBe("playing");
	});

	it("always resumes even when both evidence sources stay silent (3 s fallback, gate closed 1.5 s)", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.feed(v(20));
		h.controller.founderSpeaking(false);
		h.feed(s(60));
		expect(h.controller.state).toBe("muted");
		h.feed(`${s(90)}${v(30)}`);
		expect(h.controller.state).toBe("playing");
		expect(h.resumed()[0]).toMatchObject({ trigger: "unconfirmed" });
	});

	it("drops only silence while a replay backlog is still queued", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.controller.founderSpeaking(false);
		h.feed(`${v(5)}${s(15)}`);
		h.feed(v(30));
		h.controller.userTurnEvidence();
		h.sink.setQueued(20);
		const pause = h.feed(s(10));
		const more = h.feed(v(3));
		const heard = h.heard();
		expect(heard.filter((id) => pause.includes(id))).toEqual([]);
		expect(heard.slice(-3)).toEqual(more);
		h.sink.setQueued(2);
		const later = h.feed(s(2));
		expect(h.heard().slice(-2)).toEqual(later);
	});

	it("goes back to muted if the founder speaks again before release", () => {
		const h = harness();
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		h.controller.userTurnEvidence();
		h.controller.founderSpeaking(false);
		h.feed(v(3));
		expect(h.controller.state).toBe("waitGap");
		h.controller.founderSpeaking(true);
		expect(h.controller.state).toBe("muted");
	});
});

describe("downlink controller: overrun discard (FLY-2885 T5c)", () => {
	it("mutes the overrunning turn and resumes only after its done plus 240 ms of silence", () => {
		const h = harness();
		h.feed(v(5));
		h.controller.overrunDiscard();
		expect(h.sink.cuts).toBe(1);
		const tail = h.feed(v(20));
		h.controller.overrunTurnDone();
		// Done arrives before the tail audio: the tail is still muted.
		const late = h.feed(v(10));
		h.feed(s(12));
		expect(h.controller.state).toBe("playing");
		expect(h.heard().filter((id) => [...tail, ...late].includes(id))).toEqual(
			[],
		);
		const next = h.feed(v(2));
		expect(h.heard().slice(-2)).toEqual(next);
	});

	it("never plays the overrun turn again when it pauses >1.5 s without a done; it forces a new generation", () => {
		const h = harness();
		h.controller.overrunDiscard();
		const before = h.feed(`${v(20)}${s(76)}`);
		expect(h.forced).toEqual(["silence_without_done"]);
		const after = h.feed(v(20));
		expect(
			h.heard().filter((id) => [...before, ...after].includes(id)),
		).toEqual([]);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_speech_overrun_forced_restart",
				reason: "silence_without_done",
			}),
		);
	});

	it("forces a new generation at the 15 s absolute deadline even while audio continues", () => {
		const h = harness();
		h.controller.overrunDiscard();
		h.feed(v(760));
		expect(h.forced).toEqual(["deadline"]);
	});

	it("lets a founder barge-in take over from the discard state", () => {
		const h = harness();
		h.controller.overrunDiscard();
		h.feed(v(5));
		h.controller.founderSpeaking(true);
		h.controller.bargeIn();
		expect(h.controller.state).toBe("muted");
		expect(h.controller.discarding).toBe(false);
	});

	it("counts every client-side cut or silence substitution for the silent-speech check", () => {
		const h = harness();
		const start = h.controller.interference;
		h.feed(v(2));
		expect(h.controller.interference).toBe(start);
		h.controller.overrunDiscard();
		h.feed(v(1));
		expect(h.controller.interference).toBeGreaterThan(start);
	});

	it("reset cuts and returns to playing for a new generation", () => {
		const h = harness();
		h.controller.overrunDiscard();
		h.controller.reset();
		expect(h.controller.state).toBe("playing");
		expect(h.controller.discarding).toBe(false);
		const ids = h.feed(v(2));
		expect(h.heard().slice(-2)).toEqual(ids);
	});
});
