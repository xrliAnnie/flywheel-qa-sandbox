import OpusScript from "opusscript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamTrack,
	type RTCDataChannel,
	RTCPeerConnection,
	RTCRtpCodecParameters,
	RtpHeader,
	RtpPacket,
} from "werift";
import {
	type DownlinkPacket,
	opusPacketSamples48k,
	type RealtimeDataEvent,
	WebRtcLeg,
} from "../codex/WebRtcLeg.js";

const opus = () =>
	new RTCRtpCodecParameters({
		mimeType: "audio/opus",
		clockRate: 48_000,
		channels: 2,
		payloadType: 111,
		parameters: "minptime=10;useinbandfec=1",
	});

/** A local peer standing in for the OpenAI realtime endpoint. */
class FakeServer {
	readonly pc = new RTCPeerConnection({
		codecs: { audio: [opus()], video: [] },
		iceServers: [],
	});
	readonly track = new MediaStreamTrack({ kind: "audio" });
	readonly received: RtpPacket[] = [];
	channel?: RTCDataChannel;
	private sequence = 100;
	private timestamp = 1_000;

	constructor() {
		this.pc.addTransceiver(this.track, { direction: "sendrecv" });
		this.pc.onTrack.subscribe((track) =>
			track.onReceiveRtp.subscribe((rtp) => this.received.push(rtp)),
		);
		this.pc.onDataChannel.subscribe((channel) => {
			this.channel = channel;
		});
	}

	async answer(offer: string): Promise<string> {
		await this.pc.setRemoteDescription({ type: "offer", sdp: offer });
		await this.pc.setLocalDescription(await this.pc.createAnswer());
		return this.pc.localDescription!.sdp;
	}

	send(payload: Buffer, step = 1): void {
		this.sequence = (this.sequence + step) & 0xffff;
		this.timestamp = (this.timestamp + 960 * step) >>> 0;
		this.track.writeRtp(
			new RtpPacket(
				new RtpHeader({
					payloadType: 111,
					sequenceNumber: this.sequence,
					timestamp: this.timestamp,
					marker: false,
				}),
				payload,
			),
		);
	}

	repeat(payload: Buffer): void {
		this.track.writeRtp(
			new RtpPacket(
				new RtpHeader({
					payloadType: 111,
					sequenceNumber: this.sequence,
					timestamp: this.timestamp,
					marker: false,
				}),
				payload,
			),
		);
	}
}

const encoder48 = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
function tone(amplitude: number): Buffer {
	const pcm = Buffer.alloc(960 * 4);
	for (let index = 0; index < 960; index += 1) {
		const value = Math.round(
			amplitude * Math.sin((2 * Math.PI * 440 * index) / 48_000),
		);
		pcm.writeInt16LE(value, index * 4);
		pcm.writeInt16LE(value, index * 4 + 2);
	}
	return Buffer.from(encoder48.encode(pcm, 960));
}

const legs: WebRtcLeg[] = [];
const servers: FakeServer[] = [];
afterEach(async () => {
	for (const leg of legs.splice(0)) await leg.close();
	for (const server of servers.splice(0)) await server.pc.close();
});

async function connected(
	overrides: Partial<ConstructorParameters<typeof WebRtcLeg>[0]> = {},
) {
	const downlink: DownlinkPacket[] = [];
	const events: RealtimeDataEvent[] = [];
	const lost: string[] = [];
	const evidence: Record<string, unknown>[] = [];
	const leg = new WebRtcLeg({
		stunUrls: [],
		onDownlink: (packet) => downlink.push(packet),
		onDataEvent: (event) => events.push(event),
		onLost: (reason) => lost.push(reason),
		onEvidence: (record) => evidence.push(record),
		...overrides,
	});
	legs.push(leg);
	const server = new FakeServer();
	servers.push(server);
	const offer = await leg.prepareOffer();
	expect(offer).toContain("m=audio");
	expect(offer).toContain("opus/48000/2");
	expect(offer).toContain("webrtc-datachannel");
	await leg.acceptAnswer(await server.answer(offer));
	await vi.waitFor(() => expect(server.channel?.readyState).toBe("open"), {
		timeout: 5_000,
	});
	return { leg, server, downlink, events, lost, evidence };
}

describe("Opus TOC sample count", () => {
	it.each([
		[[0x68], 960], // hybrid SWB 20 ms, one frame
		[[0x78], 960], // hybrid FB 20 ms, one frame
		[[0xf8], 960], // CELT FB 20 ms, one frame
		[[0xf0], 480], // CELT FB 10 ms, one frame
		[[0x0b], 0], // SILK 20 ms, code 3 without its frame-count byte
		[[0x0b, 0x02], 1_920], // SILK 20 ms, code 3, two frames
		[[0x09], 1_920], // SILK 20 ms, code 1: two frames
	] as const)("%j → %i samples", (bytes, samples) => {
		expect(opusPacketSamples48k(Buffer.from(bytes))).toBe(samples);
	});
	it("treats an empty packet as zero samples", () => {
		expect(opusPacketSamples48k(Buffer.alloc(0))).toBe(0);
	});
});

describe("WebRTC leg", () => {
	it("encodes 24 kHz mono frames once into 20 ms Opus RTP with consecutive sequence and +960 timestamps", async () => {
		const { leg, server } = await connected();
		const frame = Buffer.alloc(960);
		for (let index = 0; index < 480; index += 1)
			frame.writeInt16LE(Math.round(8_000 * Math.sin(index / 5)), index * 2);
		for (let index = 0; index < 5; index += 1)
			expect(leg.writePcm24(frame)).toBe(true);
		await vi.waitFor(() => expect(server.received.length).toBe(5), {
			timeout: 5_000,
		});
		const packets = server.received;
		for (const [index, packet] of packets.entries()) {
			expect(packet.header.payloadType).toBe(111);
			expect(opusPacketSamples48k(packet.payload)).toBe(960);
			if (index === 0) continue;
			const previous = packets[index - 1]!;
			expect(
				(packet.header.sequenceNumber - previous.header.sequenceNumber) &
					0xffff,
			).toBe(1);
			expect((packet.header.timestamp - previous.header.timestamp) >>> 0).toBe(
				960,
			);
		}
		// Only whole 20 ms frames are accepted.
		expect(leg.writePcm24(Buffer.alloc(958))).toBe(false);
		expect(leg.writePcm24(Buffer.alloc(1_920))).toBe(false);
	});

	it("passes downlink payloads through untouched with a side-channel voiced flag", async () => {
		const { server, downlink } = await connected();
		const loud = tone(12_000);
		server.send(loud);
		// The side decoder is stateful like any Opus decoder: the first quiet
		// packet still carries the loud frame's tail.
		for (let index = 0; index < 5; index += 1) server.send(tone(0));
		await vi.waitFor(() => expect(downlink).toHaveLength(6), {
			timeout: 5_000,
		});
		expect(Buffer.compare(downlink[0]!.payload, loud)).toBe(0);
		expect(downlink[0]!.voiced).toBe(true);
		expect(downlink[5]!.voiced).toBe(false);
		expect(downlink[5]!.rms).toBeLessThan(50);
	});

	it("drops duplicate and reordered downlink packets but keeps the stream", async () => {
		const { server, downlink, evidence } = await connected();
		const packet = tone(8_000);
		server.send(packet);
		server.repeat(packet);
		server.send(packet);
		await vi.waitFor(() => expect(downlink).toHaveLength(2), {
			timeout: 5_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(downlink).toHaveLength(2);
		expect(evidence).toContainEqual(
			expect.objectContaining({ kind: "webrtc_downlink_reorder_dropped" }),
		);
	});

	it("fails the generation on a downlink packet that is not exactly 960 samples", async () => {
		const { server, lost, downlink } = await connected();
		const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
		const ten = Buffer.from(encoder.encode(Buffer.alloc(480 * 4), 480));
		expect(opusPacketSamples48k(ten)).toBe(480);
		server.send(ten);
		await vi.waitFor(() => expect(lost).toEqual(["downlink_non960"]), {
			timeout: 5_000,
		});
		expect(downlink).toHaveLength(0);
	});

	it("forwards turn events tolerantly and never throws on malformed data", async () => {
		const { server, events, evidence } = await connected();
		const channel = server.channel!;
		channel.send("{not json");
		channel.send(JSON.stringify({ type: "turn.created" }));
		channel.send(JSON.stringify({ type: "turn.created", turn: { id: 7 } }));
		channel.send(
			JSON.stringify({
				type: "session.started",
				session: { id: "rtc_x", expires_at: 1_790_381_926 },
			}),
		);
		channel.send(
			JSON.stringify({
				type: "turn.created",
				turn: {
					id: "turn_a",
					role: "user",
					start_ms: 1_600,
					end_ms: 1_800,
					transcript: "你好",
				},
			}),
		);
		channel.send(
			JSON.stringify({
				type: "turn.done",
				turn: { id: "turn_b", role: "assistant", transcript: "好的。" },
			}),
		);
		channel.send(JSON.stringify({ type: "output_transcript.added" }));
		await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 5_000 });
		expect(events).toEqual([
			{ type: "session.started", expiresAt: 1_790_381_926 },
			{
				type: "turn.created",
				turnId: "turn_a",
				role: "user",
				startMs: 1_600,
				endMs: 1_800,
				transcript: "你好",
			},
			{
				type: "turn.done",
				turnId: "turn_b",
				role: "assistant",
				startMs: null,
				endMs: null,
				transcript: "好的。",
			},
		]);
		await vi.waitFor(() =>
			expect(evidence).toContainEqual(
				expect.objectContaining({
					kind: "webrtc_data_event_counts",
				}),
			),
		);
	});

	it("reports the generation lost when connected downlink stays silent", async () => {
		const { lost } = await connected({ downlinkSilenceMs: 200 });
		await vi.waitFor(() => expect(lost).toEqual(["downlink_silent"]), {
			timeout: 5_000,
		});
	});

	it("reports the generation lost once when the peer goes away and close is idempotent", async () => {
		const { leg, server, lost } = await connected();
		await server.pc.close();
		await vi.waitFor(() => expect(lost.length).toBeGreaterThan(0), {
			timeout: 15_000,
		});
		expect(lost).toHaveLength(1);
		await leg.close();
		await leg.close();
		expect(leg.writePcm24(Buffer.alloc(960))).toBe(false);
	}, 20_000);

	it("releases every UDP socket after a connected session closes, so the daemon can exit (QA@1)", async () => {
		const udp = () =>
			process.getActiveResourcesInfo().filter((kind) => kind === "UDPWrap")
				.length;
		// Earlier legs in this file close asynchronously; nothing may linger.
		await vi.waitFor(() => expect(udp()).toBe(0), { timeout: 3_000 });
		const { leg, server } = await connected();
		expect(udp()).toBeGreaterThan(0);
		await leg.close();
		await server.pc.close();
		// werift 0.24.4 with max-compat left the unbundled transport's two host
		// sockets open after BUNDLE negotiation, keeping the process alive.
		await vi.waitFor(() => expect(udp()).toBe(0), { timeout: 3_000 });
	}, 20_000);

	it("never reports a self-initiated close as lost", async () => {
		const { leg, lost } = await connected();
		await leg.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(lost).toEqual([]);
	});

	it("aborts while waiting for the answer to connect and closes the peer", async () => {
		const leg = new WebRtcLeg({
			stunUrls: [],
			onDownlink: () => undefined,
			onDataEvent: () => undefined,
			onLost: () => undefined,
		});
		legs.push(leg);
		const server = new FakeServer();
		servers.push(server);
		const offer = await leg.prepareOffer();
		const answer = await server.answer(offer);
		await server.pc.close();
		const controller = new AbortController();
		const pending = leg.acceptAnswer(answer, controller.signal);
		controller.abort(new Error("attempt_aborted"));
		await expect(pending).rejects.toThrow(/attempt_aborted|webrtc_leg_closed/);
		expect(leg.writePcm24(Buffer.alloc(960))).toBe(false);
	});
});
