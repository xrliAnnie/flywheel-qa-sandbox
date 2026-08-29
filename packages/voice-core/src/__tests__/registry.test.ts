import { describe, expect, it } from "vitest";
import {
	assertBackendConsistent,
	BackendRegistry,
} from "../backends/registry.js";
import {
	type VoiceBackend,
	type VoiceBackendCapabilities,
	VoiceError,
} from "../types.js";

const caps = (
	over: Partial<VoiceBackendCapabilities>,
): VoiceBackendCapabilities => ({
	announce: false,
	converse: false,
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
});
