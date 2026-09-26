/**
 * FLY-545 P2 — ProjectConfig validation for the optional per-lead `voice`
 * (edge-tts voice id, FLY-546-approved key) and the `huddle` block, which
 * FLY-2860 retired to a legacy conflict marker (no field validation).
 *
 * Contract: absent block/field = byte-compat (nothing normalized in);
 * a present voice is type-checked fail-loud at the config boundary.
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

describe("ProjectEntry.huddle (FLY-2860 retired legacy marker)", () => {
	it("accepts an absent huddle block (byte-compat) without normalizing one in", () => {
		const projects = parseAndValidateProjects([entry()]);
		expect("huddle" in projects[0]!).toBe(false);
	});

	it("treats huddle: null as no-huddle (deployed-roster null tolerance)", () => {
		expect(() =>
			parseAndValidateProjects([entry({ huddle: null })]),
		).not.toThrow();
	});

	// The legacy /glaw daemon that consumed these fields is gone. A leftover
	// block must never break the whole roster load; it is kept verbatim so the
	// voice admission guards (Bridge preflight/services/start, voice-codex)
	// keep refusing that project with legacy_voice_conflict.
	it.each([
		["a formerly valid block", validHuddle],
		["missing required fields", { guildId: "g-1" }],
		["empty fields", { ...validHuddle, earsBotTokenEnv: "" }],
		[
			"an out-of-grammar command name",
			{ ...validHuddle, commandName: "UPPER" },
		],
		["a non-boolean moveMembers", { ...validHuddle, moveMembers: "yes" }],
		[
			"a malformed bot user id",
			{ ...validHuddle, orchestratorBotUserId: "bot-1" },
		],
		["a non-object value", "yes"],
		["an array", [1]],
	])("loads a leftover huddle block with %s verbatim", (_label, huddle) => {
		const projects = parseAndValidateProjects([entry({ huddle })]);
		expect(projects[0]!.huddle).toEqual(huddle);
	});
});
