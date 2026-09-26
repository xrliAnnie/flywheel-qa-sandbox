/**
 * FLY-967 P1 — assistant-mode voice-core increments at the backend↔transport
 * seam: systemPreamble passthrough (meeting-briefing injection) and the
 * sendText control channel (open/recap prompts the founder never hears).
 * Default-unset paths assert byte-compat with current behavior (talk CLI /
 * FLY-545 untouched).
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
import { TypedEmitter } from "../emitter.js";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import type {
	ConversationEventMap,
	ConversationSession,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
} from "../types.js";
import { FakeBrain } from "./fakes.js";

class FakeConnection implements LiveConnection {
	sentTexts: string[] = [];
	closed = false;
	private cb?: (e: LiveServerEvent) => void;
	constructor(readonly params: LiveConnectParams) {}
	sendAudio(): void {}
	sendText(text: string): void {
		this.sentTexts.push(text);
	}
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

class FakeTransport implements GeminiLiveTransport {
	lastConnection?: FakeConnection;
	async connect(params: LiveConnectParams): Promise<LiveConnection> {
		this.lastConnection = new FakeConnection(params);
		return this.lastConnection;
	}
}

const profile: GeminiModelProfile = {
	model: "gemini-live-test",
	asyncFunctionCalling: false,
};

async function makeSession(opts: {
	systemPreamble?: string;
	systemHint?: string;
}) {
	const transport = new FakeTransport();
	const backend = new GeminiLiveBackend({ transport, profile });
	const session = await (
		backend.createConversation as NonNullable<typeof backend.createConversation>
	)({
		brain: new FakeBrain([]),
		...opts,
	});
	return { session, conn: transport.lastConnection as FakeConnection };
}

describe("systemPreamble passthrough (FLY-967 briefing injection)", () => {
	it("passes systemPreamble and systemHint to connect params separately", async () => {
		const { conn } = await makeSession({
			systemPreamble: "[简报 15:00] board: FLY-1 In Progress",
			systemHint: "short spoken sentences",
		});
		expect(conn.params.systemPreamble).toBe(
			"[简报 15:00] board: FLY-1 In Progress",
		);
		expect(conn.params.systemHint).toBe("short spoken sentences");
	});

	it("omits systemPreamble by default — byte-compat with current callers", async () => {
		const { conn } = await makeSession({ systemHint: "hint only" });
		expect(conn.params.systemPreamble).toBeUndefined();
		expect(conn.params.systemHint).toBe("hint only");
	});
});

describe("sendText control channel (FLY-967 open/recap prompts)", () => {
	it("forwards the control prompt verbatim to the live connection", async () => {
		const { session, conn } = await makeSession({});
		session.sendText("请用一两句开场,报出简报时间");
		session.sendText("请做 recap");
		expect(conn.sentTexts).toEqual([
			"请用一两句开场,报出简报时间",
			"请做 recap",
		]);
	});

	it("control prompts write nothing to the transcript sink (not the founder's words)", async () => {
		const entries: unknown[] = [];
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile });
		const session = await (
			backend.createConversation as NonNullable<
				typeof backend.createConversation
			>
		)({
			brain: new FakeBrain([]),
			transcriptSink: {
				append: (e) => {
					entries.push(e);
				},
			},
		});
		session.sendText("控制提示");
		expect(entries).toEqual([]);
	});
});

/** rotator-facing fake session with sendText recording + expiry trigger. */
class FakeSession implements ConversationSession {
	readonly sessionId: string;
	texts: string[] = [];
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	constructor(id: string) {
		this.sessionId = id;
	}
	sendAudio(): void {}
	sendText(text: string): void {
		this.texts.push(text);
	}
	interrupt(): void {}
	injectToolResult(_r: ToolResult, _s?: ScheduleHint): void {}
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		return this.emitter.on(e, h);
	}
	expire(): void {
		this.emitter.emit("session-expiring", { inSec: 10 });
	}
	async close(): Promise<ResumeHandle | undefined> {
		return { backendId: "gemini-live", payload: `h-${this.sessionId}` };
	}
}

describe("TalkSessionRotator.sendText forwarding (FLY-967)", () => {
	it("forwards to the current session, and to the successor after rotation", async () => {
		const sessions = [new FakeSession("s1"), new FakeSession("s2")];
		let i = 0;
		const rotator = new TalkSessionRotator({
			create: async () => sessions[i++] as ConversationSession,
			attach: () => {},
		});
		await rotator.start();
		rotator.sendText("给 s1");
		sessions[0].expire();
		await new Promise((r) => setTimeout(r, 5)); // rotation settles
		rotator.sendText("给 s2");
		expect(sessions[0].texts).toEqual(["给 s1"]);
		expect(sessions[1].texts).toEqual(["给 s2"]);
	});
});
