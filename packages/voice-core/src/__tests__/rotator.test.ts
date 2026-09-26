import { describe, expect, it } from "vitest";
import { TypedEmitter } from "../emitter.js";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import type {
	AudioFormat,
	ConversationEventMap,
	ConversationSession,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
} from "../types.js";

const PCM: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	frames: Buffer[] = [];
	closed = false;
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	constructor(
		id: string,
		private readonly handleOnClose?: string,
	) {
		this.sessionId = id;
	}
	sendAudio(frame: Buffer): void {
		this.frames.push(frame);
	}
	sendText(): void {}
	interrupt(): void {}
	injectToolResult(_r: ToolResult, _s?: ScheduleHint): void {}
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		return this.emitter.on(e, h);
	}
	async close(): Promise<ResumeHandle | undefined> {
		this.closed = true;
		return this.handleOnClose
			? { backendId: "gemini-live", payload: this.handleOnClose }
			: undefined;
	}
	expire(): void {
		this.emitter.emit("session-expiring", { inSec: 50 });
	}
}

function harness(opts?: {
	handles?: (string | undefined)[]; // per-session close() handle
	failCreateAt?: number; // 1-based create() call that rejects
}) {
	const sessions: FakeSession[] = [];
	const createArgs: (ResumeHandle | undefined)[] = [];
	const attached: string[] = [];
	const logs: string[] = [];
	const errors: unknown[] = [];
	const rotator = new TalkSessionRotator({
		create: (resumeHandle) => {
			createArgs.push(resumeHandle);
			if (opts?.failCreateAt === createArgs.length)
				return Promise.reject(new Error("connect refused"));
			const s = new FakeSession(
				`s${createArgs.length}`,
				opts?.handles?.[sessions.length],
			);
			sessions.push(s);
			return Promise.resolve(s);
		},
		attach: (s) => attached.push(s.sessionId),
		log: (l) => logs.push(l),
		onError: (e) => errors.push(e),
	});
	return { rotator, sessions, createArgs, attached, logs, errors };
}

describe("TalkSessionRotator", () => {
	it("start() opens and attaches the first session", async () => {
		const h = harness();
		await h.rotator.start();
		expect(h.attached).toEqual(["s1"]);
		expect(h.createArgs).toEqual([undefined]);
	});

	it("session-expiring closes the old session and resumes with its handle", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.sessions[0].closed).toBe(true);
		expect(h.createArgs[1]).toEqual({
			backendId: "gemini-live",
			payload: "h-1",
		});
		expect(h.attached).toEqual(["s1", "s2"]);
		expect(h.logs.some((l) => l.includes("resumed"))).toBe(true);
	});

	it("falls back to a fresh session when close() yields no handle", async () => {
		const h = harness({ handles: [undefined] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs[1]).toBeUndefined();
		expect(h.logs.some((l) => l.includes("context lost"))).toBe(true);
	});

	it("is single-flight: double expiring triggers one rotation", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(2); // start + one rotation
	});

	it("ignores stale expiring from a rotated-out session (Codex R1 #1)", async () => {
		const h = harness({ handles: ["h-1", "h-2"] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r)); // s2 is live now
		h.sessions[0].expire(); // late/duplicate go-away from the OLD session
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(2); // no third create
		expect(h.sessions[1].closed).toBe(false); // s2 untouched
	});

	it("drops frames during rotation, then feeds the new session", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire(); // rotation begins; session detached synchronously
		h.rotator.sendAudio(Buffer.from("x"), PCM); // must not throw / not reach s1
		await new Promise((r) => setImmediate(r));
		h.rotator.sendAudio(Buffer.from("y"), PCM);
		expect(h.sessions[0].frames).toHaveLength(0);
		expect(h.sessions[1].frames).toHaveLength(1);
	});

	it("surfaces rotation failure via onError", async () => {
		const h = harness({ handles: ["h-1"], failCreateAt: 2 });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.errors).toHaveLength(1);
	});

	it("close() returns the live session's handle and stops rotation", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		const handle = await h.rotator.close();
		expect(handle).toEqual({ backendId: "gemini-live", payload: "h-1" });
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(1); // no rotation after close
	});
});
