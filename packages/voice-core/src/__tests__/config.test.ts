import { describe, expect, it } from "vitest";
import {
	resolveConfig,
	verifyAnnounceComponents,
	verifyBrainComponents,
	verifyConverseComponents,
} from "../config.js";
import type { VoiceError } from "../types.js";

function catchErr(fn: () => void): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error("expected throw");
}

describe("resolveConfig", () => {
	it("applies override > env > default precedence", () => {
		const env = {
			FLYWHEEL_VOICE_VOICE: "en-US-EnvNeural",
			FLYWHEEL_VOICE_GEMINI_MODEL: "gemini-env",
			FLYWHEEL_VOICE_TTS_TIMEOUT_MS: "5000",
		} as NodeJS.ProcessEnv;
		const c = resolveConfig({ voice: "en-US-Override" }, env);
		expect(c.voice).toBe("en-US-Override"); // override wins
		expect(c.gemini.model).toBe("gemini-env"); // env over default
		expect(c.timeouts.ttsMs).toBe(5000);
		expect(c.defaultAnnounceBackendId).toBe("edge-tts"); // default
		expect(c.defaultConverseBackendId).toBe("gemini-live");
		expect(c.timeouts.brainMs).toBe(120_000);
	});

	it("splits edge-tts args from env", () => {
		const c = resolveConfig({}, {
			FLYWHEEL_VOICE_EDGE_TTS_CMD: "python",
			FLYWHEEL_VOICE_EDGE_TTS_ARGS: "-m edge_tts",
		} as NodeJS.ProcessEnv);
		expect(c.edgeTts.command).toBe("python");
		expect(c.edgeTts.args).toEqual(["-m", "edge_tts"]);
	});

	it("defaults edge-tts command + gemini apiKeyEnv", () => {
		const c = resolveConfig({}, {} as NodeJS.ProcessEnv);
		expect(c.edgeTts.command).toBe("edge-tts");
		expect(c.gemini.apiKeyEnv).toBe("GEMINI_API_KEY");
	});

	it("defaults gemini model to the live-verified gemini-3.1-flash-live-preview", () => {
		const c = resolveConfig({}, {});
		expect(c.gemini.model).toBe("gemini-3.1-flash-live-preview");
	});

	it("resolves micDevice: override > env > ':default'", () => {
		expect(resolveConfig({}, {}).micDevice).toBe(":default");
		expect(
			resolveConfig({}, { FLYWHEEL_VOICE_MIC_DEVICE: ":2" }).micDevice,
		).toBe(":2");
		expect(
			resolveConfig({ micDevice: ":1" }, { FLYWHEEL_VOICE_MIC_DEVICE: ":2" })
				.micDevice,
		).toBe(":1");
	});
});

describe("fail-fast component checks", () => {
	it("announce: throws when edge-tts command is empty", () => {
		// resolveConfig itself always defaults the command, so hand-build the bad shape.
		const c = {
			...resolveConfig({}, {} as NodeJS.ProcessEnv),
			edgeTts: { command: "", args: [] },
		};
		const err = catchErr(() => verifyAnnounceComponents(c));
		expect((err as VoiceError).code).toBe("component-missing");
	});

	it("announce: passes with a command set", () => {
		const c = resolveConfig({}, {} as NodeJS.ProcessEnv);
		expect(() => verifyAnnounceComponents(c)).not.toThrow();
	});

	it("converse: throws when the API key env is unset", () => {
		const c = resolveConfig({}, {} as NodeJS.ProcessEnv);
		const err = catchErr(() =>
			verifyConverseComponents(c, {} as NodeJS.ProcessEnv),
		);
		expect((err as VoiceError).code).toBe("component-missing");
		expect((err as VoiceError).message).toContain("GEMINI_API_KEY");
	});

	it("converse: passes when the API key is present", () => {
		const c = resolveConfig({}, {} as NodeJS.ProcessEnv);
		expect(() =>
			verifyConverseComponents(c, { GEMINI_API_KEY: "k" } as NodeJS.ProcessEnv),
		).not.toThrow();
	});

	it("brain: throws when identity file unset or missing", () => {
		const noId = resolveConfig({}, {} as NodeJS.ProcessEnv);
		expect(
			(catchErr(() => verifyBrainComponents(noId)) as VoiceError).code,
		).toBe("component-missing");
		const badPath = resolveConfig(
			{ identityFile: "/no/such/id.md" },
			{} as NodeJS.ProcessEnv,
		);
		expect(
			(
				catchErr(() =>
					verifyBrainComponents(badPath, () => false),
				) as VoiceError
			).code,
		).toBe("component-missing");
		const ok = resolveConfig(
			{ identityFile: "/ok/id.md" },
			{} as NodeJS.ProcessEnv,
		);
		expect(() => verifyBrainComponents(ok, () => true)).not.toThrow();
	});
});
