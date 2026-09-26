import OpusScript from "opusscript";
import {
	MediaStreamTrack,
	type RTCDataChannel,
	type RTCDtlsTransport,
	RTCPeerConnection,
	RTCRtpCodecParameters,
	RtpHeader,
	RtpPacket,
} from "werift";

/** One 20 ms frame of 24 kHz mono PCM16: the only uplink shape this leg takes. */
export const WEBRTC_PCM24_FRAME_BYTES = 960;
const PCM24_FRAME_SAMPLES = 480;
/** RTP clock is 48 kHz for Opus; 20 ms advances the timestamp by 960. */
const RTP_SAMPLES_PER_FRAME = 960;
const OPUS_PAYLOAD_TYPE = 111;
const ICE_GATHER_TIMEOUT_MS = 8_000;
/** Each transport gets this long to stop on close before it is abandoned. */
const TRANSPORT_STOP_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECTED_GRACE_MS = 5_000;
const DOWNLINK_SILENCE_MS = 5_000;
const LIVENESS_CHECK_MS = 250;
/** Same voiced threshold as the FLY-2884 prototype's side-channel RMS. */
const VOICED_RMS = 400;
const EVIDENCE_EVERY_EVENTS = 50;

export type RealtimeDataEvent =
	| { type: "session.started"; expiresAt: number | null }
	| {
			type: "turn.created" | "turn.done";
			turnId: string;
			role: "user" | "assistant";
			startMs: number | null;
			endMs: number | null;
			transcript: string | null;
	  };

export interface DownlinkPacket {
	/** The Opus payload exactly as received; it is never re-encoded. */
	payload: Buffer;
	voiced: boolean;
	rms: number;
	sequence: number;
	receivedAtMs: number;
}

/** The media half of one realtime generation. */
export interface RealtimeMediaLeg {
	prepareOffer(signal?: AbortSignal): Promise<string>;
	acceptAnswer(sdp: string, signal?: AbortSignal): Promise<void>;
	writePcm24(frame: Buffer): boolean;
	close(): Promise<void>;
}

export interface WebRtcLegOptions {
	stunUrls: string[];
	onDownlink(packet: DownlinkPacket): void;
	onDataEvent(event: RealtimeDataEvent): void;
	/** Once per leg; never for a close this leg started itself. */
	onLost(reason: string): void;
	onEvidence?(record: Record<string, unknown>): void;
	now?: () => number;
	downlinkSilenceMs?: number;
	disconnectedGraceMs?: number;
	/** Tests only: prove close() releases transports BUNDLE dropped. */
	bundlePolicy?: "max-bundle" | "max-compat";
}

/** A transport stop that never hangs close(). */
async function boundedStop(stop: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			stop,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("webrtc_transport_stop_timeout")),
					TRANSPORT_STOP_TIMEOUT_MS,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Samples per channel at 48 kHz in one Opus packet (RFC 6716 §3.1). */
export function opusPacketSamples48k(packet: Buffer): number {
	if (packet.length < 1) return 0;
	const toc = packet[0]!;
	const config = toc >> 3;
	const frameMs =
		config < 12
			? [10, 20, 40, 60][config & 3]!
			: config < 16
				? [10, 20][config & 1]!
				: [2.5, 5, 10, 20][config & 3]!;
	const code = toc & 3;
	const frames =
		code === 0
			? 1
			: code === 3
				? packet.length > 1
					? packet[1]! & 0x3f
					: 0
				: 2;
	return Math.round(frameMs * 48 * frames);
}

function stereoRms(pcm48Stereo: Buffer): number {
	const samples = Math.floor(pcm48Stereo.length / 4);
	if (samples === 0) return 0;
	let sum = 0;
	for (let index = 0; index < samples; index += 1) {
		const mono =
			(pcm48Stereo.readInt16LE(index * 4) +
				pcm48Stereo.readInt16LE(index * 4 + 2)) /
			2;
		sum += mono * mono;
	}
	return Math.sqrt(sum / samples);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("webrtc_attempt_aborted");
}

/**
 * The WebRTC half of engine B (FLY-2885 T2). The app-server only negotiates
 * the call; the peer connection, its audio and its data channel live here, so
 * a lost peer is only visible to this process.
 *
 * Uplink: 24 kHz mono PCM from the existing 2799 room pipeline, encoded once
 * to Opus. Downlink: payloads are forwarded as received; a side decoder only
 * measures level and never feeds audio back.
 */
export class WebRtcLeg implements RealtimeMediaLeg {
	private readonly pc: RTCPeerConnection;
	private readonly track = new MediaStreamTrack({ kind: "audio" });
	private readonly channel: RTCDataChannel;
	private readonly encoder = new OpusScript(
		24_000,
		1,
		OpusScript.Application.VOIP,
	);
	private readonly meter = new OpusScript(
		48_000,
		2,
		OpusScript.Application.VOIP,
	);
	private readonly now: () => number;
	private sequence = Math.floor(Math.random() * 0x10000);
	private timestamp = Math.floor(Math.random() * 0x100000000);
	private connected = false;
	private closing = false;
	private lostReported = false;
	private disconnectedTimer?: ReturnType<typeof setTimeout>;
	private livenessTimer?: ReturnType<typeof setInterval>;
	private lastDownlinkAt = 0;
	private lastDownlinkSequence?: number;
	private closePromise?: Promise<void>;
	/**
	 * Every ICE/DTLS transport werift created for this leg. werift derives
	 * its own list from the current transceivers, so a transport BUNDLE
	 * replaced drops out of it and pc.close() never stops it; the leg stops
	 * each one itself (FLY-2885 QA@1).
	 */
	private readonly transports = new Set<RTCDtlsTransport>();
	/** Aborted by close(): any wait in progress stops instead of hanging. */
	private readonly closed = new AbortController();
	private readonly counts = {
		uplinkPackets: 0,
		uplinkFailures: 0,
		downlinkPackets: 0,
		downlinkDropped: 0,
		downlinkDecodeErrors: 0,
		dataEvents: 0,
		dataMalformed: 0,
		dataIgnored: 0,
	};

	constructor(private readonly options: WebRtcLegOptions) {
		this.now = options.now ?? (() => performance.now());
		this.pc = new RTCPeerConnection({
			codecs: {
				audio: [
					new RTCRtpCodecParameters({
						mimeType: "audio/opus",
						clockRate: 48_000,
						channels: 2,
						payloadType: OPUS_PAYLOAD_TYPE,
						parameters: "minptime=10;useinbandfec=1",
					}),
				],
				video: [],
			},
			iceServers: options.stunUrls.map((urls) => ({ urls })),
			// One ICE/DTLS transport for audio and the data channel. With
			// werift 0.24.4's default max-compat an offer gathers a transport per
			// m-line, and once the answer bundles them the dropped one is no
			// longer tracked: pc.close() leaves its two host UDP sockets open and
			// the daemon never exits (FLY-2885 QA@1). The realtime endpoint
			// answers "a=group:BUNDLE 0 1" (live check 2026-09-26).
			bundlePolicy: options.bundlePolicy ?? "max-bundle",
		});
		this.pc.addTransceiver(this.track, { direction: "sendrecv" });
		this.channel = this.pc.createDataChannel("oai-events");
		this.channel.onMessage.subscribe((data) => this.dataMessage(data));
		this.channel.stateChanged.subscribe((state) => {
			if (state === "closed" && this.connected) this.lost("datachannel_closed");
		});
		this.pc.onTrack.subscribe((track) =>
			track.onReceiveRtp.subscribe((rtp) => this.downlink(rtp)),
		);
		this.pc.connectionStateChange.subscribe((state) =>
			this.connectionState(state),
		);
	}

	async prepareOffer(signal?: AbortSignal): Promise<string> {
		this.assertOpen(signal);
		const offer = await this.guard(this.pc.createOffer(), signal);
		await this.guard(this.pc.setLocalDescription(offer), signal);
		this.trackTransports();
		await this.until(
			() => this.pc.iceGatheringState === "complete",
			(done) => this.pc.iceGatheringStateChange.subscribe(done).unSubscribe,
			ICE_GATHER_TIMEOUT_MS,
			signal,
			// A partial candidate set can still connect; the answer decides.
			false,
		);
		this.assertOpen(signal);
		const sdp = this.pc.localDescription?.sdp;
		if (!sdp) throw new Error("webrtc_offer_missing");
		return sdp;
	}

	async acceptAnswer(sdp: string, signal?: AbortSignal): Promise<void> {
		this.assertOpen(signal);
		if (typeof sdp !== "string" || !sdp.startsWith("v=0"))
			throw new Error("webrtc_answer_invalid");
		try {
			await this.guard(
				this.pc.setRemoteDescription({ type: "answer", sdp }),
				signal,
			);
			this.trackTransports();
			await this.until(
				() => this.pc.connectionState === "connected",
				(done) => this.pc.connectionStateChange.subscribe(done).unSubscribe,
				CONNECT_TIMEOUT_MS,
				signal,
				true,
			);
			this.assertOpen(signal);
		} catch (error) {
			await this.close();
			throw signal?.aborted ? abortError(signal) : error;
		}
		this.connected = true;
		this.lastDownlinkAt = this.now();
		const silenceMs = this.options.downlinkSilenceMs ?? DOWNLINK_SILENCE_MS;
		this.livenessTimer = setInterval(
			() => {
				if (this.now() - this.lastDownlinkAt > silenceMs)
					this.lost("downlink_silent");
			},
			Math.min(LIVENESS_CHECK_MS, Math.max(20, Math.floor(silenceMs / 4))),
		);
		this.livenessTimer.unref?.();
	}

	writePcm24(frame: Buffer): boolean {
		if (!this.connected || this.closing) return false;
		if (frame.length !== WEBRTC_PCM24_FRAME_BYTES) return false;
		try {
			const payload = Buffer.from(
				this.encoder.encode(frame, PCM24_FRAME_SAMPLES),
			);
			this.sequence = (this.sequence + 1) & 0xffff;
			this.timestamp = (this.timestamp + RTP_SAMPLES_PER_FRAME) >>> 0;
			this.track.writeRtp(
				new RtpPacket(
					new RtpHeader({
						payloadType: OPUS_PAYLOAD_TYPE,
						sequenceNumber: this.sequence,
						timestamp: this.timestamp,
						marker: false,
					}),
					payload,
				),
			);
			this.counts.uplinkPackets += 1;
			return true;
		} catch (error) {
			this.counts.uplinkFailures += 1;
			this.options.onEvidence?.({
				kind: "webrtc_uplink_write_failed",
				reason: error instanceof Error ? error.message : String(error),
				failures: this.counts.uplinkFailures,
			});
			return false;
		}
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeOnce();
		return this.closePromise;
	}

	private async closeOnce(): Promise<void> {
		this.closing = true;
		this.connected = false;
		this.clearTimers();
		this.closed.abort(new Error("webrtc_leg_closed"));
		this.trackTransports();
		try {
			await this.pc.close();
		} catch {
			// The peer is being discarded either way.
		}
		// Stop every transport explicitly, including any pc.close() missed:
		// their UDP sockets otherwise keep the daemon alive.
		let transportsReleased = 0;
		for (const transport of this.transports) {
			try {
				await boundedStop(transport.stop());
				await boundedStop(transport.iceTransport.stop());
				transportsReleased += 1;
			} catch (error) {
				this.options.onEvidence?.({
					kind: "webrtc_transport_stop_failed",
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.transports.clear();
		for (const codec of [this.encoder, this.meter]) {
			try {
				codec.delete();
			} catch {
				// Already released.
			}
		}
		this.options.onEvidence?.({
			kind: "webrtc_leg_closed",
			...this.counts,
			transportsReleased,
		});
	}

	private connectionState(state: string): void {
		if (this.closing) return;
		if (state === "connected") {
			if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
			this.disconnectedTimer = undefined;
			return;
		}
		if (!this.connected) return;
		if (state === "failed" || state === "closed") {
			this.lost(state);
			return;
		}
		if (state === "disconnected" && !this.disconnectedTimer) {
			this.disconnectedTimer = setTimeout(
				() => this.lost("disconnected"),
				this.options.disconnectedGraceMs ?? DISCONNECTED_GRACE_MS,
			);
			this.disconnectedTimer.unref?.();
		}
	}

	private downlink(rtp: RtpPacket): void {
		if (this.closing || this.lostReported) return;
		const sequence = rtp.header.sequenceNumber;
		if (this.lastDownlinkSequence !== undefined) {
			const step = (sequence - this.lastDownlinkSequence) & 0xffff;
			if (step === 0 || step > 0x8000) {
				this.counts.downlinkDropped += 1;
				this.options.onEvidence?.({
					kind: "webrtc_downlink_reorder_dropped",
					sequence,
					lastSequence: this.lastDownlinkSequence,
					dropped: this.counts.downlinkDropped,
				});
				return;
			}
		}
		const payload = Buffer.from(rtp.payload);
		const samples = opusPacketSamples48k(payload);
		if (samples !== RTP_SAMPLES_PER_FRAME) {
			this.options.onEvidence?.({
				kind: "downlink_non960",
				samples,
				bytes: payload.length,
			});
			this.lost("downlink_non960");
			return;
		}
		this.lastDownlinkSequence = sequence;
		this.lastDownlinkAt = this.now();
		this.counts.downlinkPackets += 1;
		let rms = 0;
		try {
			rms = stereoRms(Buffer.from(this.meter.decode(payload)));
		} catch {
			this.counts.downlinkDecodeErrors += 1;
		}
		this.options.onDownlink({
			payload,
			voiced: rms > VOICED_RMS,
			rms,
			sequence,
			receivedAtMs: this.lastDownlinkAt,
		});
	}

	private dataMessage(data: string | Buffer): void {
		if (this.closing) return;
		this.counts.dataEvents += 1;
		let event: Record<string, unknown> | undefined;
		try {
			event = record(JSON.parse(data.toString()));
		} catch {
			event = undefined;
		}
		const parsed = event ? this.dataEvent(event) : undefined;
		if (!event) this.counts.dataMalformed += 1;
		if (parsed) this.options.onDataEvent(parsed);
		if (this.counts.dataEvents % EVIDENCE_EVERY_EVENTS === 0 || !parsed) {
			this.options.onEvidence?.({
				kind: "webrtc_data_event_counts",
				events: this.counts.dataEvents,
				malformed: this.counts.dataMalformed,
				ignored: this.counts.dataIgnored,
			});
		}
	}

	/** Not a Codex protocol surface: every field is optional to us. */
	private dataEvent(
		event: Record<string, unknown>,
	): RealtimeDataEvent | undefined {
		if (event.type === "session.started") {
			return {
				type: "session.started",
				expiresAt: finiteOrNull(record(event.session)?.expires_at),
			};
		}
		if (event.type === "turn.created" || event.type === "turn.done") {
			const turn = record(event.turn);
			if (
				typeof turn?.id !== "string" ||
				turn.id.length === 0 ||
				(turn.role !== "user" && turn.role !== "assistant")
			) {
				this.counts.dataMalformed += 1;
				return undefined;
			}
			return {
				type: event.type,
				turnId: turn.id,
				role: turn.role,
				startMs: finiteOrNull(turn.start_ms),
				endMs: finiteOrNull(turn.end_ms),
				transcript:
					typeof turn.transcript === "string" ? turn.transcript : null,
			};
		}
		this.counts.dataIgnored += 1;
		return undefined;
	}

	private lost(reason: string): void {
		if (this.lostReported || this.closing) return;
		this.lostReported = true;
		this.connected = false;
		this.clearTimers();
		this.options.onEvidence?.({
			kind: "webrtc_leg_lost",
			reason,
			...this.counts,
		});
		this.options.onLost(reason);
	}

	private trackTransports(): void {
		for (const transport of this.pc.dtlsTransports)
			this.transports.add(transport);
	}

	private clearTimers(): void {
		if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
		if (this.livenessTimer) clearInterval(this.livenessTimer);
		this.disconnectedTimer = undefined;
		this.livenessTimer = undefined;
	}

	private assertOpen(signal?: AbortSignal): void {
		if (signal?.aborted) throw abortError(signal);
		if (this.closing) throw new Error("webrtc_leg_closed");
	}

	/** A peer call that may never settle once the peer is gone. */
	private guard<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		const signals = [this.closed.signal, ...(signal ? [signal] : [])];
		return new Promise<T>((resolve, reject) => {
			const onAbort = (event: Event) =>
				finish(() => reject(abortError(event.target as AbortSignal)));
			const finish = (settle: () => void) => {
				for (const item of signals) item.removeEventListener("abort", onAbort);
				settle();
			};
			for (const item of signals) {
				if (item.aborted) {
					reject(abortError(item));
					return;
				}
				item.addEventListener("abort", onAbort, { once: true });
			}
			promise.then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
		});
	}

	private until(
		ready: () => boolean,
		subscribe: (done: () => void) => () => void,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		timeoutFails: boolean,
	): Promise<void> {
		if (ready()) return Promise.resolve();
		const signals = [this.closed.signal, ...(signal ? [signal] : [])];
		return new Promise<void>((resolve, reject) => {
			const wait: {
				timer?: ReturnType<typeof setTimeout>;
				unsubscribe?: () => void;
			} = {};
			const finish = (error?: Error) => {
				if (wait.timer) clearTimeout(wait.timer);
				wait.unsubscribe?.();
				for (const item of signals) item.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onAbort = (event: Event) =>
				finish(abortError(event.target as AbortSignal));
			for (const item of signals) {
				if (item.aborted) {
					reject(abortError(item));
					return;
				}
				item.addEventListener("abort", onAbort, { once: true });
			}
			wait.timer = setTimeout(
				() =>
					timeoutFails ? finish(new Error("webrtc_connect_timeout")) : finish(),
				timeoutMs,
			);
			wait.timer.unref?.();
			wait.unsubscribe = subscribe(() => {
				if (ready()) finish();
				else if (
					timeoutFails &&
					(this.pc.connectionState === "failed" ||
						this.pc.connectionState === "closed")
				)
					finish(new Error(`webrtc_connect_${this.pc.connectionState}`));
			});
		});
	}
}
