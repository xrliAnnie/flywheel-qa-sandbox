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
