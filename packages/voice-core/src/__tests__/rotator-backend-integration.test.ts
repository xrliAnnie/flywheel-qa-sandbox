/**
 * Integration: TalkSessionRotator + the REAL GeminiLiveBackend session, wired the
 * same way cli.ts wires them (FLY-959 bug 2). The rotator unit tests use a
 * FakeSession and the backend unit tests never involve the rotator — this test
 * closes the seam between the two halves: a server goAway on a real backend
 * session must drive the rotator to close it, carry the resume handle, and open
 * a RESUMED backend session that connects with that exact handle.
 */
import { describe, expect, it } from "vitest";
import {
	GeminiLiveBackend,
	type GeminiModelProfile,
} from "../backends/gemini/GeminiLiveBackend.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "../backends/gemini/transport.js";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import type { AudioFormat, ConversationSession } from "../types.js";
import { FakeBrain } from "./fakes.js";

const PCM: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};

class RecordingConnection implements LiveConnection {
	sentAudio: Buffer[] = [];
	closed = false;
	private cb?: (e: LiveServerEvent) => void;
	constructor(readonly params: LiveConnectParams) {}
	sendAudio(frame: Buffer): void {
		this.sentAudio.push(frame);
	}
	sendText(): void {}
	sendToolResponse(): void {}
	onEvent(cb: (e: LiveServerEvent) => void): void {
		this.cb = cb;
	}
	emit(e: LiveServerEvent): void {
		this.cb?.(e);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class RecordingTransport implements GeminiLiveTransport {
	readonly connections: RecordingConnection[] = [];
	async connect(params: LiveConnectParams): Promise<LiveConnection> {
		const conn = new RecordingConnection(params);
		this.connections.push(conn);
		return conn;
	}
}

const profile = (): GeminiModelProfile => ({
	model: "gemini-3.1-flash-live-preview",
	asyncFunctionCalling: false,
	connectionSec: 600,
	audioSec: 900,
});

const tick = () => new Promise((r) => setImmediate(r));

describe("TalkSessionRotator + GeminiLiveBackend (goAway → resume, end-to-end)", () => {
	function wire() {
		const transport = new RecordingTransport();
		const backend = new GeminiLiveBackend({ transport, profile: profile() });
		const attached: ConversationSession[] = [];
		const logs: string[] = [];
		const errors: unknown[] = [];
		const rotator = new TalkSessionRotator({
			create: (resumeHandle) =>
				(
					backend.createConversation as NonNullable<
						typeof backend.createConversation
					>
				)({ brain: new FakeBrain([]), resumeHandle }),
			attach: (s) => attached.push(s),
			log: (l) => logs.push(l),
			onError: (e) => errors.push(e),
		});
		return { transport, rotator, attached, logs, errors };
	}

	it("carries the backend's resume handle from a goAway into the resumed connection", async () => {
		const { transport, rotator, attached, logs, errors } = wire();
		await rotator.start();
		expect(transport.connections).toHaveLength(1);
		expect(transport.connections[0].params.resumeHandle).toBeUndefined();

		// server rolls a resume handle forward, then tells us it's going away.
		transport.connections[0].emit({ type: "resumption-update", handle: "H1" });
		transport.connections[0].emit({ type: "go-away", timeLeftSec: 30 });
		await tick(); // let the async rotate() run

		expect(errors).toHaveLength(0);
		expect(transport.connections[0].closed).toBe(true); // old session torn down
		expect(transport.connections).toHaveLength(2); // resumed session opened
		expect(transport.connections[1].params.resumeHandle).toBe("H1"); // the exact handle
		expect(attached).toHaveLength(2); // CLI handlers rebound onto the new session
		expect(logs.some((l) => l.includes("resumed"))).toBe(true);
	});

	it("routes post-rotation mic frames to the resumed connection, not the dead one", async () => {
		const { transport, rotator } = wire();
		await rotator.start();
		transport.connections[0].emit({ type: "resumption-update", handle: "H1" });
		transport.connections[0].emit({ type: "go-away", timeLeftSec: 30 });
		await tick();

		rotator.sendAudio(Buffer.from("post"), PCM);
		expect(transport.connections[0].sentAudio).toHaveLength(0); // dead conn untouched
		expect(transport.connections[1].sentAudio).toHaveLength(1); // resumed conn fed
	});

	it("a goAway with no prior resume handle restarts fresh (no handle carried)", async () => {
		const { transport, rotator, logs } = wire();
		await rotator.start();
		// no resumption-update emitted → backend close() yields no handle
		transport.connections[0].emit({ type: "go-away", timeLeftSec: 30 });
		await tick();

		expect(transport.connections).toHaveLength(2);
		expect(transport.connections[1].params.resumeHandle).toBeUndefined();
		expect(logs.some((l) => l.includes("context lost"))).toBe(true);
	});
});
