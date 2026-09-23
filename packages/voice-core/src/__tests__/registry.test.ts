import { describe, expect, it } from "vitest";
import {
	assertBackendConsistent,
	BackendRegistry,
} from "../backends/registry.js";
import {
	type ConversationOptions,
	type ConversationSession,
	type VoiceBackend,
	type VoiceBackendCapabilities,
	VoiceError,
} from "../types.js";

const caps = (
	over: Partial<VoiceBackendCapabilities>,
): VoiceBackendCapabilities => ({
	announce: false,
	converse: false,
	verbatim: false,
	attribution: false,
	bargeIn: false,
	toolCallScheduling: "none",
	transcriptGranularity: "final-only",
	supportsResume: false,
	voiceCloning: false,
	audioOut: [],
	...over,
});

const announceBackend: VoiceBackend = {
	id: "edge-tts",
	capabilities: caps({ announce: true }),
	createAnnouncer: async () => {
		throw new Error("not used");
	},
};

describe("BackendRegistry", () => {
	it("creates a registered backend by id", async () => {
		const r = new BackendRegistry();
		r.register("edge-tts", () => announceBackend);
		expect(r.has("edge-tts")).toBe(true);
		expect((await r.create("edge-tts")).id).toBe("edge-tts");
	});

	it("fails fast on an unknown id", async () => {
		const r = new BackendRegistry();
		r.register("edge-tts", () => announceBackend);
		const err = await r.create("gemini-live").catch((e) => e);
		expect(err).toBeInstanceOf(VoiceError);
		expect((err as VoiceError).code).toBe("unsupported");
		expect((err as VoiceError).message).toContain("gemini-live");
		expect((err as VoiceError).message).toContain("edge-tts");
	});

	it("fails fast when a declared face has no factory method (consistency)", async () => {
		const bad: VoiceBackend = {
			id: "bad",
			capabilities: caps({ converse: true }),
		}; // no createConversation
		const r = new BackendRegistry();
		r.register("bad", () => bad);
		const err = await r.create("bad").catch((e) => e);
		expect((err as VoiceError).code).toBe("unsupported");
		expect((err as VoiceError).message).toContain("converse=true");
	});

	it("assertBackendConsistent catches announce/converse mismatch directly", () => {
		expect(() =>
			assertBackendConsistent({
				id: "x",
				capabilities: caps({ announce: true }),
			}),
		).toThrowError(/announce=true/);
		expect(() =>
			assertBackendConsistent({
				id: "x",
				capabilities: caps({ converse: true }),
			}),
		).toThrowError(/converse=true/);
	});

	it("supports lazy factories", async () => {
		const r = new BackendRegistry();
		let built = 0;
		r.register("edge-tts", () => {
			built++;
			return announceBackend;
		});
		expect(built).toBe(0);
		await r.create("edge-tts");
		expect(built).toBe(1);
	});

	it("admits only contract-versioned sessions through the V1 getter", async () => {
		const baseSession: ConversationSession = {
			sessionId: "session-1",
			sendAudio() {},
			sendText() {},
			injectContext() {},
			endUserTurn() {},
			interrupt() {},
			injectToolResult() {},
			on: () => () => {},
			close: async () => undefined,
		};
		const v1Session = {
			...baseSession,
			contractVersion: 1,
			effectiveCapabilities: {
				verbatim: false,
				attribution: false,
				turnCancelOrSuppress: true,
			},
			speak: async () => ({
				pendingKey: "pending-1",
				requestDigest: "digest-1",
				outcome: "rejected",
				reason: "not_live",
				transport: "none",
				contentProof: "none",
			}),
			onUtterance: () => () => {},
		};
		const options = { brain: { async *respond() {} } } as ConversationOptions;
		const registry = new BackendRegistry();
		registry.register("v1", () => ({
			id: "v1",
			capabilities: caps({ converse: true }),
			createConversation: async () => v1Session,
		}));
		registry.register("legacy", () => ({
			id: "legacy",
			capabilities: caps({ converse: true }),
			createConversation: async () => baseSession,
		}));

		const v1 = await (
			registry as unknown as {
				createV1Conversation(
					id: string,
					opts: ConversationOptions,
				): Promise<typeof v1Session>;
			}
		).createV1Conversation("v1", options);
		expect(v1).toBe(v1Session);
		await expect(
			(
				registry as unknown as {
					createV1Conversation(
						id: string,
						opts: ConversationOptions,
					): Promise<typeof v1Session>;
				}
			).createV1Conversation("legacy", options),
		).rejects.toThrow(/V1 conversation contract/);
	});
});
