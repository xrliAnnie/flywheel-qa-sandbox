/**
 * FLY-545 P2 — ProjectConfig validation for the optional `huddle` block and
 * the optional per-lead `voice` (edge-tts voice id, FLY-546-approved key).
 *
 * Contract: absent block/field = byte-compat (nothing normalized in);
 * present = type-checked fail-loud at the config boundary. Unknown keys
 * INSIDE huddle stay tolerated (loose-validation principle).
 */
import { describe, expect, it } from "vitest";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import { REALTIME_V2_VOICES } from "../realtime-voices.js";

function lead(over: Record<string, unknown> = {}) {
	return {
		agentId: "flywheel-eng-lead",
		summaryRole: "producer",
		chatChannel: "chan-1",
		match: { labels: ["Flywheel"] },
		...over,
	};
}

function entry(over: Record<string, unknown> = {}) {
	return {
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [lead()],
		...over,
	};
}

const validHuddle = {
	guildId: "g-1",
	voiceChannelId: "vc-1",
	orchestratorBotTokenEnv: "HUDDLE_ORCH_BOT_TOKEN",
	earsBotTokenEnv: "HUDDLE_EARS_BOT_TOKEN",
};

describe("LeadConfig.voice", () => {
	it("accepts an absent voice (byte-compat) and a non-empty string", () => {
		expect(() => parseAndValidateProjects([entry()])).not.toThrow();
		const projects = parseAndValidateProjects([
			entry({ leads: [lead({ voice: "zh-CN-YunxiNeural" })] }),
		]);
		expect(projects[0]!.leads[0]!.voice).toBe("zh-CN-YunxiNeural");
	});

	it("rejects an empty or non-string voice", () => {
		expect(() =>
			parseAndValidateProjects([entry({ leads: [lead({ voice: "" })] })]),
		).toThrow(/voice/);
		expect(() =>
			parseAndValidateProjects([entry({ leads: [lead({ voice: 42 })] })]),
		).toThrow(/voice/);
	});

	it("accepts the FLY-546 object form { voiceId, rate?, pitch? } (union parity with voice-bridge)", () => {
		const projects = parseAndValidateProjects([
			entry({
				leads: [
					lead({
						voice: {
							voiceId: "zh-CN-XiaoxiaoNeural",
							rate: "-10%",
							pitch: "+2Hz",
						},
					}),
				],
			}),
		]);
		expect(projects[0]!.leads[0]!.voice).toEqual({
			voiceId: "zh-CN-XiaoxiaoNeural",
			rate: "-10%",
			pitch: "+2Hz",
		});
	});

	it("rejects malformed object-form voices (empty voiceId / bad prosody grammar)", () => {
		for (const bad of [
			{ voiceId: "" },
			{ voiceId: 42 },
			{ voiceId: "x", rate: "fast" },
			{ voiceId: "x", pitch: "high" },
			["zh-CN-YunxiNeural"],
		]) {
			expect(() =>
				parseAndValidateProjects([entry({ leads: [lead({ voice: bad })] })]),
			).toThrow(/voice/);
		}
	});
});

describe("generic realtime voice registry fields", () => {
	it("keeps absent fields byte-compatible and accepts the locked modes and voices", () => {
		const unchanged = parseAndValidateProjects([entry()])[0]!.leads[0]!;
		expect("voiceModes" in unchanged).toBe(false);
		expect("realtimeVoice" in unchanged).toBe(false);
		expect("codexVoiceActions" in unchanged).toBe(false);
		expect(REALTIME_V2_VOICES).toEqual([
			"alloy",
			"ash",
			"ballad",
			"coral",
			"echo",
			"sage",
			"shimmer",
			"verse",
			"marin",
			"cedar",
		]);
		for (const realtimeVoice of REALTIME_V2_VOICES) {
			expect(() =>
				parseAndValidateProjects([
					entry({
						leads: [
							lead({
								voiceModes: { meeting: true, rg: false },
								realtimeVoice,
							}),
						],
					}),
				]),
			).not.toThrow();
		}
	});

	it("preserves only an explicit boolean standard-Lead voice action opt-in", () => {
		expect(
			parseAndValidateProjects([
				entry({ leads: [lead({ codexVoiceActions: true })] }),
			])[0]!.leads[0],
		).toHaveProperty("codexVoiceActions", true);
		for (const codexVoiceActions of ["true", 1, null, {}]) {
			expect(() =>
				parseAndValidateProjects([
					entry({ leads: [lead({ codexVoiceActions })] }),
				]),
			).toThrow(/codexVoiceActions/);
		}
	});

	it("rejects non-boolean modes, unknown mode keys, and unknown realtime voices", () => {
		for (const voiceModes of [
			{ meeting: "true" },
			{ rg: 1 },
			{ meeting: true, future: false },
			[],
		]) {
			expect(() =>
				parseAndValidateProjects([entry({ leads: [lead({ voiceModes })] })]),
			).toThrow(/voiceModes/);
		}
		expect(() =>
			parseAndValidateProjects([
				entry({ leads: [lead({ realtimeVoice: "nova" })] }),
			]),
		).toThrow(/realtimeVoice/);
	});
});

describe("ProjectEntry.voiceRoom", () => {
	const room = {
		guildId: "1485787271192907816",
		voiceChannelId: "1485787273193853170",
	};
	it("preserves absent/null rooms and accepts room-only configuration", () => {
		expect(parseAndValidateProjects([entry()])[0]).not.toHaveProperty(
			"voiceRoom",
		);
		expect(
			parseAndValidateProjects([entry({ voiceRoom: null })])[0]!.voiceRoom,
		).toBeNull();
		expect(
			parseAndValidateProjects([entry({ voiceRoom: room })])[0]!.voiceRoom,
		).toEqual(room);
	});
	it.each([
		true,
		[],
		"room",
		{},
		{ ...room, guildId: Number("1485787271192907816") },
		{ ...room, guildId: "1234567890123456" },
		{ ...room, voiceChannelId: "123456789012345678901" },
		{ ...room, guildId: " 1485787271192907816" },
		{ ...room, orchestratorBotTokenEnv: "OLD_TOKEN" },
	])("rejects malformed or extra room fields: %j", (voiceRoom) => {
		expect(() => parseAndValidateProjects([entry({ voiceRoom })])).toThrow(
			/voiceRoom/,
		);
	});
	it("leaves cross-project and legacy conflicts to voice admission", () => {
		expect(() =>
			parseAndValidateProjects([
				entry({ voiceRoom: room, huddle: validHuddle }),
				entry({
					projectName: "other",
					projectRoot: "/tmp/other",
					leads: [lead({ agentId: "other-lead" })],
					voiceRoom: { ...room, voiceChannelId: "123456789012345678" },
				}),
			]),
		).not.toThrow();
	});
});

describe("ProjectEntry.huddle", () => {
	it("accepts an absent huddle block (byte-compat) without normalizing one in", () => {
		const projects = parseAndValidateProjects([entry()]);
		expect("huddle" in projects[0]!).toBe(false);
	});

	it("treats huddle: null as no-huddle (deployed-roster null tolerance)", () => {
		expect(() =>
			parseAndValidateProjects([entry({ huddle: null })]),
		).not.toThrow();
	});

	it("accepts a valid huddle block verbatim (no default normalization)", () => {
		const projects = parseAndValidateProjects([entry({ huddle: validHuddle })]);
		expect(projects[0]!.huddle).toEqual(validHuddle);
	});

	it("accepts a validated orchestrator bot user id without requiring it for old huddles", () => {
		expect(() =>
			parseAndValidateProjects([entry({ huddle: validHuddle })]),
		).not.toThrow();
		const huddle = {
			...validHuddle,
			orchestratorBotUserId: "123456789012345678",
		};
		expect(parseAndValidateProjects([entry({ huddle })])[0]!.huddle).toEqual(
			huddle,
		);
	});

	it("accepts a validated ears bot user id without requiring it for old huddles", () => {
		expect(() =>
			parseAndValidateProjects([entry({ huddle: validHuddle })]),
		).not.toThrow();
		const huddle = {
			...validHuddle,
			earsBotUserId: "123456789012345679",
		};
		expect(parseAndValidateProjects([entry({ huddle })])[0]!.huddle).toEqual(
			huddle,
		);
	});

	it("rejects a malformed orchestrator bot user id", () => {
		for (const orchestratorBotUserId of ["", "bot-1", 123]) {
			expect(() =>
				parseAndValidateProjects([
					entry({ huddle: { ...validHuddle, orchestratorBotUserId } }),
				]),
			).toThrow(/orchestratorBotUserId/);
		}
	});

	it("rejects a malformed ears bot user id", () => {
		for (const earsBotUserId of ["", "bot-1", 123]) {
			expect(() =>
				parseAndValidateProjects([
					entry({ huddle: { ...validHuddle, earsBotUserId } }),
				]),
			).toThrow(/earsBotUserId/);
		}
	});

	it("rejects a non-object huddle", () => {
		expect(() => parseAndValidateProjects([entry({ huddle: "yes" })])).toThrow(
			/huddle/,
		);
		expect(() => parseAndValidateProjects([entry({ huddle: [1] })])).toThrow(
			/huddle/,
		);
	});

	for (const field of [
		"guildId",
		"voiceChannelId",
		"orchestratorBotTokenEnv",
		"earsBotTokenEnv",
	]) {
		it(`rejects a huddle block missing required ${field}`, () => {
			const bad: Record<string, unknown> = { ...validHuddle };
			delete bad[field];
			expect(() => parseAndValidateProjects([entry({ huddle: bad })])).toThrow(
				new RegExp(field),
			);
		});
		it(`rejects a huddle block with empty ${field}`, () => {
			expect(() =>
				parseAndValidateProjects([
					entry({ huddle: { ...validHuddle, [field]: "" } }),
				]),
			).toThrow(new RegExp(field));
		});
	}

	it("rejects a commandName outside the slash-command grammar", () => {
		for (const bad of ["", "has space", "UPPER", "x".repeat(33), 42]) {
			expect(() =>
				parseAndValidateProjects([
					entry({ huddle: { ...validHuddle, commandName: bad } }),
				]),
			).toThrow(/commandName/);
		}
		expect(() =>
			parseAndValidateProjects([
				entry({ huddle: { ...validHuddle, commandName: "meet" } }),
			]),
		).not.toThrow();
	});

	it("rejects a non-boolean moveMembers", () => {
		expect(() =>
			parseAndValidateProjects([
				entry({ huddle: { ...validHuddle, moveMembers: "yes" } }),
			]),
		).toThrow(/moveMembers/);
		expect(() =>
			parseAndValidateProjects([
				entry({ huddle: { ...validHuddle, moveMembers: false } }),
			]),
		).not.toThrow();
	});

	it("tolerates unknown keys inside huddle (loose-validation principle)", () => {
		expect(() =>
			parseAndValidateProjects([
				entry({ huddle: { ...validHuddle, futureKnob: 1 } }),
			]),
		).not.toThrow();
	});
});
